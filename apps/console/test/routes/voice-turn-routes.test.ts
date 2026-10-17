/**
 * Spoken chat turns: the dashboard relays a recording to the local voice service,
 * posts transcript and reply to the room without typing them into a pane, and
 * proxies only the reply audio the service names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { registerVoiceTurnRoutes, voiceServiceUrl } from '../../src/web/routes/voice-turn-routes.js';

const VOICE = 'eeeeeeee-0000-4000-8000-000000000005';

interface Seen {
  method?: string;
  url?: string;
  type?: string;
  room?: string;
  bytes?: number;
}

describe('voice turn routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let upstream: http.Server;
  let base: string;
  let roomId: string;
  let answer: { status: number; body: unknown; type?: string };
  const seen: Seen[] = [];
  let diagDir: string;

  beforeEach(async () => {
    seen.length = 0;
    diagDir = mkdtempSync(join(tmpdir(), 'voice-diag-'));
    answer = {
      status: 200,
      body: { transcript: 'what time is it', reply: 'Time to ship, Pat.', audio_url: '/audio/r1.mp3' },
    };
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          type: req.headers['content-type'],
          room: req.headers['x-codeman-room'] as string | undefined,
          bytes: Buffer.concat(chunks).length,
        });
        if (req.url === '/stt') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ transcript: ' build status please ', duration_ms: 1200, stt_ms: 400 }));
          return;
        }
        if (req.url === '/audio/r1.mp3') {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(Buffer.from('ID3fakeaudio'));
          return;
        }
        res.writeHead(answer.status, { 'Content-Type': answer.type ?? 'application/json' });
        res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file: join(mkdtempSync(join(tmpdir(), 'voice-')), 'chatrooms.json'),
        getSession: (id) => c.sessions.get(id),
        broadcast: () => {},
      });
      registerVoiceTurnRoutes(fastify, service, { serviceUrl: () => base, diagDir: () => diagDir });
    });
    app = harness.app;
    ctx = harness.ctx;
    const voiceMember = createMockSession(VOICE);
    voiceMember.name = 'assistant';
    ctx.sessions.set(VOICE, voiceMember as never);
    roomId = service.createRoom('Fleet', undefined).id;
    service.addMember(roomId, VOICE, { voice: true });
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
    await new Promise((r) => upstream.close(r));
  });

  const turn = (opts: { room?: string; member?: string; type?: string; body?: Buffer } = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/voice/turn?room=${opts.room ?? roomId}&member=${opts.member ?? VOICE}`,
      headers: { 'content-type': opts.type ?? 'audio/webm;codecs=opus' },
      payload: opts.body ?? Buffer.from('fake-webm-bytes'),
    });

  it('relays the recording and posts transcript and reply without typing them into the pane', async () => {
    const res = await turn();
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({
      transcript: 'what time is it',
      reply: 'Time to ship, Pat.',
      audioUrl: '/api/voice/audio/r1.mp3',
    });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/turn',
      type: 'audio/webm;codecs=opus',
      room: roomId,
      bytes: 15,
    });

    const messages = service.view(service.room(roomId)!).messages.filter((m) => m.from.kind !== 'system');
    expect(messages.map((m) => [m.from.kind, m.text, m.to])).toEqual([
      ['user', 'what time is it', [VOICE]],
      ['agent', 'Time to ship, Pat.', ['user']],
    ]);
    expect(messages[1].audioUrl).toBe('/api/voice/audio/r1.mp3');
    expect(messages.every((m) => m.voice)).toBe(true);
    // Nothing queued for the voice member's pane beyond its join briefing.
    await service.delivery.flushAll();
    const typed = (ctx.sessions.get(VOICE) as unknown as { writeBuffer: string[] }).writeBuffer.join('');
    expect(typed).not.toContain('what time is it');
  });

  it('treats 204 as nothing heard and 503 as no reply', async () => {
    answer = { status: 204, body: '' };
    let res = await turn();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ heard: false, messages: [] });
    answer = { status: 503, body: '' };
    res = await turn();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('no reply');
    // A 503 that carries the transcript keeps the user's words in the room.
    answer = { status: 503, body: { transcript: 'are you there', reply: null, error: 'the assistant gave no reply' } };
    res = await turn();
    expect(res.json().error).toContain('the assistant gave no reply');
    const texts = service.view(service.room(roomId)!).messages.map((m) => m.text);
    expect(texts).toContain('are you there');
  });

  it('accepts the .wav ids the voice service mints', async () => {
    answer.body = { id: 'a1', transcript: 'hi', reply: 'hey', audio_url: '/audio/a1.wav', timings: { total_ms: 900 } };
    expect((await turn()).json().data.audioUrl).toBe('/api/voice/audio/a1.wav');
  });

  it('accepts iPhone Safari mp4 recordings', async () => {
    expect((await turn({ type: 'audio/mp4' })).statusCode).toBe(200);
    expect(seen[0].type).toBe('audio/mp4');
  });

  it('proxies only the audio the service names', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/voice/audio/r1.mp3' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/mpeg');
    expect(ok.body).toBe('ID3fakeaudio');
    const traversal = await app.inject({ method: 'GET', url: '/api/voice/audio/..%2Fturn' });
    expect(traversal.statusCode).toBe(400);
    // The fake answers any other path with JSON: anything that is not audio is refused.
    const notAudio = await app.inject({ method: 'GET', url: '/api/voice/audio/other' });
    expect(notAudio.statusCode).toBe(502);
  });

  it('serves reply audio range-aware and whole, from one upstream fetch', async () => {
    const whole = await app.inject({ method: 'GET', url: '/api/voice/audio/r1.mp3' });
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe('12');
    const part = await app.inject({ method: 'GET', url: '/api/voice/audio/r1.mp3', headers: { range: 'bytes=3-6' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 3-6/12');
    expect(part.body).toBe('fake');
    const tail = await app.inject({ method: 'GET', url: '/api/voice/audio/r1.mp3', headers: { range: 'bytes=3-' } });
    expect(tail.body).toBe('fakeaudio');
    const bad = await app.inject({ method: 'GET', url: '/api/voice/audio/r1.mp3', headers: { range: 'bytes=50-60' } });
    expect(bad.statusCode).toBe(416);
    expect(seen.filter((s) => s.url === '/audio/r1.mp3')).toHaveLength(1);
  });

  it('drops an audio_url that is not an /audio/<id> path', async () => {
    answer.body = { transcript: 'hi', reply: 'hello', audio_url: 'http://evil.example/x.mp3' };
    const res = await turn();
    expect(res.json().data.audioUrl).toBeNull();
  });

  it('refuses a member that is not marked as the voice, whatever its name', async () => {
    const OTHER = 'dddddddd-0000-4000-8000-000000000004';
    const worker = createMockSession(OTHER);
    worker.name = 'assistant: memory + learning persona';
    ctx.sessions.set(OTHER, worker as never);
    service.addMember(roomId, OTHER);
    const res = await turn({ member: OTHER });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not set up for voice');
    expect(seen).toHaveLength(0);
  });

  it('refuses a wrong room, a non-member, an empty body and a non-audio body', async () => {
    expect((await turn({ room: 'nope' })).statusCode).toBe(404);
    expect((await turn({ member: 'ffffffff-0000-4000-8000-000000000006' })).statusCode).toBe(400);
    expect((await turn({ body: Buffer.alloc(0) })).statusCode).toBe(400);
    expect((await turn({ type: 'application/json', body: Buffer.from('{}') })).statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('reports a voice service that is down, failing, or answering nonsense', async () => {
    answer = { status: 500, body: { error: 'whisper crashed' } };
    let res = await turn();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('whisper crashed');
    answer = { status: 200, body: { nope: true } };
    expect((await turn()).statusCode).toBe(502);
    await new Promise((r) => upstream.close(r));
    upstream = http.createServer();
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:1';
    res = await turn();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('not running');
  });

  it('defaults to the local service and honours CODEMAN_VOICE_TURN_URL', () => {
    expect(voiceServiceUrl({})).toBe('http://127.0.0.1:8090');
    expect(voiceServiceUrl({ CODEMAN_VOICE_TURN_URL: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
  });

  it('stores uploaded diagnostics privately and names the file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/diag',
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/131' },
      payload: { meta: { buildId: 'abc' }, lines: ['00.000 audio play', '00.512 audio pause'] },
    });
    expect(res.statusCode).toBe(200);
    const { file } = res.json().data;
    expect(file).toMatch(/^diag-.*\.json$/);
    expect(readdirSync(diagDir)).toEqual([file]);
    expect(statSync(join(diagDir, file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(join(diagDir, file), 'utf8'));
    expect(saved).toMatchObject({ userAgent: expect.stringContaining('Android'), meta: { buildId: 'abc' } });
    expect(saved.lines).toHaveLength(2);
    const bad = await app.inject({ method: 'POST', url: '/api/voice/diag', payload: { lines: 'nope' } });
    expect(bad.statusCode).toBe(400);
  });

  it('proxies dictation to /stt and returns only the transcript, posting nothing', async () => {
    const before = service.view(service.room(roomId)!).messages.length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { 'content-type': 'audio/mp4' },
      payload: Buffer.from('fake-mp4'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ transcript: 'build status please' });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/stt', type: 'audio/mp4', bytes: 8 });
    expect(service.view(service.room(roomId)!).messages.length).toBe(before);
    const empty = await app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { 'content-type': 'audio/mp4' },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBe(400);
  });
});
