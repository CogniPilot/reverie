/**
 * @fileoverview The "provider launch outcome is unconfirmed" input hold reconciles itself
 * from the session's own pane, and the verified owner settles what the office cannot read.
 *
 * Three layers: the pure rule (provider-hold-reconcile.ts), the real Session against a
 * fake multiplexer, and the owner route's authorization. The launch fence
 * (`providerDispatchHeld`) is asserted unchanged throughout: only input is reconciled.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Session, ProviderDispatchUnconfirmedError } from '../src/session.js';
import { TerminalInputService } from '../src/web/terminal-input-service.js';
import { registerProviderHoldRoutes } from '../src/web/routes/provider-hold-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import {
  decideProviderHold,
  providerInputHeldBody,
  providerScreenEvidence,
  PROVIDER_INPUT_HELD_CODE,
  PROVIDER_NOT_RUNNING_CODE,
  type ProviderHoldEvidence,
} from '../src/provider-hold-reconcile.js';
import type { TerminalMultiplexer, MuxSession } from '../src/mux-interface.js';
import type { PaneLiveness } from '../src/signal-target.js';

const CLAUDE_COMPOSER = ['╭────────╮', '│ ❯      │', '╰────────╯', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
const CLAUDE_WORKING = ['✻ Actualizing… (13m 23s · ↓ 4.1k tokens)', '❯ '].join('\n');
const BARE_SHELL = 'worker@laptop:~/case$ ';

const live = (pid = 41): PaneLiveness => ({ state: 'live', pid });
const evidence = (over: Partial<ProviderHoldEvidence> = {}): ProviderHoldEvidence => ({
  before: live(),
  after: live(),
  registeredPid: 41,
  screen: 'composer',
  paneIsProvider: true,
  ...over,
});

describe('the reconciliation rule', () => {
  it('reads the working line and the composer mark off a capture, and nothing else', () => {
    const claude = { composerReadyMark: 'shift+tab', workingLine: /…\s*\((?:\d+m\s+)?\d+s\b|esc to interrupt/ };
    expect(providerScreenEvidence(CLAUDE_COMPOSER, claude)).toBe('composer');
    expect(providerScreenEvidence(CLAUDE_WORKING, claude)).toBe('working-line');
    expect(providerScreenEvidence(BARE_SHELL, claude)).toBe('none');
    expect(providerScreenEvidence('❯ ', claude)).toBe('none'); // The glyph alone is also a shell prompt.
    expect(providerScreenEvidence(null, claude)).toBe('none');
    expect(providerScreenEvidence(CLAUDE_COMPOSER, {})).toBe('none'); // A CLI declaring neither is unobservable.
  });

  it('confirms a live pane whose screen shows the composer or the working line', () => {
    expect(decideProviderHold('auto', evidence())).toEqual({ outcome: 'confirmed', source: 'screen', evidence: 'composer' });
    expect(decideProviderHold('auto', evidence({ screen: 'working-line' }))).toEqual({
      outcome: 'confirmed',
      source: 'screen',
      evidence: 'working-line',
    });
  });

  it('resolves an exited provider pane to not running, but never an exited viewer', () => {
    expect(decideProviderHold('auto', evidence({ before: { state: 'dead' }, after: { state: 'dead' } }))).toEqual({
      outcome: 'not-running',
      evidence: 'pane-exited',
    });
    // The pane died between the two reads: the screen that was captured proves nothing.
    expect(decideProviderHold('auto', evidence({ after: { state: 'dead' } })).outcome).toBe('not-running');
    expect(
      decideProviderHold('auto', evidence({ before: { state: 'dead' }, after: { state: 'dead' }, paneIsProvider: false }))
    ).toEqual({ outcome: 'held', reason: 'viewer-pane-exited' });
  });

  it.each([
    ['an unreadable pane', evidence({ before: { state: 'unreadable' } }), 'pane-unreadable'],
    ['a missing pane', evidence({ after: { state: 'missing' } }), 'pane-unreadable'],
    ['an ambiguous pane', evidence({ before: { state: 'ambiguous' } }), 'pane-unreadable'],
    ['a pane that is not the registered one', evidence({ registeredPid: 7 }), 'pane-changed'],
    ['a pane replaced during the read', evidence({ after: live(42) }), 'pane-changed'],
    ['an unregistered pane', evidence({ registeredPid: undefined }), 'pane-changed'],
    ['a live pane showing no agent', evidence({ screen: 'none' }), 'provider-not-visible'],
  ] as const)('keeps the hold for %s', (_name, observed, reason) => {
    expect(decideProviderHold('auto', observed)).toEqual({ outcome: 'held', reason });
  });

  it("takes the owner's word for the screen only, never for the pane", () => {
    expect(decideProviderHold('running', evidence({ screen: 'none' }))).toEqual({
      outcome: 'confirmed',
      source: 'owner',
      evidence: 'owner-attested',
    });
    expect(decideProviderHold('running', evidence({ before: { state: 'unreadable' } }))).toEqual({
      outcome: 'held',
      reason: 'pane-unreadable',
    });
    expect(decideProviderHold('running', evidence({ after: live(42) }))).toEqual({ outcome: 'held', reason: 'pane-changed' });
    expect(decideProviderHold('running', evidence({ before: { state: 'dead' }, after: { state: 'dead' } })).outcome).toBe('not-running');
    // Withdrawing input needs no corroboration.
    expect(decideProviderHold('not-running', evidence())).toEqual({ outcome: 'not-running', evidence: 'owner-attested' });
  });

  it('names the supported action in the refusal instead of a dead end', () => {
    const body = providerInputHeldBody('abc 1', { outcome: 'held', reason: 'provider-not-visible' });
    expect(body).toMatchObject({
      success: false,
      errorCode: 'CONFLICT',
      recoveryRequired: true,
      code: PROVIDER_INPUT_HELD_CODE,
      reason: 'provider-not-visible',
      allowedActions: ['confirm-provider-running', 'report-provider-not-running', 'recheck-terminal'],
      reconcile: {
        method: 'POST',
        path: '/api/sessions/abc%201/provider-hold',
        requires: 'verified-owner',
        body: { 'confirm-provider-running': { observation: 'running' } },
      },
    });
    expect(body.error).toContain('Provider launch outcome is unconfirmed');
    expect(body.error).not.toContain('not yet implemented');
    expect(providerInputHeldBody('s', { outcome: 'not-running', evidence: 'pane-exited' }).code).toBe(PROVIDER_NOT_RUNNING_CODE);
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

/** A real Session on a fake multiplexer. `kind` picks how the launch denial arose. */
async function heldSession(kind: 'intrinsic' | 'loaded-intent' = 'loaded-intent') {
  const dir = await mkdtemp(join(tmpdir(), 'provider-hold-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const subject: MuxSession = {
    sessionId: randomUUID(),
    muxName: 'reverie-held',
    pid: 41,
    owner: undefined,
    workingDir: dir,
    createdAt: Date.now(),
    mode: 'claude',
    attached: true,
  };
  const pane: { state: PaneLiveness['state']; screen: string | null } = { state: 'live', screen: CLAUDE_COMPOSER };
  const mux = {
    isAvailable: () => true,
    muxSessionExists: vi.fn(() => true),
    isPaneDead: vi.fn(() => pane.state === 'dead'),
    getSession: (id: string) => (id === subject.sessionId ? subject : null),
    readPaneLiveness: vi.fn(async (): Promise<PaneLiveness> => (pane.state === 'live' ? { state: 'live', pid: subject.pid } : { state: pane.state })),
    capturePaneText: vi.fn(() => pane.screen),
    sendInput: vi.fn(),
    clearPaneExit: vi.fn(),
  };
  const session = new Session({
    id: subject.sessionId,
    workingDir: dir,
    mode: 'claude',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: subject,
    // An office restart: the saved launch intent has no live owner in the new process.
    ...(kind === 'intrinsic' ? { providerDispatchHeld: true } : { publicationStore: { providerLaunchHeldFor: () => true } as never }),
  });
  cleanups.push(async () => {
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
  });
  return { session, mux, subject, pane };
}

describe('a held session', () => {
  it.each(['loaded-intent', 'intrinsic'] as const)('releases a %s input hold when its live pane shows the composer', async (kind) => {
    const f = await heldSession(kind);
    expect(f.session.providerDispatchHoldKind).toBe(kind);
    expect(f.session.providerInputHeld).toBe(true);
    await expect(f.session.reconcileProviderHold()).resolves.toEqual({ outcome: 'confirmed', source: 'screen', evidence: 'composer' });
    expect(f.session.providerInputHeld).toBe(false);
    expect(f.session.providerPresence).toBe('screen');
    expect(f.session.toState()).toMatchObject({ providerInputHeld: false, providerPresence: 'screen', providerDispatchHeld: true, providerDispatchHoldKind: kind });
    expect(Object.hasOwn(f.session.toPersistedState(), 'providerPresence')).toBe(false);
    // The launch fence is a different latch and is not touched: no restart is admitted by a screen reading.
    expect(f.session.providerDispatchHeld).toBe(true);
    expect(() => f.session.assertProviderLaunchAdmission()).toThrow(ProviderDispatchUnconfirmedError);
    if (kind === 'intrinsic') expect(f.session.toPersistedState().providerDispatchHeld).toBe(true);
  });

  it('accepts input after reconciliation and holds nothing from before it', async () => {
    const f = await heldSession();
    const inputs = new TerminalInputService();
    const refused = inputs.begin(f.session, { input: 'interrupted earlier\r', clientId: 'c', seq: 1 }, () => true);
    expect(refused).toEqual({ state: 'held' });
    await f.session.reconcileProviderHold();
    // Reconciling typed nothing: the refused request left no receipt and no pane write behind.
    expect(f.mux.sendInput).not.toHaveBeenCalled();
    const admitted = inputs.begin(f.session, { input: 'new prompt\r', clientId: 'c', seq: 2 }, () => true);
    expect(admitted.state).toBe('admitted');
    expect(f.session.captureInputAdmission()()).toBe(true);
    if (admitted.state === 'admitted') admitted.operation.refuse();
  });

  it('keeps the hold when the pane is live but shows no agent, until the owner says it is running', async () => {
    const f = await heldSession();
    f.pane.screen = BARE_SHELL;
    await expect(f.session.reconcileProviderHold()).resolves.toEqual({ outcome: 'held', reason: 'provider-not-visible' });
    expect(f.session.providerInputHeld).toBe(true);
    expect(f.session.providerHoldLastReconciliation).toEqual({ outcome: 'held', reason: 'provider-not-visible' });
    await expect(f.session.reconcileProviderHold('running')).resolves.toEqual({ outcome: 'confirmed', source: 'owner', evidence: 'owner-attested' });
    expect(f.session.providerInputHeld).toBe(false);
    expect(f.session.providerPresence).toBe('owner');
    expect(f.session.providerDispatchHeld).toBe(true);
  });

  it('keeps the hold for an unreadable pane even on the owner\'s word', async () => {
    const f = await heldSession();
    f.pane.state = 'unreadable';
    await expect(f.session.reconcileProviderHold()).resolves.toEqual({ outcome: 'held', reason: 'pane-unreadable' });
    await expect(f.session.reconcileProviderHold('running')).resolves.toEqual({ outcome: 'held', reason: 'pane-unreadable' });
    f.mux.readPaneLiveness.mockRejectedValueOnce(new Error('tmux went away'));
    await expect(f.session.reconcileProviderHold()).resolves.toEqual({ outcome: 'held', reason: 'pane-unreadable' });
    expect(f.session.providerInputHeld).toBe(true);
  });

  it('resolves an exited local pane to not running and keeps both input and launch fenced', async () => {
    const f = await heldSession();
    f.pane.state = 'dead';
    await expect(f.session.reconcileProviderHold()).resolves.toEqual({ outcome: 'not-running', evidence: 'pane-exited' });
    expect(f.session.providerInputHeld).toBe(true);
    expect(f.session.providerDispatchHeld).toBe(true);
    expect(f.mux.capturePaneText).not.toHaveBeenCalled();
  });

  it('does not read an exited viewer pane as the agent having stopped', async () => {
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/fixture/broker.sock'); // The pane only views a provider in a laptop.
    const f = await heldSession();
    f.pane.state = 'dead';
    await expect(f.session.reconcileProviderHold()).resolves.toEqual({ outcome: 'held', reason: 'viewer-pane-exited' });
    expect(f.session.providerInputHeld).toBe(true);
  });

  it('lapses with the pane it observed, and with the owner saying the agent is not running', async () => {
    const f = await heldSession();
    await f.session.reconcileProviderHold();
    expect(f.session.providerInputHeld).toBe(false);
    f.subject.pid = 99; // The pane was replaced: the observation was of another process.
    expect(f.session.providerInputHeld).toBe(true);
    expect(f.session.providerPresence).toBeUndefined();
    await f.session.reconcileProviderHold();
    expect(f.session.providerInputHeld).toBe(false);
    await expect(f.session.reconcileProviderHold('not-running')).resolves.toEqual({ outcome: 'not-running', evidence: 'owner-attested' });
    expect(f.session.providerInputHeld).toBe(true);
    expect(f.session.providerDispatchHeld).toBe(true);
  });

  it('has nothing to reconcile without a pane or without a hold', async () => {
    const f = await heldSession();
    Object.assign(f.session, { _muxSession: null });
    await expect(f.session.reconcileProviderHold('running')).resolves.toEqual({ outcome: 'held', reason: 'no-terminal' });
    expect(f.session.providerInputHeld).toBe(true);
    const free = new Session({ workingDir: f.session.workingDir, mode: 'claude', publicationStore: { providerLaunchHeldFor: () => false } as never });
    cleanups.push(() => free.stop(false));
    await expect(free.reconcileProviderHold('running')).resolves.toEqual({ outcome: 'not-held' });
  });
});

describe('POST /api/sessions/:id/provider-hold', () => {
  async function routes() {
    const f = await heldSession();
    f.pane.screen = BARE_SHELL; // Unobservable: only the owner can settle it.
    const ctx = {
      sessions: new Map([[f.session.id, f.session]]),
      getSessionStateWithRespawn: (session: Session) => session.toState(),
      broadcast: vi.fn(),
    };
    const app = Fastify();
    installRouteErrorHandler(app);
    registerProviderHoldRoutes(app, ctx as never, (req) => req.headers.cookie === 'fixture-owner=yes');
    await app.ready();
    cleanups.push(() => app.close());
    const url = `/api/sessions/${f.session.id}/provider-hold`;
    const post = (payload: unknown, headers: Record<string, string> = { cookie: 'fixture-owner=yes' }) =>
      app.inject({ method: 'POST', url, headers, payload: payload as never });
    return { ...f, app, ctx, url, post };
  }

  it('refuses anyone but the verified owner, and an agent even with owner credentials', async () => {
    const f = await routes();
    for (const headers of [{}, { cookie: 'someone-else=yes' }, { cookie: 'fixture-owner=yes', 'x-reverie-parent-session': f.session.id }]) {
      const res = await f.post({ observation: 'running' }, headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
      expect((await f.app.inject({ method: 'GET', url: f.url, headers })).statusCode).toBe(403);
    }
    expect(f.session.providerInputHeld).toBe(true);
    expect(f.mux.readPaneLiveness).not.toHaveBeenCalled();
    expect(f.ctx.broadcast).not.toHaveBeenCalled();
  });

  it("releases input on the owner's attestation and announces it", async () => {
    const f = await routes();
    const checked = await f.post({ observation: 'auto' });
    expect(checked.json().data).toMatchObject({ outcome: 'held', reason: 'provider-not-visible', inputHeld: true, launchHeld: true });
    expect(f.ctx.broadcast).not.toHaveBeenCalled();
    const res = await f.post({ observation: 'running' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      data: { outcome: 'confirmed', source: 'owner', sessionId: f.session.id, inputHeld: false, launchHeld: true, holdKind: 'loaded-intent', presence: 'owner' },
    });
    expect(f.session.providerInputHeld).toBe(false);
    expect(f.ctx.broadcast).toHaveBeenCalledWith('session:updated', { session: expect.objectContaining({ providerInputHeld: false, providerPresence: 'owner' }) });
    const status = await f.app.inject({ method: 'GET', url: f.url, headers: { cookie: 'fixture-owner=yes' } });
    expect(status.json().data).toMatchObject({ inputHeld: false, launchHeld: true, lastReconciliation: { outcome: 'confirmed', source: 'owner' } });
    const withdrawn = await f.post({ observation: 'not-running' });
    expect(withdrawn.json().data).toMatchObject({ outcome: 'not-running', inputHeld: true, launchHeld: true });
    expect(f.session.providerInputHeld).toBe(true);
  });

  it('rejects an unknown observation and an unknown session', async () => {
    const f = await routes();
    expect((await f.post({ observation: 'definitely' })).statusCode).toBe(400);
    expect((await f.post({ observation: 'running', force: true })).statusCode).toBe(400);
    const missing = await f.app.inject({ method: 'POST', url: '/api/sessions/nope/provider-hold', headers: { cookie: 'fixture-owner=yes' }, payload: { observation: 'running' } });
    expect(missing.statusCode).toBe(404);
    expect(f.session.providerInputHeld).toBe(true);
  });
});
