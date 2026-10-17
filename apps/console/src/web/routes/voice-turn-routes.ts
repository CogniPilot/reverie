/**
 * @fileoverview Spoken chat turns: the chat panel's push-to-talk, relayed to a local
 * voice service (speech to text, the agent's answer, text to speech).
 *
 * Endpoints:
 * - `POST /api/voice/turn?room=<roomId>&member=<sessionId>`: body is the raw
 *   recording (`audio/webm` or `audio/mp4`, at most 10 MB). Forwarded to
 *   `<voice service>/turn`; the transcript is posted to the room as the user to that
 *   member, the reply as that member to the user. Answers
 *   `{ transcript, reply, audioUrl, messages }`.
 * - `GET /api/voice/audio/:id`: the reply audio, proxied from `<voice service>/audio/<id>`.
 *
 * The voice service is `CODEMAN_VOICE_TURN_URL` (default `http://127.0.0.1:8090`), an
 * operator-configured local process; the browser never talks to it directly, so a
 * phone that reaches the dashboard through Tailscale serve needs nothing else.
 *
 * ⚠️ Both messages are posted with `deliver: false`: the service already produced the
 * member's answer, and typing the transcript into the member's pane would make it
 * answer a second time.
 * ⚠️ Only `/audio/<id>` paths the service names are ever proxied; the id is checked
 * against a strict pattern, so the route cannot be pointed at another upstream path.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { ChatroomService } from '../../chatroom-service.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { parseByteRange } from '../http-range.js';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dataPath } from '../../config/instance.js';
import { parseBody } from '../route-helpers.js';
import { NO_OWNER, ownerMark, type OwnerVerifier } from '../../owner-auth/marks.js';

/** Client voice/keyboard trace uploaded from a phone, for diagnosing what only a real device shows. */
const VoiceDiagSchema = z
  .object({
    meta: z.record(z.string(), z.unknown()).optional(),
    lines: z.array(z.string().max(2000)).max(400),
  })
  .strict();
const MAX_DIAG_FILES = 20;

export const MAX_VOICE_TURN_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_AUDIO_BYTES = 20 * 1024 * 1024;
/**
 * A turn waits for the chat model behind the shared GPU lock: measured live at 60 s
 * (2026-10-14), most of it queueing. Above the voice service's own worst case (its
 * model timeout is 240 s, plus speech to text and text to speech), so the dashboard
 * never gives up on a turn the service is still finishing, which would lose it.
 */
// ⚠️ Stays below 300 s: Node's fetch (undici) has its own 300 s headers timeout, which
// would fire first and read as "not running" instead of "did not answer in time".
export const VOICE_TURN_TIMEOUT_MS = 290_000;
/** Transcription alone (no model turn): whisper on a short clip takes seconds. */
export const VOICE_STT_TIMEOUT_MS = 60_000;
/** Reply audio already exists when it is fetched: a service that hangs fails this fast. */
export const VOICE_AUDIO_TIMEOUT_MS = 15_000;
const AUDIO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUDIO_PATH = /^\/audio\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/** Our own AbortSignal.timeout, or undici's headers/body timeout surfacing as "fetch failed". */
function isFetchTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { code?: string } };
  return (
    e?.name === 'TimeoutError' ||
    e?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    e?.cause?.code === 'UND_ERR_BODY_TIMEOUT'
  );
}

export function voiceServiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CODEMAN_VOICE_TURN_URL?.trim() || 'http://127.0.0.1:8090').replace(/\/+$/, '');
}

export interface VoiceTurnDeps {
  /** Base URL of the voice service; a function so tests can point it at a fake. */
  serviceUrl?: () => string;
  /** Where uploaded diagnostics go; defaults to `<data dir>/voice-diag`. */
  diagDir?: () => string;
  /** Is this request a cookie-verified owner (owner-auth/marks.ts)? Only then is the transcript marked. */
  verifiedOwner?: OwnerVerifier;
}

function fail(reply: FastifyReply, status: number, code: ApiErrorCode, message: string): FastifyReply {
  return reply.code(status).send(createErrorResponse(code, message));
}

