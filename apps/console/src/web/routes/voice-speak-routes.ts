/**
 * @fileoverview A room member's own server voice: car mode speaks each reply in the voice
 * cast for that member, made by a local Kokoro text to speech service.
 *
 * Endpoints:
 * - `POST /api/voice/speak` `{ room, member, text }`: synthesize `text` in the voice cast
 *   for that member (looked up by the member's name). Answers
 *   `{ audioUrl, engine: 'kokoro' | 'piper' }`; play `audioUrl` from the same origin.
 * - `GET /api/voice/speech/:id`: that audio, range-aware, for a few minutes.
 *
 * Kokoro is `REVERIE_KOKORO_URL` (default `http://127.0.0.1:8091`), an operator-run local
 * process that owns the cast (name -> voice). If it fails, the voice service's Piper
 * (`REVERIE_VOICE_TURN_URL`, its `/tts?raw=1`) speaks instead; if both fail the route
 * answers 502 and the page uses the phone's own voice.
 *
 * ⚠️ The text is the page's to choose (it speaks what it shows), so the route only checks
 * that the caller may see the room and that the member is in it, and caps the length.
 * ⚠️ Audio ids are random and remembered with the user who asked; another user's id is a 404.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { ChatroomService } from '../../chatroom-service.js';
import { canAccessOwned, getAuthUser, parseBody } from '../route-helpers.js';
import { parseByteRange } from '../http-range.js';
import { voiceServiceUrl } from './voice-turn-routes.js';

/** One utterance: car mode speaks a reply sentence by sentence (at most 220 characters each). */
export const MAX_SPEAK_CHARS = 600;
export const MAX_SPEECH_BYTES = 8 * 1024 * 1024;
/** Kokoro makes about four seconds of speech per second on the CPU; a long line, queued, fits. */
export const SPEAK_TIMEOUT_MS = 20_000;
/** How long a made line can be fetched, and how many are kept. */
export const SPEECH_TTL_MS = 10 * 60_000;
const MAX_SPEECH_KEPT = 32;
const SPEECH_ID = /^[a-f0-9]{32}$/;

const SpeakSchema = z
  .object({
    room: z.string().min(1).max(200),
    member: z.string().min(1).max(200),
    text: z.string().max(MAX_SPEAK_CHARS),
  })
  .strict();

export function kokoroUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.REVERIE_KOKORO_URL?.trim() || 'http://127.0.0.1:8091').replace(/\/+$/, '');
}

/** Pure: the name the cast knows a member by ("Workspace: Worker" -> "Worker"). */
export function castName(name: string): string {
  return String(name || '')
    .split(': ')
    .pop()!
    .trim();
}

export interface VoiceSpeakDeps {
  kokoroUrl?: () => string;
  piperUrl?: () => string;
  now?: () => number;
}

function fail(reply: FastifyReply, status: number, code: ApiErrorCode, message: string): FastifyReply {
  return reply.code(status).send(createErrorResponse(code, message));
}

/** POST JSON, expect audio/wav back within the timeout and size cap; null on any failure. */
async function fetchWav(url: string, body: unknown): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
    });
    if (!res.ok || !/^audio\/(wav|x-wav)/i.test(res.headers.get('content-type') || '')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= MAX_SPEECH_BYTES ? buf : null;
  } catch {
    return null;
  }
}

export function registerVoiceSpeakRoutes(
  app: FastifyInstance,
  chatrooms: ChatroomService,
  deps: VoiceSpeakDeps = {}
): void {
  const kokoro = deps.kokoroUrl ?? (() => kokoroUrl());
  const piper = deps.piperUrl ?? (() => voiceServiceUrl());
  const now = deps.now ?? Date.now;
  const kept = new Map<string, { user: string; body: Buffer; at: number }>();

  const sweep = () => {
    const t = now();
    for (const [id, s] of kept) if (t - s.at > SPEECH_TTL_MS) kept.delete(id);
    while (kept.size > MAX_SPEECH_KEPT) kept.delete(kept.keys().next().value as string);
  };

  app.post('/api/voice/speak', async (req: FastifyRequest, reply) => {
    const { room: roomId, member, text } = parseBody(SpeakSchema, req.body);
    const spoken = text.replace(/\s+/g, ' ').trim();
    if (!spoken) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'Nothing to say');
    const user = getAuthUser(req);
    const room = chatrooms.room(roomId);
    if (!room || !canAccessOwned(user, room.owner)) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'No such chatroom');
    if (!room.members.some((m) => m.sessionId === member)) {
      return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'That session is not in this room');
    }
    let engine: 'kokoro' | 'piper' = 'kokoro';
    let body = await fetchWav(`${kokoro()}/tts`, { text: spoken, speaker: castName(chatrooms.nameOf(member)) });
    if (!body) {
      engine = 'piper';
      body = await fetchWav(`${piper()}/tts?raw=1`, { text: spoken });
    }
    if (!body) return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'No server voice is running');
    sweep();
    const id = randomBytes(16).toString('hex');
    kept.set(id, { user: user.username, body, at: now() });
    sweep();
    return { success: true, data: { audioUrl: `/api/voice/speech/${id}`, engine } };
  });

  app.get('/api/voice/speech/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SPEECH_ID.test(id)) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'Bad audio id');
    sweep();
    const s = kept.get(id);
    if (!s || s.user !== getAuthUser(req).username) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'No such audio');
    reply
      .header('Content-Type', 'audio/wav')
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, max-age=600');
    const range = parseByteRange(req.headers.range, s.body.length);
    if (range.kind === 'unsatisfiable') {
      return reply.code(416).header('Content-Range', `bytes */${s.body.length}`).send();
    }
    if (range.kind === 'partial') {
      return reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${s.body.length}`)
        .send(s.body.subarray(range.start, range.end + 1));
    }
    return reply.send(s.body);
  });
}
