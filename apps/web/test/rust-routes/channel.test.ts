/**
 * The route channel's state machine against a scripted in-process child speaking route-frames-v1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  QUEUE_LIMIT,
  REAP_MS,
  RESPAWN_THROTTLE_MS,
  RouteChannel,
  STDERR_LINES,
  STDERR_LINE_BYTES,
  TIMEOUT_MS,
  type Outcome,
  type Step,
} from '../../src/rust-routes/channel.js';
import type { Frame } from '../../src/rust-routes/frames.js';
import { FakeChild } from './fake-child.js';

const ROUTE = 'GET /api/subscription-profiles';

const ok = (child: FakeChild, frame: Frame) => {
  if (frame.body.kind === 'request')
    child.reply(frame.id, { kind: 'response', status: 200, body: Buffer.from(`ok ${frame.id}`) });
};

let clock = 0;
let logs: string[] = [];
let children: FakeChild[] = [];

function channel(script: (child: FakeChild, frame: Frame) => void = ok): RouteChannel {
  return new RouteChannel({
    handlerPath: '/handler',
    statuses: { [ROUTE]: [200, 500] },
    log: (message) => logs.push(message),
    now: () => clock,
    spawn: (_path, args) => {
      const child = new FakeChild(Number(args[1]), script);
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function done(step: Promise<Step>): Promise<Outcome> {
  const settled = await step;
  if (settled.kind !== 'done') throw new Error(`expected an outcome, got ${settled.kind}`);
  return settled.outcome;
}

beforeEach(() => {
  clock = 0;
  logs = [];
  children = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('route channel', () => {
  it('passes reply bytes through and dispatches one request at a time', async () => {
    const routes = channel();
    const first = routes.admit(ROUTE, Buffer.from('{}'));
    const second = routes.admit(ROUTE, Buffer.from('{}'));
    expect(await done(first.next())).toEqual({
      kind: 'response',
      generation: 1,
      id: 1,
      status: 200,
      body: Buffer.from('ok 1'),
    });
    expect(await done(second.next())).toMatchObject({ kind: 'response', id: 2, body: Buffer.from('ok 2') });
    expect(children).toHaveLength(1);
    expect(children[0].received.map((frame) => frame.id)).toEqual([1n, 2n]);
  });

  it('answers an observation from the route and then completes', async () => {
    const routes = channel((child, frame) => {
      if (frame.body.kind === 'request')
        child.reply(frame.id, { kind: 'observe', observation: 'subscription_modes', providers: ['openai'] });
      if (frame.body.kind === 'observed')
        child.reply(frame.id, { kind: 'response', status: 200, body: frame.body.json });
    });
    const ticket = routes.admit(ROUTE, Buffer.from('{}'));
    expect(await ticket.next()).toEqual({ kind: 'observe', providers: ['openai'] });
    expect(await done(ticket.answer(Buffer.from('{"openai":[]}')))).toMatchObject({
      status: 200,
      body: Buffer.from('{"openai":[]}'),
    });
  });

  it('discards a canceled late reply but ends the generation on a forged or duplicate id', async () => {
    let hold: Frame | undefined;
    const routes = channel((child, frame) => {
      if (frame.body.kind === 'request' && frame.id === 1n) hold = frame;
      else if (frame.body.kind === 'cancel')
        child.reply(hold!.id, { kind: 'response', status: 200, body: Buffer.from('late') });
      else ok(child, frame);
    });
    const canceled = routes.admit(ROUTE, Buffer.from('{}'));
    const next = routes.admit(ROUTE, Buffer.from('{}'));
    await flush();
    canceled.abandon();
    expect(await done(canceled.next())).toMatchObject({ kind: 'unavailable', reason: 'abandoned' });
    expect(await done(next.next())).toMatchObject({ kind: 'response', id: 2 });

    const forged = channel((child, frame) => child.reply(frame.id + 5n, { kind: 'refusal', code: 'X' }));
    const victim = forged.admit(ROUTE, Buffer.from('{}'));
    expect(await done(victim.next())).toMatchObject({ kind: 'unavailable', reason: 'unexpected frame' });
    expect(children.at(-1)!.kills).toBe(1);

    const duplicate = channel((child, frame) => {
      ok(child, frame);
      ok(child, frame);
    });
    const once = duplicate.admit(ROUTE, Buffer.from('{}'));
    expect(await done(once.next())).toMatchObject({ kind: 'response' });
    await flush();
    expect(children.at(-1)!.kills).toBe(1);
  });

  it('refuses a call beyond the queue limit without enqueueing it', async () => {
    const routes = channel(() => {});
    const admitted = Array.from({ length: QUEUE_LIMIT }, () => routes.admit(ROUTE, Buffer.alloc(60 * 1024, 0x20)));
    const refused = routes.admit(ROUTE, Buffer.from('{}'));
    expect(await done(refused.next())).toMatchObject({ kind: 'unavailable', reason: 'queue full' });
    await flush();
    expect(children[0].received).toHaveLength(1);
    expect(children[0].written).toBeLessThanOrEqual(65623 + 65559 + 22);
    expect(admitted.every((ticket) => !ticket.settled)).toBe(true);
  });

  it('ends the generation on a head timeout and spawns the next only after exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const routes = channel(() => {});
    const stuck = routes.admit(ROUTE, Buffer.from('{}'));
    const queued = routes.admit(ROUTE, Buffer.from('{}'));
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(await done(stuck.next())).toMatchObject({ kind: 'unavailable', reason: 'dispatched request timed out' });
    expect(await done(queued.next())).toMatchObject({ kind: 'unavailable', id: 0 });
    expect(children[0].kills).toBe(1);
    await flush();
    clock += RESPAWN_THROTTLE_MS;
    routes.admit(ROUTE, Buffer.from('{}'));
    expect(children).toHaveLength(2);
    expect(children[1].generation).toBe(2);
  });

  it('keeps the deadline of a canceled head whose child never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const routes = channel(() => {});
    const canceled = routes.admit(ROUTE, Buffer.from('{}'));
    const queued = routes.admit(ROUTE, Buffer.from('{}'));
    await flush();
    canceled.abandon();
    expect(await done(canceled.next())).toMatchObject({ kind: 'unavailable', reason: 'abandoned' });
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(await done(queued.next())).toMatchObject({ kind: 'unavailable', reason: 'dispatched request timed out' });
    expect(children[0].received.map((frame) => frame.body.kind)).toEqual(['request', 'cancel']);
    expect(children[0].kills).toBe(1);
    await flush();
    clock += RESPAWN_THROTTLE_MS;
    routes.admit(ROUTE, Buffer.from('{}'));
    expect(children).toHaveLength(2);
  });

  it('never starts a successor while an old child may still be alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const routes = channel((child) => {
      child.killable = false;
      child.stdout.write(Buffer.from([0, 0, 0, 1]));
    });
    const ticket = routes.admit(ROUTE, Buffer.from('{}'));
    expect(await done(ticket.next())).toMatchObject({ kind: 'unavailable' });
    await vi.advanceTimersByTimeAsync(REAP_MS);
    clock += RESPAWN_THROTTLE_MS;
    const after = routes.admit(ROUTE, Buffer.from('{}'));
    expect(await done(after.next())).toMatchObject({ reason: 'unconfirmed' });
    expect(children).toHaveLength(1);
    expect(logs.some((line) => line.includes('did not exit after SIGKILL'))).toBe(true);
  });

  it('keeps stderr bounded while replies still arrive', async () => {
    const routes = channel((child, frame) => {
      child.stderr.write(Buffer.alloc(10 * 1024 * 1024, 0x41));
      child.stderr.write(Buffer.from('\n' + 'line\n'.repeat(STDERR_LINES * 2)));
      ok(child, frame);
    });
    expect(await done(routes.admit(ROUTE, Buffer.from('{}')).next())).toMatchObject({ kind: 'response' });
    await flush();
    const lines = logs.filter((line) => line.startsWith('rust route handler g1:'));
    expect(lines).toHaveLength(STDERR_LINES);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(STDERR_LINE_BYTES + 40);
  });

  it('ends the generation before dispatching past the id budget', async () => {
    const routes = channel();
    expect(await done(routes.admit(ROUTE, Buffer.from('{}')).next())).toMatchObject({ kind: 'response' });
    (routes as unknown as { counter: number }).counter = Number.MAX_SAFE_INTEGER;
    expect(await done(routes.admit(ROUTE, Buffer.from('{}')).next())).toMatchObject({ reason: 'id budget exhausted' });
    expect(children[0].received).toHaveLength(1);
  });

  it('settles every call once at shutdown and reports an unconfirmed termination', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const routes = channel((child) => {
      child.killable = false;
    });
    const tickets = [routes.admit(ROUTE, Buffer.from('{}')), routes.admit(ROUTE, Buffer.from('{}'))];
    await flush();
    const closing = routes.close();
    await vi.advanceTimersByTimeAsync(4 * 1000);
    expect(await closing).toEqual({ terminated: false });
    for (const ticket of tickets) expect(await done(ticket.next())).toMatchObject({ reason: 'server closing' });
    expect(await done(routes.admit(ROUTE, Buffer.from('{}')).next())).toMatchObject({ reason: 'closing' });
  });

  it('gives every close the one shutdown result, never a confirmation it did not get', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = channel((child) => {
      child.killable = false;
    });
    held.admit(ROUTE, Buffer.from('{}'));
    await flush();
    const first = held.close();
    const concurrent = held.close();
    await vi.advanceTimersByTimeAsync(4 * 1000);
    expect(await first).toEqual({ terminated: false });
    expect(await concurrent).toEqual({ terminated: false });
    expect(await held.close()).toEqual({ terminated: false });
    expect(children[0].kills).toBe(1);

    const ended = channel();
    ended.admit(ROUTE, Buffer.from('{}'));
    await flush();
    const both = Promise.all([ended.close(), ended.close()]);
    await vi.advanceTimersByTimeAsync(4 * 1000);
    expect(await both).toEqual([{ terminated: true }, { terminated: true }]);
    expect(children[1].kills).toBe(1);
  });
});
