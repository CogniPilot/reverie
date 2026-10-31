import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * @fileoverview A lost input must stay retryable.
 *
 * POST /api/sessions/:id/input answers 200 BEFORE the write is attempted — the mux
 * write is fire-and-forget so the HTTP response never waits on a tmux child. The
 * dedup bookkeeping, however, recorded the (clientId, seq) pair as applied at that
 * same moment. A write that then failed left the client with a 200, no message in
 * the pane, and a seq the server would reject as a duplicate on retry: the input was
 * unrecoverable by the very mechanism meant to make delivery reliable.
 *
 * Observed in the wild: a prompt shown as sent in a chat client, a 200 in the proxy
 * log, and an empty prompt line in the pane.
 */

import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../../src/session.js';
import { agentSend, EXIT, type AgentDeps } from '../../src/cli-agent.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { isPlainPromptInput } from '../../src/web/route-helpers.js';
import { registerSessionRoutes, _resetPaneLivenessState } from '../../src/web/routes/session-routes.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';

async function createEnvelopeHarness(): Promise<{ app: FastifyInstance; ctx: MockRouteContext }> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx as never, { ...({}), verifiedOwner: trustedFixtureOwner });

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

type Internals = { _appliedInputSeq: Map<string, number> };
const seqOf = (s: Session, client: string) => (s as unknown as Internals)._appliedInputSeq.get(client);

describe('input dedup bookkeeping', () => {
  const make = () => new Session({ workingDir: '/tmp', mode: 'claude' });

  it('accepts an increasing seq once and rejects the replay', () => {
    const s = make();
    expect(s.shouldApplyInput('c1', 1)).toBe(true);
    expect(s.shouldApplyInput('c1', 1)).toBe(false);
    expect(s.shouldApplyInput('c1', 2)).toBe(true);
  });

  it('forgetInputSeq re-opens a failed delivery for retry', () => {
    const s = make();
    expect(s.shouldApplyInput('c1', 7)).toBe(true);

    s.forgetInputSeq('c1', 7); // the write failed after the 200 went out

    expect(s.shouldApplyInput('c1', 7)).toBe(true);
  });

  it('does not re-open a seq that a later input has superseded', () => {
    // Rolling back blindly would let an old, already-superseded message replay.
    const s = make();
    s.shouldApplyInput('c1', 7);
    s.shouldApplyInput('c1', 8);

    s.forgetInputSeq('c1', 7);

    expect(s.shouldApplyInput('c1', 8)).toBe(false);
    expect(seqOf(s, 'c1')).toBe(8);
  });

  it('is scoped per client', () => {
    const s = make();
    s.shouldApplyInput('c1', 5);
    s.forgetInputSeq('c2', 5);
    expect(s.shouldApplyInput('c1', 5)).toBe(false);
  });

  it('tolerates a rollback for a client that was never seen', () => {
    const s = make();
    expect(() => s.forgetInputSeq('ghost', 3)).not.toThrow();
  });
});

describe('Session.write delivery signal', () => {
  it('reports false when there is no PTY instead of swallowing the data', () => {
    // The silent swallow was the third way input could vanish: no PTY, no error,
    // no return value — the caller had no way to know.
    const s = new Session({ workingDir: '/tmp', mode: 'claude' });
    expect(s.write('hello\r')).toBe(false);
  });
});

/**
 * Wiring, not primitives.
 *
 * The first version of this file tested Session directly and nothing else: reverting
 * the route to master — deleting the rollback call, the load-bearing half of the fix —
 * left all six tests green. These drive the actual HTTP route.
 */
