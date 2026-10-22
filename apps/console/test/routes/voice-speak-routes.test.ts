/**
 * A member's own server voice: the dashboard asks the local Kokoro service for a line in
 * the voice cast for that member (by exact name), falls back to the voice service's Piper,
 * and serves the result only to the user who asked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import {
  castName,
  kokoroUrl,
  MAX_SPEAK_CHARS,
  registerVoiceSpeakRoutes,
  SPEECH_TTL_MS,
} from '../../src/web/routes/voice-speak-routes.js';

const WORKER = '00000046-0058-4000-8000-000000000085';
const OUTSIDER = '00000046-0058-4000-8000-000000000086';
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40, 1)]);

interface Seen {
  url?: string;
  body?: Record<string, unknown>;
}

function fakeUpstream(seen: Seen[], answer: () => { status: number; type: string; body: Buffer | string }) {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      const a = answer();
      res.writeHead(a.status, { 'Content-Type': a.type });
      res.end(a.body);
    });
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('voice speak routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let roomDir: string;
  let roomId: string;
  let kokoro: http.Server;
  let piper: http.Server;
  let kokoroBase: string;
  let piperBase: string;
  const kokoroSeen: Seen[] = [];
  const piperSeen: Seen[] = [];
  let kokoroAnswer: { status: number; type: string; body: Buffer | string };
  let piperAnswer: { status: number; type: string; body: Buffer | string };
  let clock = 1_000_000;

  beforeEach(async () => {
    kokoroSeen.length = 0;
    piperSeen.length = 0;
    clock = 1_000_000;
    kokoroAnswer = { status: 200, type: 'audio/wav', body: WAV };
    piperAnswer = { status: 200, type: 'audio/wav', body: Buffer.from('RIFFpiper') };
    kokoro = fakeUpstream(kokoroSeen, () => kokoroAnswer);
    piper = fakeUpstream(piperSeen, () => piperAnswer);
    kokoroBase = await listen(kokoro);
    piperBase = await listen(piper);
    roomDir = mkdtempSync(join(tmpdir(), 'voice-speak-'));
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file: join(roomDir, 'chatrooms.json'),
        getSession: (id) => c.sessions.get(id),
        broadcast: () => {},
      });
      registerVoiceSpeakRoutes(fastify, service, {
        kokoroUrl: () => kokoroBase,
        piperUrl: () => piperBase,
        now: () => clock,
      });
    });
    app = harness.app;
    ctx = harness.ctx;
    const worker = createMockSession(WORKER);
    worker.name = 'Worker';
    ctx.sessions.set(WORKER, worker as never);
    const outsider = createMockSession(OUTSIDER);
    outsider.name = 'Outsider';
    ctx.sessions.set(OUTSIDER, outsider as never);
    roomId = service.createRoom('general', undefined).id;
    service.addMember(roomId, WORKER, {});
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((r) => kokoro.close(() => r()));
    await new Promise<void>((r) => piper.close(() => r()));
    rmSync(roomDir, { recursive: true, force: true });
  });

  const speak = (body: unknown) => app.inject({ method: 'POST', url: '/api/voice/speak', payload: body as object });

  it('asks Kokoro for the line by the member name and serves the audio', async () => {
    const res = await speak({ room: roomId, member: WORKER, text: '  Hello   Owner. ' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.engine).toBe('kokoro');
    expect(data.audioUrl).toMatch(/^\/api\/voice\/speech\/[a-f0-9]{32}$/);
    expect(kokoroSeen).toEqual([{ url: '/tts', body: { text: 'Hello Owner.', speaker: 'Worker' } }]);
    expect(piperSeen).toEqual([]);
    const audio = await app.inject({ method: 'GET', url: data.audioUrl });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.headers['accept-ranges']).toBe('bytes');
    expect(audio.rawPayload.equals(WAV)).toBe(true);
    const part = await app.inject({ method: 'GET', url: data.audioUrl, headers: { range: 'bytes=0-3' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.toString()).toBe('RIFF');
  });

  it('never sends the speaker anything but the exact name (prefix stripped)', () => {
    expect(castName('Worker')).toBe('Worker');
    expect(castName('Workspace: Worker')).toBe('Worker');
    expect(castName(' worker ')).toBe('worker');
    expect(castName('')).toBe('');
  });

  it('falls back to Piper when Kokoro fails, sends no speaker there', async () => {
    kokoroAnswer = { status: 500, type: 'application/json', body: '{"error":"synthesis failed"}' };
    const res = await speak({ room: roomId, member: WORKER, text: 'Hi.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.engine).toBe('piper');
    expect(piperSeen).toEqual([{ url: '/tts?raw=1', body: { text: 'Hi.' } }]);
  });

  it('treats a non-audio 200 from Kokoro as a failure', async () => {
    kokoroAnswer = { status: 200, type: 'application/json', body: '{}' };
    const res = await speak({ room: roomId, member: WORKER, text: 'Hi.' });
    expect(res.json().data.engine).toBe('piper');
  });

  it('answers 502 when no server voice works, so the page uses the phone voice', async () => {
    kokoroAnswer = { status: 500, type: 'application/json', body: '{}' };
    piperAnswer = { status: 503, type: 'application/json', body: '{}' };
    const res = await speak({ room: roomId, member: WORKER, text: 'Hi.' });
    expect(res.statusCode).toBe(502);
  });

  it('answers 502 when both services are down', async () => {
    kokoroBase = 'http://127.0.0.1:1';
    piperBase = 'http://127.0.0.1:1';
    const res = await speak({ room: roomId, member: WORKER, text: 'Hi.' });
    expect(res.statusCode).toBe(502);
  });

  it('refuses a member who is not in the room, an unknown room, empty and over-long text, extra fields', async () => {
    expect((await speak({ room: roomId, member: OUTSIDER, text: 'Hi.' })).statusCode).toBe(400);
    expect((await speak({ room: 'nope', member: WORKER, text: 'Hi.' })).statusCode).toBe(404);
    expect((await speak({ room: roomId, member: WORKER, text: '   ' })).statusCode).toBe(400);
    expect((await speak({ room: roomId, member: WORKER, text: 'x'.repeat(MAX_SPEAK_CHARS + 1) })).statusCode).toBe(400);
    expect((await speak({ room: roomId, member: WORKER, text: 'Hi.', voice: 'af_heart' })).statusCode).toBe(400);
    expect(kokoroSeen).toEqual([]);
  });

  it('serves an id only while it is fresh, and refuses malformed ids', async () => {
    const url = (await speak({ room: roomId, member: WORKER, text: 'Hi.' })).json().data.audioUrl;
    expect((await app.inject({ method: 'GET', url: '/api/voice/speech/../../etc' })).statusCode).not.toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/voice/speech/ABC' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/voice/speech/' + 'a'.repeat(32) })).statusCode).toBe(404);
    clock += SPEECH_TTL_MS + 1;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('keeps at most 32 lines', async () => {
    const first = (await speak({ room: roomId, member: WORKER, text: 'Line 0.' })).json().data.audioUrl;
    for (let i = 1; i <= 32; i++) await speak({ room: roomId, member: WORKER, text: `Line ${i}.` });
    expect((await app.inject({ method: 'GET', url: first })).statusCode).toBe(404);
  });

  it('reads the Kokoro URL from the environment', () => {
    expect(kokoroUrl({})).toBe('http://127.0.0.1:8091');
    expect(kokoroUrl({ REVERIE_KOKORO_URL: ' http://k:9/ ' })).toBe('http://k:9');
  });
});
