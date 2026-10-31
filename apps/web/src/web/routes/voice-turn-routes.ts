/**
 * @fileoverview Spoken chat turns: the chat panel's push-to-talk, relayed to a local
 * voice service (speech to text, the agent's answer, text to speech).
 *
 * Endpoints:
 * - `POST /api/voice/turn?room=<roomId>&member=<sessionId>`: body is the raw
 *   recording (`audio/webm` or `audio/mp4`, at most 10 MB). Transcribed by
 *   `<voice service>/stt` and posted to the room as the user's spoken message to that
 *   member, delivered like any message; the member's post in that room whose replyTo
 *   is that transcript (`reverie agent chat say --reply-to <id>`) is read aloud by
 *   `<voice service>/tts`. No linked answer means no reply and nothing spoken. Answers
 *   `{ heard, transcript, reply, audioUrl, messages }`.
 * - `GET /api/voice/audio/:id`: the reply audio, proxied from `<voice service>/audio/<id>`.
 *
 * The voice service is `REVERIE_VOICE_TURN_URL` (default `http://127.0.0.1:8090`), an
 * operator-configured local process; the browser never talks to it directly, so a
 * phone that reaches the dashboard through Tailscale serve needs nothing else.
 *
 * ⚠️ The answer comes from the member itself, through the room, for any kind of member
 * (a typed pane, a polling loop): the voice service is never asked to answer, so no
 * session it remembers can answer in the member's place.
 * ⚠️ Only `/audio/<id>` paths the service names are ever proxied; the id is checked
 * against a strict pattern, so the route cannot be pointed at another upstream path.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { ChatroomService } from '../../chatroom-service.js';
import type { ChatMessage } from '../../chatroom-store.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { parseByteRange } from '../http-range.js';
import { randomBytes, randomUUID } from 'node:crypto';
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
 * How long a spoken turn waits for the member's answer in the room. Nothing is lost
 * when it gives up: the transcript is already posted and the answer lands in the room.
 */
// ⚠️ Keep the whole turn (speech to text + this + text to speech) under the 300 s at
// which proxies and browsers commonly drop an idle request.
export const VOICE_REPLY_WAIT_MS = 210_000;
/** Text to speech of one answer. */
export const VOICE_TTS_TIMEOUT_MS = 30_000;
/** Transcription alone (no model turn): whisper on a short clip takes seconds. */
export const VOICE_STT_TIMEOUT_MS = 60_000;
/** Reply audio already exists when it is fetched: a service that hangs fails this fast. */
export const VOICE_AUDIO_TIMEOUT_MS = 15_000;
const AUDIO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUDIO_PATH = /^\/audio\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
/** The phone's id for one spoken turn (X-Reverie-Voice-Turn), from the press to the reply's playback. */
const VOICE_TURN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

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
  return (env.REVERIE_VOICE_TURN_URL?.trim() || 'http://127.0.0.1:8090').replace(/\/+$/, '');
}