describe('POST /api/sessions/:id/input rollback wiring', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  const post = (body: Record<string, unknown>, id = 'test-session-1') =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/input`, payload: body });

  it('rolls the seq back when both the mux write and the direct write fail', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.failWrites = true; // writeViaMux false AND write() false

    await post({ input: 'lost\r', useMux: true, clientId: 'c1', seq: 1 });
    await new Promise((r) => setTimeout(r, 20)); // the mux write is fire-and-forget

    // The retry the client would make must be accepted, not swallowed as a duplicate.
    expect(session.shouldApplyInput('c1', 1)).toBe(true);
  });

  it('keeps the seq burnt when delivery succeeded', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;

    await post({ input: 'fine\r', useMux: true, clientId: 'c1', seq: 1 });
    await new Promise((r) => setTimeout(r, 20));

    expect(session.shouldApplyInput('c1', 1)).toBe(false);
  });

  it('rolls the seq back on the non-mux path too', async () => {
    // Still a 200: a session may legitimately have no PTY yet, and turning that
    // into a failure status would be a contract change. Re-opening the seq is not.
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.failWrites = true;

    const res = await post({ input: 'x\r', useMux: false, clientId: 'c2', seq: 5 });

    expect(res.statusCode).toBe(200);
    expect(session.shouldApplyInput('c2', 5)).toBe(true);
  });
});

/**
 * A plain prompt goes through the mux even when the caller did not say `useMux`.
 *
 * Measured on Claude Code 2.1.283: a direct write of `<text>\r` arrives as one burst,
 * a burst of about a hundred characters is taken as a paste, and its `\r` lands as a
 * newline in the composer, so a script's prompt sat there unsent while the route
 * answered 200. The mux path types the text, presses Enter on its own, and arms the
 * submit verifier.
 */
describe('POST /api/sessions/:id/input plain-prompt routing', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  const post = (body: Record<string, unknown>) =>
    harness.app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input', payload: body });
  const spies = () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    return { session, viaMux: vi.spyOn(session, 'writeViaMux'), direct: vi.spyOn(session, 'write') };
  };
  const LONG_PROMPT =
    'Reply with only the word ok and nothing else, this sentence is padding to reach about one hundred chars.\r';

  it('sends a prompt with no useMux through the mux, not as one burst', async () => {
    const { viaMux, direct } = spies();

    const res = await post({ input: LONG_PROMPT });

    expect(res.statusCode).toBe(200);
    expect(viaMux).toHaveBeenCalledWith(LONG_PROMPT, { fromUser: true });
    expect(direct).not.toHaveBeenCalled();
  });

  it('an agent\u2019s send (the request names its calling session) asks for the OpenCode shell-mode guard; a person\u2019s typing does not', async () => {
    const { viaMux } = spies();
    await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/input',
      headers: { 'x-reverie-parent-session': '0000002d-0035-4000-8000-000000000047' },
      payload: { input: LONG_PROMPT },
    });
    // An agent's write also answers to a plan move's hold at the write itself (agentInput, plan-move-input-hold.test.ts).
    expect(viaMux).toHaveBeenLastCalledWith(LONG_PROMPT, expect.objectContaining({ fromUser: true, opencodeGuard: true, agentInput: true }));
    await post({ input: LONG_PROMPT });
    expect(viaMux).toHaveBeenLastCalledWith(LONG_PROMPT, { fromUser: true });
  });

  it('an agent\u2019s text for an OpenCode pane has its ! made fullwidth even on the direct-write fallback; a person\u2019s is untouched', async () => {
    const { session, viaMux, direct } = spies();
    (session as unknown as { mode: string }).mode = 'opencode';
    viaMux.mockResolvedValue(false);
    const text = `${LONG_PROMPT.slice(0, -1)}!\r`;
    await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/input',
      headers: { 'x-reverie-parent-session': '0000002d-0035-4000-8000-000000000047' },
      payload: { input: text },
    });
    expect(direct).toHaveBeenLastCalledWith(text.replace('!', '\uFF01'), expect.objectContaining({ fromUser: true, agentInput: true }));
    await post({ input: text });
    expect(direct).toHaveBeenLastCalledWith(text, { fromUser: true });
    // a Claude pane keeps its ! for everyone
    (session as unknown as { mode: string }).mode = 'claude';
    await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/input',
      headers: { 'x-reverie-parent-session': '0000002d-0035-4000-8000-000000000047' },
      payload: { input: text },
    });
    expect(direct).toHaveBeenLastCalledWith(text, expect.objectContaining({ fromUser: true, agentInput: true }));
  });

  it('answers only once the mux write is done, so the next frame cannot overtake it', async () => {
    // The browser's POST fallback sends frames one at a time and waits for each 2xx;
    // a fire-and-forget write here would let its next keystroke land before the Enter.
    const { viaMux } = spies();
    let finished = false;
    viaMux.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return true;
    });

    await post({ input: 'ok\r', clientId: 'browser-1', seq: 1 });

    expect(finished).toBe(true);
  });

  it('falls back to the direct write when the mux write fails', async () => {
    const { viaMux, direct } = spies();
    viaMux.mockResolvedValue(false);

    await post({ input: 'hello\r' });

    expect(direct).toHaveBeenCalledWith('hello\r', { fromUser: true });
  });

  it('keeps the raw write for an explicit useMux: false', async () => {
    const { viaMux, direct } = spies();

    await post({ input: LONG_PROMPT, useMux: false });

    expect(direct).toHaveBeenCalledWith(LONG_PROMPT, { fromUser: true });
    expect(viaMux).not.toHaveBeenCalled();
  });

  it.each([
    ['a bare Enter', '\r'],
    ['text with no Enter', 'hello'],
    ['an arrow key', '\x1b[A'],
    ['a bracketed paste frame', '\x1b[200~line one\nline two\x1b[201~'],
    ['a line feed inside', 'line one\nline two\r'],
    ['two Enters', 'hello\r\r'],
    ['a tab', 'a\tb\r'],
  ])('leaves %s on the direct write', async (_label, input) => {
    const { viaMux, direct } = spies();

    await post({ input });

    expect(direct).toHaveBeenCalledWith(input, { fromUser: true });
    expect(viaMux).not.toHaveBeenCalled();
  });
});

describe('isPlainPromptInput', () => {
  it('accepts printable text ending in exactly one carriage return', () => {
    expect(isPlainPromptInput('run the tests\r')).toBe(true);
    expect(isPlainPromptInput('ünïcødé and emoji 🚀\r')).toBe(true);
  });

  it('refuses anything carrying another control character', () => {
    for (const input of ['\r', 'x', 'x\n', 'x\r\n', 'x\r\r', '\x1b[Ax\r', 'a\tb\r', 'x\x7f\r', 'x\u009b\r', '\rx']) {
      expect(isPlainPromptInput(input), JSON.stringify(input)).toBe(false);
    }
  });
});

describe('POST /api/sessions/:id/input ifIdle (agent wake)', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };
  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });
  afterEach(async () => {
    await harness.app.close();
  });
  const post = (body: Record<string, unknown>) =>
    harness.app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input', payload: body });

  it('refuses a working session before typing or spending the seq', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.isWorking = true;
    const res = await post({ input: 'wake\r', useMux: true, clientId: 'w1', seq: 1, ifIdle: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe(ApiErrorCode.SESSION_BUSY);
    expect(session.writeBuffer).toEqual([]);
    expect(session.shouldApplyInput('w1', 1)).toBe(true);
  });

  it('writes an idle session through the mux with an empty composer required and no raw fallback', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    const mux = vi.spyOn(session, 'writeViaMux').mockResolvedValue(false);
    const raw = vi.spyOn(session, 'write');
    const res = await post({ input: 'wake\r', useMux: true, clientId: 'w2', seq: 1, ifIdle: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ delivered: false }); // not an empty "accepted" body
    expect(mux).toHaveBeenCalledWith('wake\r', expect.objectContaining({ requireEmptyComposer: true }));
    expect(raw).not.toHaveBeenCalled();
    expect(session.shouldApplyInput('w2', 1)).toBe(true); // refused write leaves the seq retryable
  });
});

describe('terminal viewer delivery never establishes native worker death', () => {
  let harness: Awaited<ReturnType<typeof createEnvelopeHarness>>;
  beforeEach(async () => { harness = await createEnvelopeHarness(); });
  afterEach(async () => {
    sessionWaits.cancelAll('test-session-1');
    _resetPaneLivenessState();
    await harness.app.close();
  });
  const post = (extra: Record<string, unknown> = {}) => harness.app.inject({
    method: 'POST', url: '/api/sessions/test-session-1/input',
    payload: { input: 'test\r', clientId: 'viewer-client', seq: 1, wait: true, waitTimeout: 1, ...extra },
  });
  const terminal = () => Object.assign(harness.ctx.sessions.get('test-session-1')!, {
    runtimeHealthScope: 'terminal', viewerInputHeld: false,
  });

  it.each(['dead-pane', 'held-input', 'missing-client'])('refuses %s before any write and keeps the seq retryable', async (cause) => {
    const session = terminal();
    Object.assign(harness.ctx.mux, { isPaneDead: () => cause === 'dead-pane' });
    if (cause === 'held-input') session.viewerInputHeld = true;
    if (cause === 'missing-client') session.pid = null;
    const mux = vi.spyOn(session, 'writeViaMux'), raw = vi.spyOn(session, 'write');
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe(ApiErrorCode.SESSION_BUSY);
    expect(res.json().error).toMatch(/viewer unavailable.*nothing was typed/i);
    expect(res.json().error).not.toMatch(/worker.*(?:dead|running)|restart/i);
    expect(mux).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    expect(session.shouldApplyInput('viewer-client', 1)).toBe(true);
  });

  it('does not type during a stale-dead observation; after repair the same seq types only once', async () => {
    const session = terminal();
    let dead = true;
    Object.assign(harness.ctx.mux, { isPaneDead: () => dead });
    const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async () => { dead = false; return true; });
    expect((await post()).statusCode).toBe(409);
    expect(mux).not.toHaveBeenCalled();
    dead = false;
    _resetPaneLivenessState();
    expect((await post()).json().data.delivered).toBe(true);
    expect((await post()).json().data.duplicate).toBe(true);
    expect(mux).toHaveBeenCalledTimes(1);
  });

  it('retains an uncertain attempted seq, never raw-falls-back or calls its duplicate applied', async () => {
    const session = terminal();
    Object.assign(harness.ctx.mux, { isPaneDead: () => false });
    const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async () => {
      session.writeBuffer.push('partial text without confirmed Enter');
      return false;
    });
    const raw = vi.spyOn(session, 'write');
    const first = await post();
    expect(first.json().success).toBe(false);
    expect(first.json().error).toMatch(/unconfirmed/i);
    expect(raw).not.toHaveBeenCalled();
    expect(session.shouldApplyInput('viewer-client', 1)).toBe(false);
    for (const wait of [true, false]) {
      const retry = await post({ wait });
      expect(retry.json().success).toBe(false);
      expect(retry.json().error).toMatch(/unconfirmed/i);
    }
    expect(mux).toHaveBeenCalledTimes(1);
    expect(session.writeBuffer).toEqual(['partial text without confirmed Enter']);
  });

  it('an in-flight duplicate cannot report applied before the original write settles', async () => {
    const session = terminal();
    Object.assign(harness.ctx.mux, { isPaneDead: () => false });
    let finish!: (ok: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(() => {
      entered();
      return new Promise<boolean>((resolve) => { finish = resolve; });
    });
    const pending = post().then((res) => res);
    await started;
    const duplicate = await post();
    expect(duplicate.json().success).toBe(false);
    expect(duplicate.json().error).toMatch(/unconfirmed/i);
    finish(true);
    expect((await pending).json().data.delivered).toBe(true);
    expect((await post()).json().data.duplicate).toBe(true);
    expect(mux).toHaveBeenCalledTimes(1);
  });

  it('a fire-and-forget mux failure never replays through the raw fallback', async () => {
    const session = terminal();
    const mux = vi.spyOn(session, 'writeViaMux').mockResolvedValue(false);
    const raw = vi.spyOn(session, 'write');
    await post({ wait: false, useMux: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(raw).not.toHaveBeenCalled();
    expect((await post({ wait: false })).json().error).toMatch(/unconfirmed/i);
    expect(mux).toHaveBeenCalledTimes(1);
    expect(session.shouldApplyInput('viewer-client', 1)).toBe(false);
  });

  it('an awaited non-waiting failure reports uncertainty and keeps its seq spent', async () => {
    const session = terminal();
    vi.spyOn(session, 'writeViaMux').mockRejectedValue(new Error('transport closed after possible text'));
    const raw = vi.spyOn(session, 'write');
    const res = await post({ wait: false });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/unconfirmed/i);
    expect(session.shouldApplyInput('viewer-client', 1)).toBe(false);
    expect(raw).not.toHaveBeenCalled();
  });

  it('a known successful older input stays distinct from a later uncertain input', async () => {
    const session = terminal();
    const mux = vi.spyOn(session, 'writeViaMux').mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await post()).json().data.delivered).toBe(true);
    expect((await post({ seq: 2 })).json().error).toMatch(/unconfirmed/i);
    expect((await post()).json().data.duplicate).toBe(true);
    expect((await post({ seq: 2 })).json().error).toMatch(/unconfirmed/i);
    expect(mux).toHaveBeenCalledTimes(2);
  });

  it('never upgrades a duplicate with missing or evicted receipt knowledge to applied', async () => {
    const session = terminal();
    session.shouldApplyInput('viewer-client', 1); // Another input path owns this seq; this route has no delivery proof.
    expect((await post({ wait: false })).json().error).toMatch(/unconfirmed/i);
    for (let seq = 2; seq <= 258; seq++) await post({ seq, wait: false, useMux: false });
    expect(session.writeBuffer).toHaveLength(257);
    expect((await post({ seq: 2, wait: false })).json().error).toMatch(/unconfirmed/i);
    expect((await post({ seq: 258 })).json().data.duplicate).toBe(true);
    expect(session.writeBuffer).toHaveLength(257);
  });

  it('keeps typed-unsent text and its seq without a fallback Enter or duplicate replay', async () => {
    const session = terminal();
    const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async (_input, options) => {
      session.writeBuffer.push('unsent draft');
      (options as { onTypedUnsent?: () => void }).onTypedUnsent?.();
      return false;
    });
    const raw = vi.spyOn(session, 'write');
    expect((await post()).json().error).toMatch(/unconfirmed/i);
    expect((await post()).json().error).toMatch(/unconfirmed/i);
    expect(session.writeBuffer).toEqual(['unsent draft']);
    expect(mux).toHaveBeenCalledTimes(1);
    expect(raw).not.toHaveBeenCalled();
    expect(session.shouldApplyInput('viewer-client', 1)).toBe(false);
  });

  it('a direct provider-scope dead pane retains its existing explicit death result', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    Object.assign(session, { runtimeHealthScope: 'provider' });
    Object.assign(harness.ctx.mux, { isPaneDead: () => true });
    const res = await post();
    expect(res.json().success).toBe(true);
    expect(res.json().data).toMatchObject({ workerDead: true, delivered: false });
    expect(session.shouldApplyInput('viewer-client', 1)).toBe(true);
  });

  it('completion interrupted by a viewer exit does not describe the native provider as exited', async () => {
    const session = terminal();
    Object.assign(harness.ctx.mux, { isPaneDead: () => false });
    vi.spyOn(session, 'writeViaMux').mockImplementation(async () => {
      sessionWaits.notifySignal(session.id, 'exit');
      return true;
    });
    const res = await post();
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/completion.*unconfirmed/i);
    expect(res.json().error).not.toMatch(/restart|worker.*dead/i);
    expect(session.shouldApplyInput('viewer-client', 1)).toBe(false);
  });

  it('the existing CLI consumes actual viewer refusal envelopes without its dead-worker/restart branch', async () => {
    const session = terminal();
    session.viewerInputHeld = true;
    const errors: string[] = [];
    const deps: AgentDeps = {
      ctx: { apiUrl: 'http://unused.invalid', selfId: '00000004-0004-4000-8000-000000000004' },
      io: { out: () => {}, err: (message) => errors.push(message) },
      request: async (_ctx, options) => {
        const response = await harness.app.inject({
          method: options.method, url: options.path.replace('/api/v1/', '/api/'),
          ...(options.body ? { payload: options.body } : {}),
        });
        return { status: response.statusCode, json: response.json(), text: response.body };
      },
    };
    expect(await agentSend(deps, { id: session.id, text: 'fixture', enter: true, wait: true })).toBe(EXIT.error);
    expect(await agentSend(deps, { id: session.id, text: 'fixture', enter: true, wait: true, ifIdle: true })).toBe(EXIT.refused);
    expect(errors.join('\n')).toMatch(/viewer unavailable/i);
    expect(errors.join('\n')).not.toMatch(/no live worker|pane exited|restart/i);
    expect(session.writeBuffer).toEqual([]);
  });
});
