/**
 * Spoken chat turns: the dashboard transcribes a recording with the local voice service,
 * posts it to the room as the user's spoken message to the voice member (delivered like
 * any message), waits for that member's post whose replyTo is the transcript and reads it
 * aloud with the service's text to speech. Nothing is guessed: no linked answer means no
 * reply and nothing spoken. One turn per member at a time. The service's own model (/turn)
 * is never asked. Only the reply audio the service names is proxied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import type { ChatMessage } from '../../src/chatroom-store.js';
import { registerVoiceTurnRoutes, voiceServiceUrl } from '../../src/web/routes/voice-turn-routes.js';
import { STOCK_CLIS } from '../../src/config/cli-registry/stock.js';
import { registryFilePath, reloadCliRegistry } from '../../src/config/cli-registry/registry.js';

const VOICE = '00000046-0058-4000-8000-000000000084';
const OTHER = '00000043-0053-4000-8000-00000000007a';
const POLLER = '00000038-0043-4000-8000-000000000060';

interface Seen {
  method?: string;
  url?: string;
  type?: string;
  room?: string;
  bytes?: number;
  json?: unknown;
}

/** A custom CLI that reads chat through the API (polling-lead.test.ts): post-only, never typed into. */
function registerPoller(): void {
  const base = structuredClone(STOCK_CLIS.find((e) => e.id === 'pi')!);
  const entry = {
    ...base,
    id: 'poll-agent',
    stock: false,
    acceptsChat: false,
    capabilities: { ...base.capabilities, chatDelivery: 'poll' },
  };
  mkdirSync(dirname(registryFilePath()), { recursive: true });
  writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, clis: { 'poll-agent': entry } }), {
    mode: 0o600,
  });
  reloadCliRegistry();
}

