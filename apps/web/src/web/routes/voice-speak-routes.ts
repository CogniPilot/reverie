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
import { EmployeeVoiceSchema, type EmployeeVoice } from '../../employee-voice.js';

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
  employeeVoice?: (sessionId: string) => EmployeeVoice | undefined;
}

export interface VoiceOption extends EmployeeVoice {
  label: string;
  language: string;
  gender?: string;
}

/** Only advertise voices a reachable service reports, never trigger model downloads. */
async function installedVoices(base: string, provider: 'piper' | 'kokoro'): Promise<VoiceOption[]> {
  try {
    const response = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    const values = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && 'voices' in payload
        ? payload.voices
        : [];
    if (!Array.isArray(values)) return [];
    const result: VoiceOption[] = [];
    for (const value of values.slice(0, 512)) {
      const item = typeof value === 'string' ? { id: value } : value;
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const parsed = EmployeeVoiceSchema.safeParse({ provider, id: record.id ?? record.name });
      if (!parsed.success) continue;
      result.push({
        ...parsed.data,
        label: typeof record.label === 'string' ? record.label.slice(0, 100) : parsed.data.id,
        language: typeof record.language === 'string' ? record.language.slice(0, 40) : '',
        ...(typeof record.gender === 'string' ? { gender: record.gender.slice(0, 30) } : {}),
      });
    }
    return result;
  } catch {
    return [];
  }
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
  const options = async () =>
    (await Promise.all([installedVoices(kokoro(), 'kokoro'), installedVoices(piper(), 'piper')])).flat();

  const sweep = () => {
    const t = now();
    for (const [id, s] of kept) if (t - s.at > SPEECH_TTL_MS) kept.delete(id);
    while (kept.size > MAX_SPEECH_KEPT) kept.delete(kept.keys().next().value as string);
  };

  const audio = (user: string, body: Buffer, engine: 'kokoro' | 'piper') => {
    sweep();
    const id = randomBytes(16).toString('hex');
    kept.set(id, { user, body, at: now() });
    sweep();
    return { success: true, data: { audioUrl: `/api/voice/speech/${id}`, engine } };
  };
  const browser = (voice: EmployeeVoice) => ({
    success: true,
    data: { engine: 'browser', fallback: 'browser', voice },
  });
  const selectedAudio = async (voice: EmployeeVoice, text: string): Promise<Buffer | null> => {
    if (voice.provider === 'browser') return null;
    const base = voice.provider === 'kokoro' ? kokoro() : piper();
    const voices = await installedVoices(base, voice.provider);
    if (!voices.some((v) => v.id === voice.id)) return null;
    return fetchWav(`${base}/tts${voice.provider === 'piper' ? '?raw=1' : ''}`, { text, voice: voice.id });
  };

  app.get('/api/voice/options', async () => ({ success: true, data: { voices: await options() } }));
  app.post('/api/voice/preview', async (req, reply) => {
    const { voice } = parseBody(z.object({ voice: EmployeeVoiceSchema }).strict(), req.body);
    if (voice.provider === 'browser') return browser(voice);
    const body = await selectedAudio(voice, 'Hello. This is my speaking voice.');
    if (!body) return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'That voice is not available');
    return audio(getAuthUser(req).username, body, voice.provider);
  });

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
    const selected = deps.employeeVoice?.(member);
    if (selected?.provider === 'browser') return browser(selected);
    if (selected) {
      const body = await selectedAudio(selected, spoken);
      if (!body) return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'The selected voice is not available');
      return audio(user.username, body, selected.provider as 'kokoro' | 'piper');
    }
    let engine: 'kokoro' | 'piper' = 'kokoro';
    let body = await fetchWav(`${kokoro()}/tts`, { text: spoken, speaker: castName(chatrooms.nameOf(member)) });
    if (!body) {
      engine = 'piper';
      body = await fetchWav(`${piper()}/tts?raw=1`, { text: spoken });
    }
    if (!body) return fail(reply, 502, ApiErrorCode.OPERATION_FAILED, 'No server voice is running');
    return audio(user.username, body, engine);
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