export function registerVoiceTurnRoutes(
  app: FastifyInstance,
  chatrooms: ChatroomService,
  deps: VoiceTurnDeps = {}
): void {
  const base = deps.serviceUrl ?? (() => voiceServiceUrl());
  const verifiedOwner = deps.verifiedOwner ?? NO_OWNER;
  /** The user sender of a transcript: marked `owner_spoken` only for a verified owner. */
  const speaker = (req: FastifyRequest) => {
    const name = isMultiUserMode() ? getAuthUser(req).username : 'user';
    const mark = ownerMark(req, verifiedOwner, true);
    return { kind: 'user' as const, name, ...(mark ? { mark } : {}) };
  };

  // Encapsulated so the raw-audio body parser exists for these routes only.
  void app.register(async (scope) => {
    scope.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_VOICE_TURN_BYTES }, (_req, body, done) =>
      done(null, body)
    );

    /**
     * `POST /api/voice/stt`: dictation for browsers without SpeechRecognition. The raw
     * recording goes to the voice service's /stt and only the transcript comes back;
     * the panel then posts it as an ordinary (spoken) message to whoever it addresses.
     */
    scope.post('/api/voice/stt', async (req: FastifyRequest, reply) => {
      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'Send the recording as an audio/* body');
      }
      let upstream: Response;
      try {
        upstream = await fetch(`${base()}/stt`, {
          method: 'POST',
          headers: { 'Content-Type': String(req.headers['content-type'] || 'application/octet-stream') },
          body: new Uint8Array(audio),
          signal: AbortSignal.timeout(VOICE_STT_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = isFetchTimeout(err);
        return fail(
          reply,
          timedOut ? 504 : 502,
          ApiErrorCode.OPERATION_FAILED,
          timedOut ? 'Speech to text did not answer in time' : 'The voice service is not running'
        );
      }
      let data: { transcript?: unknown; error?: unknown } = {};
      try {
        data = (await upstream.json()) as typeof data;
      } catch {
        /* handled below */
      }
      if (!upstream.ok || typeof data.transcript !== 'string') {
        const why = typeof data.error === 'string' ? data.error.slice(0, 300) : `HTTP ${upstream.status}`;
        return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, `Speech to text: ${why}`);
      }
      return { success: true, data: { transcript: data.transcript.trim() } };
    });

    scope.post('/api/voice/turn', async (req: FastifyRequest, reply) => {
      const { room: roomId, member } = req.query as { room?: string; member?: string };
      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'Send the recording as an audio/* body');
      }
      const room = roomId ? chatrooms.room(roomId) : undefined;
      if (!room || !canAccessOwned(getAuthUser(req), room.owner)) {
        return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'No such chatroom');
      }
      const target = room.members.find((m) => m.sessionId === member);
      if (!target) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'That session is not in this room');
      if (target.voice !== true) {
        return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'That member is not set up for voice');
      }

      let upstream: Response;
      try {
        upstream = await fetch(`${base()}/turn`, {
          method: 'POST',
          headers: {
            'Content-Type': String(req.headers['content-type'] || 'application/octet-stream'),
            'X-Codeman-Room': room.id,
          },
          body: new Uint8Array(audio),
          signal: AbortSignal.timeout(VOICE_TURN_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = isFetchTimeout(err);
        return fail(
          reply,
          timedOut ? 504 : 502,
          ApiErrorCode.OPERATION_FAILED,
          timedOut ? 'The voice service did not answer in time' : 'The voice service is not running'
        );
      }
      // 204: nothing intelligible was heard. Not an error; the panel says so.
      if (upstream.status === 204) {
        return { success: true, data: { heard: false, transcript: '', reply: '', audioUrl: null, messages: [] } };
      }
      let data: { transcript?: unknown; reply?: unknown; audio_url?: unknown; error?: unknown } = {};
      try {
        data = (await upstream.json()) as typeof data;
      } catch {
        /* handled below */
      }
      if (!upstream.ok) {
        // 503 still carries what was heard: keep the user's words in the room.
        if (upstream.status === 503 && typeof data.transcript === 'string' && data.transcript.trim()) {
          chatrooms.post(room.id, speaker(req), data.transcript, [target.sessionId], {
            deliver: false,
            voice: true,
          });
        }
        if (upstream.status === 413) {
          return fail(reply, 413, ApiErrorCode.INVALID_INPUT, 'Recording too long for the voice service');
        }
        const why =
          typeof data.error === 'string'
            ? data.error.slice(0, 300)
            : upstream.status === 503
              ? 'no reply this time'
              : `HTTP ${upstream.status}`;
        return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, `Voice service: ${why}`);
      }
      if (typeof data.transcript !== 'string' || typeof data.reply !== 'string') {
        return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'Voice service answered without transcript and reply');
      }
      const audioId = typeof data.audio_url === 'string' ? AUDIO_PATH.exec(data.audio_url)?.[1] : undefined;
      const audioUrl = audioId ? `/api/voice/audio/${audioId}` : undefined;

      const messages = [];
      if (data.transcript.trim()) {
        messages.push(
          chatrooms.post(room.id, speaker(req), data.transcript, [target.sessionId], {
            deliver: false,
            voice: true,
          })
        );
      }
      if (data.reply.trim()) {
        messages.push(
          chatrooms.post(
            room.id,
            { kind: 'agent', sessionId: target.sessionId, name: chatrooms.nameOf(target.sessionId) },
            data.reply,
            ['user'],
            { deliver: false, voice: true, ...(audioUrl ? { audioUrl } : {}) }
          )
        );
      }
      return {
        success: true,
        data: { heard: true, transcript: data.transcript, reply: data.reply, audioUrl: audioUrl ?? null, messages },
      };
    });
  });

  /**
   * `POST /api/voice/diag`: the chat panel's "Send diagnostics" button uploads its last
   * few hundred client events (viewport and keyboard readings, every audio and speech
   * event, car-mode state changes). Stored 0600 under the data dir, newest 20 kept;
   * the answer names the file so the user can say which one.
   */
  app.post('/api/voice/diag', async (req) => {
    const body = parseBody(VoiceDiagSchema, req.body);
    const dir = deps.diagDir?.() ?? dataPath('voice-diag');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `diag-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
    const record = {
      receivedAt: new Date().toISOString(),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
      // One operator folder holds every user's traces: name the uploader in multi-user mode.
      ...(isMultiUserMode() ? { user: getAuthUser(req).username } : {}),
      meta: body.meta ?? {},
      lines: body.lines,
    };
    await fs.writeFile(join(dir, name), JSON.stringify(record, null, 1), { mode: 0o600 });
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('diag-')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_DIAG_FILES))) {
      await fs.rm(join(dir, old), { force: true });
    }
    return { success: true, data: { file: name, lines: body.lines.length } };
  });

  // The last few replies, so a media element's several Range requests for one file
  // cost one fetch from the voice service. Ids are minted once per reply.
  const recent = new Map<string, { type: string; body: Buffer }>();
  const RECENT_AUDIO = 8;

  app.get('/api/voice/audio/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!AUDIO_ID.test(id)) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'Bad audio id');
    let audio = recent.get(id);
    if (!audio) {
      let upstream: Response;
      try {
        upstream = await fetch(`${base()}/audio/${id}`, { signal: AbortSignal.timeout(VOICE_AUDIO_TIMEOUT_MS) });
      } catch {
        return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'The voice service is not running');
      }
      if (!upstream.ok) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'No such audio');
      const type = upstream.headers.get('content-type') || '';
      if (!/^audio\//i.test(type))
        return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'Voice service sent no audio');
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > MAX_VOICE_AUDIO_BYTES)
        return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'Audio too large');
      audio = { type, body };
      recent.set(id, audio);
      while (recent.size > RECENT_AUDIO) recent.delete(recent.keys().next().value as string);
    }
    // Range-aware like the file routes (http-range.ts): Safari will not start media from a
    // server that ignores Range, and Chrome's player can stop or misjudge the length.
    reply
      .header('Content-Type', audio.type)
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, max-age=3600');
    const range = parseByteRange(req.headers.range, audio.body.length);
    if (range.kind === 'unsatisfiable') {
      return reply.code(416).header('Content-Range', `bytes */${audio.body.length}`).send();
    }
    if (range.kind === 'partial') {
      return reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${audio.body.length}`)
        .send(audio.body.subarray(range.start, range.end + 1));
    }
    return reply.send(audio.body);
  });
}
