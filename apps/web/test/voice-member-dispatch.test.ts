/** Addressed voice turns must start a runtime prompt, not stop at a history read. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';
import type { ChatMessage } from '../src/chatroom-store.js';
import Fastify from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerVoiceTurnRoutes } from '../src/web/routes/voice-turn-routes.js';
import { DELIVERY_POLL_MS, isAddressedVoiceTurn } from '../src/chatroom-delivery.js';

const VOICE = '00000000-0000-4000-8000-000000000001';
const LEAD = '00000000-0000-4000-8000-000000000002';
let service: ChatroomService, directory: string, clock: number;
let pane: ChatSessionLike & { isWorking: boolean; writes: string[] };
let roomId: string;
let replyTo: ChatMessage | undefined;
let outcome: 'submitted' | 'stranded' | 'unverified';
beforeEach(async () => {
  vi.useFakeTimers();
  directory = await mkdtemp(join(tmpdir(), 'voice-dispatch-'));
  clock = 1_000_000;
  outcome = 'submitted';
  replyTo = undefined;
  pane = {
    id: VOICE,
    name: 'Voice',
    mode: 'codex',
    status: 'idle',
    pid: 1,
    isWorking: false,
    writes: [],
    writeViaMux: async (data, options) => {
      pane.writes.push(data);
      options?.onOutcome?.(outcome);
      if (replyTo && data.includes(replyTo.id)) {
        const asked = replyTo;
        queueMicrotask(() =>
          service.post(
            roomId,
            { kind: 'agent', sessionId: VOICE, name: 'Voice' },
            'The fixture runtime answered.',
            ['user'],
            { replyTo: asked.id }
          )
        );
      }
      return true;
    },
  };
  const lead: ChatSessionLike = {
    ...pane,
    id: LEAD,
    name: 'Lead',
    writeViaMux: async (_data, options) => {
      options?.onOutcome?.('submitted');
      return true;
    },
  };
  service = new ChatroomService({
    file: join(directory, 'chatrooms.json'),
    now: () => clock,
    getSession: (id) => (id === VOICE ? pane : id === LEAD ? lead : undefined),
    broadcast: () => {},
  });
  await service.init();
  const room = service.createRoom('Dispatch fixture', undefined);
  roomId = room.id;
  service.addMember(roomId, VOICE, { voice: true });
  service.addMember(roomId, LEAD);
  service.appointCoordinator(roomId, LEAD);
  service.setRoomWake(roomId, 'mentions');
  clock += 10_000;
  await service.delivery.flushAll();
  pane.writes.length = 0;
  clock += 10_000;
});
afterEach(async () => {
  await service?.stop();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('history read during other work cannot consume an unsubmitted addressed voice turn; idle then wakes without relay', async () => {
  pane.isWorking = true;
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, 'Please answer this spoken turn.', [VOICE], {
    spoken: true,
  });
  replyTo = asked;
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  expect(service.lastSeen(VOICE, roomId)?.messageId).toBe(asked.id);
  expect(service.delivery.pendingFor(VOICE)).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(pane.writes).toHaveLength(0);
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(1100);
  expect(pane.writes).toHaveLength(1);
  expect(pane.writes[0]).toContain(asked.id);
  expect(
    service.room(roomId)!.messages.some((message) => message.replyTo === asked.id && message.from.kind === 'agent')
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(pane.writes).toHaveLength(1);
});

it('an addressed typed mention also survives a concurrent history read', async () => {
  pane.isWorking = true;
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please answer.', 'all');
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  expect(service.delivery.pendingFor(VOICE)).toBe(1);
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(1100);
  expect(pane.writes).toHaveLength(1);
  expect(pane.writes[0]).toContain(asked.id);
});

it('unaddressed chatter has no extra voice turn and still acknowledges normally', async () => {
  const message = service.post(
    roomId,
    { kind: 'agent', sessionId: LEAD, name: 'Lead' },
    'General room chatter.',
    'all'
  );
  service.acknowledgeAgentRead(VOICE, roomId, [message]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(pane.writes).toHaveLength(0);
  expect(service.delivery.pendingFor(VOICE)).toBe(0);
});

it('a voice member that already answered while reading does not get a redundant prompt', async () => {
  pane.isWorking = true;
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice answer this.', 'all');
  service.post(roomId, { kind: 'agent', sessionId: VOICE, name: 'Voice' }, 'Handled in the current turn.', ['user'], {
    replyTo: asked.id,
  });
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(3000);
  expect(pane.writes).toHaveLength(0);
});

it('an attempted unverified submit is not blindly injected again after a history read', async () => {
  outcome = 'unverified';
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice answer this.', 'all');
  await vi.advanceTimersByTimeAsync(1000);
  expect(pane.writes).toHaveLength(1);
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(pane.writes).toHaveLength(1);
});

it('an addressed reply to the voice member is a turn, without an unrelated @mention', async () => {
  pane.isWorking = true;
  const prior = service.post(roomId, { kind: 'agent', sessionId: VOICE, name: 'Voice' }, 'What would you like?', 'all');
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, 'Please explain that.', 'all', {
    replyTo: prior.id,
  });
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  expect(service.delivery.pendingFor(VOICE)).toBe(1);
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(1100);
  expect(pane.writes).toHaveLength(1);
  expect(pane.writes[0]).toContain(asked.id);
});

it('the linked answer cancels an unattempted voice wake even without a history read', async () => {
  pane.isWorking = true;
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please explain.', 'all');
  service.post(roomId, { kind: 'agent', sessionId: VOICE, name: 'Voice' }, 'Answered in this turn.', ['user'], {
    replyTo: asked.id,
  });
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(3000);
  expect(pane.writes).toHaveLength(0);
});

it('queued voice turns survive history-read acknowledgement and a service restart', async () => {
  pane.isWorking = true;
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please explain.', 'all');
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  await service.stop();
  service = new ChatroomService({
    file: join(directory, 'chatrooms.json'),
    now: () => clock,
    getSession: (id) => (id === VOICE ? pane : undefined),
    broadcast: () => {},
  });
  await service.init();
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(1100);
  expect(pane.writes).toHaveLength(1);
  expect(pane.writes[0]).toContain(asked.id);
  await vi.advanceTimersByTimeAsync(5000);
  expect(pane.writes).toHaveLength(1);
});

it('ordinary timer and explicit flush races submit the same queued turn only once', async () => {
  service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please explain.', 'all');
  await Promise.all([service.delivery.flush(VOICE), service.delivery.flush(VOICE), service.delivery.flushAll()]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(pane.writes).toHaveLength(1);
});

it('a stopped voice runtime is not started, interrupted or submitted into', async () => {
  Object.assign(pane, { pid: null });
  service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please explain.', 'all');
  await vi.advanceTimersByTimeAsync(5000);
  expect(pane.writes).toHaveLength(0);
});

it('a shell cannot receive an addressed room prompt', async () => {
  Object.assign(pane, { mode: 'shell' });
  service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please explain.', 'all');
  await vi.advanceTimersByTimeAsync(5000);
  expect(pane.writes).toHaveLength(0);
});

it('history acknowledgement keeps its existing semantics for an ordinary non-voice member', async () => {
  service.setStatus(roomId, VOICE, { voice: false });
  pane.isWorking = true;
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please explain.', 'all');
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(3000);
  expect(pane.writes).toHaveLength(0);
});

it('an ambiguous display-name mention cannot establish the unique addressed voice identity', () => {
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please explain.', 'all');
  expect(isAddressedVoiceTurn(service.room(roomId)!, asked, VOICE, () => 'Voice')).toBe(false);
});

it('the voice-turn HTTP route gets a linked answer only after automatic runtime submission, without a relay', async ({
  annotate,
}) => {
  vi.useRealTimers();
  service.delivery.stop();
  service.delivery.start(10);
  pane.isWorking = true;
  // Speech protocols are stubbed here: this acceptance is for dispatch, not audio/ASR.
  const speech = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/stt'
            ? { transcript: 'Please answer this spoken question.' }
            : { audio_url: '/audio/fixture.wav' }
        )
      );
    });
  });
  await new Promise<void>((resolve) => speech.listen(0, '127.0.0.1', resolve));
  const app = Fastify();
  registerVoiceTurnRoutes(app, service, {
    serviceUrl: () => `http://127.0.0.1:${(speech.address() as AddressInfo).port}`,
    replyWaitMs: 1000,
  });
  const times: { posted?: number; read?: number; eligible?: number; submitted?: number; answered?: number } = {};
  service.onMessage((_room, message) => {
    if (message.spoken && message.from.kind === 'user') {
      replyTo = message;
      times.posted = performance.now();
      service.acknowledgeAgentRead(VOICE, roomId, [message]);
      times.read = performance.now();
      setTimeout(() => {
        pane.isWorking = false;
        times.eligible = performance.now();
      }, 20);
    }
    if (message.replyTo && message.from.kind === 'agent') times.answered = performance.now();
  });
  const write = pane.writeViaMux;
  pane.writeViaMux = async (data, options) => {
    times.submitted = performance.now();
    return write(data, options);
  };
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/voice/turn?room=${roomId}&member=${VOICE}`,
      headers: { 'Content-Type': 'audio/wav' },
      payload: Buffer.from('fixture-recording'),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.reply).toBe('The fixture runtime answered.');
    expect(response.json().data.messages[1].replyTo).toBe(response.json().data.messages[0].id);
    expect(pane.writes).toHaveLength(1);
    expect(times.submitted).toBeGreaterThanOrEqual(times.posted!);
    expect(times.answered).toBeGreaterThanOrEqual(times.submitted!);
    expect(times.submitted! - times.eligible!).toBeLessThan(1000);
    await annotate('Controlled dispatch stage timings', 'voice-dispatch-timing', {
      contentType: 'application/json',
      bodyEncoding: 'utf-8',
      body: JSON.stringify({
        qualification:
          'Controlled submit/answer fixture; speech service stubbed; 10ms fixture poll; not device/model/audio latency',
        messageId: response.json().data.messages[0].id,
        replyTo: response.json().data.messages[1].replyTo,
        postedToReadMs: times.read! - times.posted!,
        busyWaitMs: times.eligible! - times.posted!,
        eligibleToSubmitMs: times.submitted! - times.eligible!,
        submittedToAnswerMs: times.answered! - times.submitted!,
        postedToAnswerMs: times.answered! - times.posted!,
      }),
    });
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => speech.close((error) => (error ? reject(error) : resolve())));
  }
});

it('submits an idle addressed voice turn immediately through the normal queue, before the polling interval', async () => {
  const started = Date.now();
  const times: number[] = [];
  const write = pane.writeViaMux;
  pane.writeViaMux = async (data, options) => {
    times.push(Date.now() - started);
    return write(data, options);
  };
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please answer now.', 'all');
  await Promise.resolve();
  expect(pane.writes).toHaveLength(1);
  expect(times).toEqual([0]);
  expect(times[0]).toBeLessThan(DELIVERY_POLL_MS);
  expect(pane.writes[0]).toContain(asked.id);
  await vi.advanceTimersByTimeAsync(DELIVERY_POLL_MS * 3);
  expect(pane.writes).toHaveLength(1);
});

it('does not retain an extra CLI turn when the stock Hands runtime reads its API feed', async () => {
  Object.assign(pane, { mode: 'hands' });
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please answer through the feed.', 'all');
  service.acknowledgeAgentRead(VOICE, roomId, [asked]);
  expect(service.delivery.pendingFor(VOICE)).toBe(0);
  expect(service.lastSeen(VOICE, roomId)?.messageId).toBe(asked.id);
  await vi.advanceTimersByTimeAsync(DELIVERY_POLL_MS * 3);
  expect(pane.writes).toHaveLength(0);
});

it('does not infer an addressed turn from a reply to a deleted voice message', async () => {
  pane.isWorking = true;
  const prior = service.post(roomId, { kind: 'agent', sessionId: VOICE, name: 'Voice' }, 'Withdrawn.', 'all');
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, 'A reply to removed context.', 'all', {
    replyTo: prior.id,
  });
  // Public message projections are detached from the private persisted record.
  await service.deleteMessage(roomId, prior.id, 'user');
  expect(service.room(roomId)!.messages.find(message => message.id === prior.id)?.deleted).toEqual({ at: clock, by: 'user' });
  expect(isAddressedVoiceTurn(service.room(roomId)!, asked, VOICE, (id) => (id === VOICE ? 'Voice' : 'Lead'))).toBe(
    false
  );
});

it('reconciles a saved linked answer when restart finds its old queued delivery still present', async () => {
  pane.isWorking = true;
  const asked = service.post(roomId, { kind: 'user', name: 'Owner' }, '@Voice please answer once.', 'all');
  // Model the durable gap between answer commit and pending-store cleanup.
  const cleanup = vi.spyOn(service.delivery, 'acknowledgeRead').mockImplementationOnce(() => {});
  service.post(roomId, { kind: 'agent', sessionId: VOICE, name: 'Voice' }, 'Already answered.', ['user'], {
    replyTo: asked.id,
  });
  cleanup.mockRestore();
  expect(service.delivery.pendingFor(VOICE)).toBe(1);
  await service.stop();
  service = new ChatroomService({
    file: join(directory, 'chatrooms.json'),
    now: () => clock,
    getSession: (id) => (id === VOICE ? pane : undefined),
    broadcast: () => {},
  });
  await service.init();
  pane.isWorking = false;
  await vi.advanceTimersByTimeAsync(3000);
  expect(pane.writes).toHaveLength(0);
  expect(service.delivery.pendingFor(VOICE)).toBe(0);
  expect(
    service.room(roomId)!.messages.filter((message) => message.replyTo === asked.id && message.from.kind === 'agent')
  ).toHaveLength(1);
});