/** Diagnostic address only: never expose endpoint credentials, paths or query strings. */
export function voiceServiceLabel(base: string): string {
  try {
    const url = new URL(base);
    return `Whisper/Piper speech service at ${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return 'Whisper/Piper speech service at the configured endpoint';
  }
}

/** Health is small and bounded; this must never download models or transcribe a take. */
async function voiceHealth(response: Response): Promise<{ status?: unknown; stt?: unknown; tts?: unknown }> {
  if (!response.ok || !response.body) throw new Error('health unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) throw new Error('health too large');
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object') throw new Error('invalid health');
    return body;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export interface VoiceTurnDeps {
  /** Base URL of the voice service; a function so tests can point it at a fake. */
  serviceUrl?: () => string;
  /** Where uploaded diagnostics go; defaults to `<data dir>/voice-diag`. */
  diagDir?: () => string;
  /** Is this request a cookie-verified owner (owner-auth/marks.ts)? Only then is the transcript marked. */
  verifiedOwner?: OwnerVerifier;
  /** How long a turn waits for the member's answer; tests shorten it. */
  replyWaitMs?: number;
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
  const replyWaitMs = deps.replyWaitMs ?? VOICE_REPLY_WAIT_MS;
  /** Members with a spoken turn in flight (any room). */
  const waiting = new Set<string>();
  app.get('/api/voice/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const service = voiceServiceLabel(base());
    try {
      const health = await voiceHealth(
        await fetch(`${base()}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
      );
      const available = health.status === 'ok' && health.stt === 'ready' && health.tts === 'ready';
      return {
        success: true,
        data: {
          available,
          service,
          message: `${service} ${available ? 'is ready' : 'is not ready (Whisper and Piper must both be ready)'}`,
        },
      };
    } catch {
      return {
        success: true,
        data: {
          available: false,
          service,
          message: `${service} is unavailable. Start the service or use browser dictation where available.`,
        },
      };
    }
  });
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
          timedOut
            ? `${voiceServiceLabel(base())}: speech to text did not answer in time`
            : `${voiceServiceLabel(base())} could not be reached`
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
      // One spoken turn per member at a time: each waits for its own linked answer.
      if (waiting.has(target.sessionId)) {
        return fail(
          reply,
          409,
          ApiErrorCode.SESSION_BUSY,
          `Still waiting for ${chatrooms.nameOf(target.sessionId)} to answer your last spoken turn`
        );
      }
      waiting.add(target.sessionId);
      // Every stage of this turn is timed under one id, so the phone's trace and the server log line up.
      const header = req.headers['x-reverie-voice-turn'];
      const turnId = typeof header === 'string' && VOICE_TURN_ID.test(header) ? header : randomUUID();
      const timing: { sttMs?: number; answerMs?: number; ttsMs?: number } = {};
      const since = (start: number) => Math.round(performance.now() - start);
      try {
        // 1. Speech to text only: the member answers in the room, not the voice service's own model.
        let heard: Response;
        const sttStart = performance.now();
        try {
          heard = await fetch(`${base()}/stt`, {
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
            timedOut
              ? `${voiceServiceLabel(base())}: speech to text did not answer in time`
              : `${voiceServiceLabel(base())} could not be reached`
          );
        }
        let stt: { transcript?: unknown; error?: unknown } = {};
        try {
          stt = (await heard.json()) as typeof stt;
        } catch {
          /* handled below */
        }
        if (heard.status === 413) {
          return fail(reply, 413, ApiErrorCode.INVALID_INPUT, 'Recording too long for the voice service');
        }
        if (!heard.ok || typeof stt.transcript !== 'string') {
          const why = typeof stt.error === 'string' ? stt.error.slice(0, 300) : `HTTP ${heard.status}`;
          return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, `Speech to text: ${why}`);
        }
        timing.sttMs = since(sttStart);
        const transcript = stt.transcript.trim();
        // Nothing intelligible was heard. Not an error; the panel says so.
        if (!transcript) {
          return { success: true, data: { heard: false, transcript: '', reply: '', audioUrl: null, messages: [], turnId, timing } };
        }

        // 2. An ordinary spoken message to the member, delivered the way that member takes chat.
        const asked = chatrooms.post(room.id, speaker(req), transcript, [target.sessionId], { spoken: true });
        const answerStart = performance.now();

        // 3. Its answer: the member's post in this room whose replyTo is this transcript (say --reply-to <id>).
        // post() invokes room listeners synchronously. An answer can already be saved
        // before it returns, so reconcile history before subscribing for future posts.
        // The lookup and subscription have no await between them.
        const isAnswer = (message: ChatMessage) => !message.deleted && message.from.kind === 'agent' &&
          message.from.sessionId === target.sessionId && message.replyTo === asked.id;
        const savedAnswer = chatrooms.room(room.id)?.messages.find(isAnswer);
        const answer = savedAnswer ?? await new Promise<ChatMessage | null>((resolve) => {
          let stop = () => {};
          const done = (m: ChatMessage | null) => {
            stop();
            resolve(m);
          };
          const unsubscribe = chatrooms.onMessage((r, m) => {
            // Only the member's own post that names this transcript as the message it answers: nothing is guessed.
            if (r.id === room.id && isAnswer(m)) done(m);
          });
          const timer = setTimeout(() => done(null), replyWaitMs);
          // A phone that hangs up stops the wait; the answer still lands in the room.
          const gone = () => done(null);
          reply.raw.once('close', gone);
          stop = () => {
            unsubscribe();
            clearTimeout(timer);
            reply.raw.off('close', gone);
          };
        });
        timing.answerMs = since(answerStart);
        if (!answer) {
          console.log(`[voice] turn ${turnId} message ${asked.id}: no linked answer after ${timing.answerMs} ms (stt ${timing.sttMs} ms)`);
          if (reply.raw.destroyed) return reply;
          return fail(
            reply,
            504,
            ApiErrorCode.OPERATION_FAILED,
            `No reply from ${chatrooms.nameOf(target.sessionId)} yet; the answer will show in the room`
          );
        }

        // 4. Text to speech. Without audio the answer still stands: its text is in the room.
        let audioUrl: string | undefined;
        const ttsStart = performance.now();
        try {
          const spoken = await fetch(`${base()}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: answer.text }),
            signal: AbortSignal.timeout(VOICE_TTS_TIMEOUT_MS),
          });
          const tts = (await spoken.json()) as { audio_url?: unknown };
          const audioId =
            spoken.ok && typeof tts.audio_url === 'string' ? AUDIO_PATH.exec(tts.audio_url)?.[1] : undefined;
          audioUrl = audioId ? `/api/voice/audio/${audioId}` : undefined;
        } catch {
          audioUrl = undefined;
        }
        timing.ttsMs = since(ttsStart);
        // Ids and durations only: the words stay in the room.
        console.log(`[voice] turn ${turnId} message ${asked.id} answer ${answer.id}: stt ${timing.sttMs} ms, answer ${timing.answerMs} ms, tts ${timing.ttsMs} ms${audioUrl ? '' : ' (no audio)'}`);
        return {
          success: true,
          data: { heard: true, transcript, reply: answer.text, audioUrl: audioUrl ?? null, messages: [asked, answer], turnId, timing },
        };
      } finally {
        waiting.delete(target.sessionId);
      }
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
        return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, `${voiceServiceLabel(base())} could not be reached`);
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