describe('voice turn routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let upstream: http.Server;
  let base: string;
  let roomId: string;
  let heard: { status: number; body: unknown; type?: string };
  let spoken: { status: number; body: unknown; type?: string };
  let owner: boolean;
  let clock: number;
  const seen: Seen[] = [];
  let diagDir: string;
  let roomDir: string;

  beforeEach(async () => {
    seen.length = 0;
    owner = false;
    clock = 1_000_000;
    diagDir = mkdtempSync(join(tmpdir(), 'voice-diag-'));
    roomDir = mkdtempSync(join(tmpdir(), 'voice-'));
    heard = { status: 200, body: { transcript: ' what time is it ', duration_ms: 1200, stt_ms: 400 } };
    spoken = { status: 200, body: { id: 'r1', audio_url: '/audio/r1.mp3', tts_ms: 300 } };
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        seen.push({
          method: req.method,
          url: req.url,
          type: req.headers['content-type'],
          room: req.headers['x-reverie-room'] as string | undefined,
          bytes: raw.length,
          ...(req.url === '/tts' ? { json: JSON.parse(raw.toString('utf8') || 'null') } : {}),
        });
        const send = (a: { status: number; body: unknown; type?: string }) => {
          res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/json' });
          res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
        };
        if (req.url === '/stt') return send(heard);
        if (req.url === '/tts') return send(spoken);
        if (req.url === '/audio/r1.mp3') {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(Buffer.from('ID3fakeaudio'));
          return;
        }
        // Anything else, /turn included, is something the dashboard must not ask for.
        send({ status: 200, body: { transcript: 'from /turn', reply: 'the service answered itself' } });
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file: join(roomDir, 'chatrooms.json'),
        getSession: (id) => c.sessions.get(id),
        broadcast: () => {},
        now: () => clock,
      });
      registerVoiceTurnRoutes(fastify, service, {
        serviceUrl: () => base,
        diagDir: () => diagDir,
        verifiedOwner: () => owner,
        replyWaitMs: 400,
      });
    });
    app = harness.app;
    ctx = harness.ctx;
    const voiceMember = createMockSession(VOICE);
    voiceMember.name = 'assistant';
    ctx.sessions.set(VOICE, voiceMember as never);
    const other = createMockSession(OTHER);
    other.name = 'worker';
    ctx.sessions.set(OTHER, other as never);
    roomId = service.createRoom('Reverie', undefined).id;
    service.addMember(roomId, VOICE, { voice: true });
    service.addMember(roomId, OTHER);
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
    await new Promise((r) => upstream.close(r));
    rmSync(diagDir, { recursive: true, force: true });
    rmSync(roomDir, { recursive: true, force: true });
    reloadCliRegistry();
  });

  const turn = (opts: { room?: string; member?: string; type?: string; body?: Buffer } = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/voice/turn?room=${opts.room ?? roomId}&member=${opts.member ?? VOICE}`,
      headers: { 'content-type': opts.type ?? 'audio/webm;codecs=opus' },
      payload: opts.body ?? Buffer.from('fake-webm-bytes'),
    });
  const agent = (id: string) => ({ kind: 'agent' as const, sessionId: id, name: service.nameOf(id) });
  /** The member's linked answer, as `reverie agent chat say --reply-to <asked.id>` posts it. */
  const answer = (asked: ChatMessage, id: string, text: string, room = roomId) =>
    service.post(room, agent(id), text, ['user'], { replyTo: asked.id });
  /** When the transcript lands, run `then` (a member's posts) on the next tick, as a real member would. */
  const onTranscript = (then: (asked: ChatMessage) => void | Promise<void>) => {
    const off = service.onMessage((_room, m) => {
      if (m.from.kind !== 'user' || !m.spoken) return;
      off();
      setImmediate(() => void then(m));
    });
  };
  const userMessages = () => service.view(service.room(roomId)!).messages.filter((m) => m.from.kind !== 'system');
  const typedInto = async (id: string) => {
    // Past the delivery spacing after the join briefing (chatroom-routes.test.ts does the same).
    await service.delivery.flushAll();
    clock += 10_000;
    await service.delivery.flushAll();
    return (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer.join('');
  };
  const listeners = () => (service as unknown as { messageListeners: Set<unknown> }).messageListeners.size;

  it('uses an exact linked answer committed synchronously during transcript publication', async () => {
    const earlier = service.post(roomId, { kind: 'user', name: 'user' }, 'earlier question', [VOICE], {
      deliver: false,
    });
    const off = service.onMessage((room, asked) => {
      if (room.id !== roomId || asked.from.kind !== 'user' || !asked.spoken) return;
      off();
      service.post(roomId, agent(VOICE), 'Unlinked aside.', ['user']);
      answer(asked, OTHER, 'Wrong author.');
      answer(earlier, VOICE, 'An older answer.');
      answer(asked, VOICE, 'Immediate linked answer.');
      service.post(roomId, agent(VOICE), 'A later aside.', ['user']);
    });
    const res = await turn();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.reply).toBe('Immediate linked answer.');
    expect(res.json().data.messages[1].replyTo).toBe(res.json().data.messages[0].id);
    expect(seen.filter((call) => call.url === '/tts').map((call) => call.json)).toEqual([
      { text: 'Immediate linked answer.' },
    ]);
    expect(listeners()).toBe(0);
  });

  it('does not use synchronous unlinked or wrong-author posts to satisfy the answer wait', async () => {
    const off = service.onMessage((room, asked) => {
      if (room.id !== roomId || asked.from.kind !== 'user' || !asked.spoken) return;
      off();
      service.post(roomId, agent(VOICE), 'Unlinked voice aside.', ['user']);
      answer(asked, OTHER, 'Linked but from another member.');
    });
    const res = await turn();
    expect(res.statusCode).toBe(504);
    expect(seen.map((call) => call.url)).toEqual(['/stt']);
    expect(listeners()).toBe(0);
  });

  it('transcribes, delivers the transcript to the member, and reads its own answer aloud', async () => {
    let pane = '';
    let askedId = '';
    onTranscript(async (asked) => {
      pane = await typedInto(VOICE); // what reached the member before it answered
      askedId = asked.id;
      answer(asked, VOICE, 'Time to ship, Pat.');
    });
    const res = await turn();
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({
      heard: true,
      transcript: 'what time is it',
      reply: 'Time to ship, Pat.',
      audioUrl: '/api/voice/audio/r1.mp3',
    });
    expect(seen.map((s) => s.url)).toEqual(['/stt', '/tts']);
    expect(seen[0]).toMatchObject({ method: 'POST', type: 'audio/webm;codecs=opus', bytes: 15 });
    expect(seen[1]).toMatchObject({ method: 'POST', type: 'application/json', json: { text: 'Time to ship, Pat.' } });

    const messages = userMessages();
    expect(messages.map((m) => [m.from.kind, m.text, m.to])).toEqual([
      ['user', 'what time is it', [VOICE]],
      ['agent', 'Time to ship, Pat.', ['user']],
    ]);
    expect(data.messages.map((m: ChatMessage) => m.id)).toEqual(messages.map((m) => m.id));
    // An ordinary spoken message, not a voice-service turn; the answer is the member's own post, untouched.
    expect(messages[0]).toMatchObject({ spoken: true });
    expect(messages[0].voice).toBeUndefined();
    expect(messages[1].voice).toBeUndefined();
    expect(messages[1].audioUrl).toBeUndefined();
    // Delivered like any message: the typed member gets it in its pane; the other member is not addressed.
    expect(pane).toContain('USER -> you: "what time is it"');
    // ...with the id its answer must name, since a typed pane links it by hand.
    expect(pane).toContain(`reverie agent chat say --reply-to ${askedId} "..."`);
    expect(messages[1].replyTo).toBe(askedId);
    expect(listeners()).toBe(0);
  });

  it('times each stage of the turn under the phone\'s turn id, and logs ids and durations but never the words', async () => {
    onTranscript((asked) => {
      answer(asked, VOICE, 'Time to ship, Pat.');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/turn?room=${roomId}&member=${VOICE}`,
        headers: { 'content-type': 'audio/webm;codecs=opus', 'x-reverie-voice-turn': '2f1c9a7e-5b3d-4c1e-9f0a-8d7e6c5b4a39' },
        payload: Buffer.from('fake-webm-bytes'),
      });
      const data = res.json().data;
      expect(data.turnId).toBe('2f1c9a7e-5b3d-4c1e-9f0a-8d7e6c5b4a39');
      for (const stage of ['sttMs', 'answerMs', 'ttsMs']) {
        expect(Number.isInteger(data.timing[stage]) && data.timing[stage] >= 0, stage).toBe(true);
      }
      const line = log.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith('[voice] turn '))!;
      expect(line).toContain('2f1c9a7e-5b3d-4c1e-9f0a-8d7e6c5b4a39');
      expect(line).toContain(data.messages[0].id);
      expect(line).toContain(data.messages[1].id);
      expect(line).not.toContain('what time is it');
      expect(line).not.toContain('Time to ship');
    } finally {
      log.mockRestore();
    }
  });

  it('mints its own turn id when the phone sends none or a malformed one, and times a turn that heard nothing', async () => {
    heard = { status: 200, body: { transcript: '   ' } };
    for (const header of [undefined, 'bad id!', 'x'.repeat(65)]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/turn?room=${roomId}&member=${VOICE}`,
        headers: { 'content-type': 'audio/webm', ...(header === undefined ? {} : { 'x-reverie-voice-turn': header }) },
        payload: Buffer.from('fake-webm-bytes'),
      });
      const data = res.json().data;
      expect(data.heard).toBe(false);
      expect(data.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(Number.isInteger(data.timing.sttMs)).toBe(true);
      expect(data.timing.answerMs).toBeUndefined();
    }
  });

  it('marks the transcript owner_spoken only for a verified owner', async () => {
    onTranscript((asked) => answer(asked, VOICE, 'one'));
    await turn();
    owner = true;
    onTranscript((asked) => answer(asked, VOICE, 'two'));
    await turn();
    const asked = userMessages().filter((m) => m.from.kind === 'user');
    expect(asked.map((m) => (m.from as { mark?: string }).mark)).toEqual([undefined, 'owner_spoken']);
  });

  it('takes the answer from a polling member without typing anything into its pane', async () => {
    registerPoller();
    const poller = createMockSession(POLLER);
    poller.name = 'loop';
    (poller as unknown as { mode: string }).mode = 'poll-agent';
    ctx.sessions.set(POLLER, poller as never);
    service.addMember(roomId, POLLER, { voice: true });
    expect(service.room(roomId)!.members.find((m) => m.sessionId === POLLER)?.postOnly).toBe(true);
    const before = await typedInto(POLLER);
    onTranscript((asked) => answer(asked, POLLER, 'Read it through the API.'));
    const res = await turn({ member: POLLER });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ transcript: 'what time is it', reply: 'Read it through the API.' });
    expect(await typedInto(POLLER)).toBe(before);
  });

  it("reads only the member's own post that names the transcript, whatever comes first", async () => {
    const otherRoom = service.createRoom('Elsewhere', undefined).id;
    service.addMember(otherRoom, VOICE);
    service.addMember(otherRoom, OTHER);
    const earlier = service.post(roomId, { kind: 'user', name: 'user' }, 'earlier question', [VOICE], {
      deliver: false,
    });
    onTranscript((asked) => {
      service.post(roomId, agent(VOICE), 'an unlinked aside first', ['user']);
      answer(asked, OTHER, 'I am not the voice'); // another member naming the transcript
      service.post(otherRoom, agent(VOICE), 'wrong room');
      answer(earlier, VOICE, 'answer to the earlier question');
      answer(asked, VOICE, 'It is noon.');
      service.post(roomId, agent(VOICE), 'a later aside');
    });
    const res = await turn();
    expect(res.json().data.reply).toBe('It is noon.');
    expect(seen.filter((s) => s.url === '/tts').map((s) => s.json)).toEqual([{ text: 'It is noon.' }]);
  });

  it('never falls back to an unlinked post: no linked answer is no reply, and nothing is spoken', async () => {
    onTranscript((asked) => {
      service.post(roomId, agent(VOICE), 'It is noon.', ['user']); // the right words, but not linked
      answer(asked, OTHER, 'linked, but from someone else');
    });
    const res = await turn();
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toContain('No reply from assistant yet');
    expect(seen.map((s) => s.url)).toEqual(['/stt']);
    expect(listeners()).toBe(0);
  });

  it('keeps two concurrent turns to two members apart, each with its own linked answer', async () => {
    const second = service.createRoom('Second', undefined).id;
    service.addMember(second, OTHER, { voice: true });
    const asked: ChatMessage[] = [];
    const off = service.onMessage((_room, m) => {
      if (m.from.kind !== 'user' || !m.spoken) return;
      asked.push(m);
      if (asked.length < 2) return;
      off();
      // Both are waiting now: answer in the opposite order, each naming its own transcript.
      const [a, b] = asked;
      setImmediate(() => {
        const toOther = a.to.includes(OTHER) ? a : b;
        const toVoice = toOther === a ? b : a;
        answer(toOther, OTHER, 'answer for the second room', second);
        answer(toVoice, VOICE, 'answer for the first room');
      });
    });
    const [one, two] = await Promise.all([turn(), turn({ room: second, member: OTHER })]);
    expect(one.json().data).toMatchObject({ reply: 'answer for the first room' });
    expect(two.json().data).toMatchObject({ reply: 'answer for the second room' });
    expect(one.json().data.messages[1].replyTo).toBe(one.json().data.messages[0].id);
    expect(two.json().data.messages[1].replyTo).toBe(two.json().data.messages[0].id);
    expect(listeners()).toBe(0);
  });

  it('refuses a second turn to the same member while the first waits, then takes turns again', async () => {
    const elsewhere = service.createRoom('Elsewhere', undefined).id;
    service.addMember(elsewhere, VOICE, { voice: true });
    let release: (() => void) | undefined;
    onTranscript((asked) => {
      release = () => answer(asked, VOICE, 'first');
    });
    const first = turn();
    await new Promise<void>((r) => {
      const poll = () => (release ? r() : setImmediate(poll));
      poll();
    });
    for (const busy of [await turn(), await turn({ room: elsewhere })]) {
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error).toContain('Still waiting for assistant');
    }
    release!();
    expect((await first).json().data.reply).toBe('first');
    expect(seen.filter((s) => s.url === '/stt')).toHaveLength(1); // the refused turns were never transcribed
    onTranscript((asked) => answer(asked, VOICE, 'second'));
    expect((await turn()).json().data.reply).toBe('second');
  });

  it('frees the member after a failed turn', async () => {
    heard = { status: 500, body: { error: 'whisper crashed' } };
    expect((await turn()).statusCode).toBe(502);
    heard = { status: 200, body: { transcript: 'again' } };
    expect((await turn()).statusCode).toBe(504); // not 409: the failed turn let go
    onTranscript((asked) => answer(asked, VOICE, 'third time'));
    expect((await turn()).json().data.reply).toBe('third time');
  });

  it('says "no reply yet" when the member does not answer in time, keeping the transcript', async () => {
    const res = await turn();
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toContain('No reply from assistant yet');
    expect(userMessages().map((m) => m.text)).toEqual(['what time is it']);
    expect(seen.map((s) => s.url)).toEqual(['/stt']);
    expect(listeners()).toBe(0);
    // A late answer is just a message in the room.
    service.post(roomId, agent(VOICE), 'late');
    expect(userMessages().map((m) => m.text)).toEqual(['what time is it', 'late']);
  });

  it('still returns the answer when text to speech fails or names no usable audio', async () => {
    const answers = [
      { status: 500, body: { error: 'piper crashed' } },
      { status: 200, body: 'not json', type: 'text/plain' },
      { status: 200, body: { audio_url: 'http://evil.example/x.mp3' } },
    ];
    for (const a of answers) {
      spoken = a;
      onTranscript((asked) => answer(asked, VOICE, 'still here'));
      const res = await turn();
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ heard: true, reply: 'still here', audioUrl: null });
    }
    upstream.removeAllListeners('request');
    upstream.on('request', (req, res) => {
      if (req.url === '/stt') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transcript: 'hi' }));
      } else req.socket.destroy();
    });
    onTranscript((asked) => answer(asked, VOICE, 'no speaker'));
    const down = await turn();
    expect(down.statusCode).toBe(200);
    expect(down.json().data).toMatchObject({ reply: 'no speaker', audioUrl: null });
  });

  it('accepts the .wav ids the voice service mints', async () => {
    spoken = { status: 200, body: { id: 'a1', audio_url: '/audio/a1.wav', tts_ms: 90 } };
    onTranscript((asked) => answer(asked, VOICE, 'hey'));
    expect((await turn()).json().data.audioUrl).toBe('/api/voice/audio/a1.wav');
  });

  it('treats an empty transcript as nothing heard and posts nothing', async () => {
    heard = { status: 200, body: { transcript: '   ' } };
    const res = await turn();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ heard: false, messages: [] });
    expect(userMessages()).toHaveLength(0);
    expect(seen.map((s) => s.url)).toEqual(['/stt']);
  });

  it('accepts iPhone Safari mp4 recordings', async () => {
    onTranscript((asked) => answer(asked, VOICE, 'ok'));
    expect((await turn({ type: 'audio/mp4' })).statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ url: '/stt', type: 'audio/mp4' });
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

  it('refuses a member that is not marked as the voice, whatever its name', async () => {
    (ctx.sessions.get(OTHER) as unknown as { name: string }).name = 'assistant: memory + learning persona';
    const res = await turn({ member: OTHER });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not set up for voice');
    expect(seen).toHaveLength(0);
  });

  it('refuses a wrong room, a non-member, an empty body and a non-audio body', async () => {
    expect((await turn({ room: 'nope' })).statusCode).toBe(404);
    expect((await turn({ member: '00000048-005c-4000-8000-00000000008d' })).statusCode).toBe(400);
    expect((await turn({ body: Buffer.alloc(0) })).statusCode).toBe(400);
    expect((await turn({ type: 'application/json', body: Buffer.from('{}') })).statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('reports speech to text that is down, failing, too long or answering nonsense, posting nothing', async () => {
    heard = { status: 500, body: { error: 'whisper crashed' } };
    let res = await turn();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('whisper crashed');
    heard = { status: 413, body: { error: 'too long' } };
    expect((await turn()).statusCode).toBe(413);
    heard = { status: 200, body: { nope: true } };
    expect((await turn()).statusCode).toBe(502);
    await new Promise((r) => upstream.close(r));
    upstream = http.createServer();
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:1';
    res = await turn();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('Whisper/Piper speech service at 127.0.0.1:1 could not be reached');
    expect(userMessages()).toHaveLength(0);
    expect(listeners()).toBe(0);
  });

  it('defaults to the local service and honours REVERIE_VOICE_TURN_URL', () => {
    expect(voiceServiceUrl({})).toBe('http://127.0.0.1:8090');
    expect(voiceServiceUrl({ REVERIE_VOICE_TURN_URL: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
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
    expect(res.json().data).toEqual({ transcript: 'what time is it' });
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
