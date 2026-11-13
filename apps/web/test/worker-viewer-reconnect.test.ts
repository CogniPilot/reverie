import { acknowledgeMuxFixture } from './helpers/acknowledged-mux-fixture.js';
import { getStore } from '../src/state-store.js';
import {WorkerProviderHealth} from '../src/worker-provider-health.js';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { Session } from '../src/session.js';
import type {MuxSession, RespawnPaneOptions} from '../src/mux-interface.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import type { CompanyEmployee } from '../src/company-types.js';
import { WorkerViewerReconnect, registerWorkerViewerReconnect } from '../src/worker-viewer-reconnect.js';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';
import { PlanMoves, type PlanMovePort, type PlanMoveRecord } from '../src/plan-move.js';
import { planMoveExecutor, type PlanMoveRuntime } from '../src/plan-move-runtime.js';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
import {frontendClassMethods} from './helpers/frontend-declarations.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { FixtureLocks } from './helpers/browser-input-fixture.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/fixture/worker.sock');
  const dir = await mkdtemp(join(tmpdir(), 'viewer-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let dead = true;
  const registered = new Map<string,MuxSession>();
  const mux = { isAvailable: () => true, muxSessionExists: () => true,
    getSession: (id:string) => registered.get(id),
    isPaneDead: vi.fn(() => dead), readPaneLiveness: vi.fn(async (_name:string) => dead ? { state: 'dead' } : { state: 'live', pid: 42 }),
    respawnPane: vi.fn(async (_options: RespawnPaneOptions) => { dead = false; return 42; }), clearPaneExit: vi.fn(),
    capturePaneText: vi.fn(() => '›\nGPT-6.1-Sol high · /work\n? for shortcuts'), sendInput: vi.fn(), setAttached: vi.fn() };
  const id = randomUUID(), subject = {muxName:'reverie-owned',sessionId:id,pid:41} as MuxSession;
  const session = new Session({id, workingDir: dir, mode: 'codex', useMux: true, mux: mux as never,
    muxSession: subject });
  registered.set(id,subject);
  Object.assign(session, { ptyProcess: { pid: 123 }, _pid: 123 });
  cleanups.push(async () => {
    const client = (session as any).ptyProcess;
    if (client?.kill) await new Promise<void>((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('Owned inert PTY did not settle')),2_000);
      client.onExit(()=>{clearTimeout(timer);resolve();});client.kill();
    });
    Object.assign(session, { ptyProcess: null, _muxSession: null }); await session.stop(false);
  });
  session.setPaneExit({ status: 1, at: 123 });
  const store = new CompanyStore(join(dir, 'company.json')); await store.init();
  const company = new CompanyService(store, { getSession: id => id === session.id ? session : undefined,
    chatrooms: { rooms: () => [] }, research: {} } as never);
  const employee = await company.hire({ name: 'Alex', icon: 'A', position: 'Engineer', expertise: ['systems'],
    sessionId: session.id, researchEnabled: false } as never);
  await company.setDesiredRunning(session.id, true);
  let blocked = false, ready = true, healthy = true, clock = 100;
  const release = vi.fn(), pause = vi.fn(() => release), publish = vi.fn();
  const deps = { company, session: (id: string) => id === session.id ? session : undefined,
    ready: () => ready, providerHealthy: vi.fn(() => healthy),
    moveGuard: vi.fn(async () => () => !blocked), pause, publish, now: () => clock };
  const controller = new WorkerViewerReconnect(deps);
  const expected = { sessionId: session.id, sessionGeneration: employee.sessionGeneration };
  return { dir, session, mux, registered, store, company, employee, controller, deps, expected, release,
    block: () => { blocked = true; }, drain: () => { ready = false; },
    health: (value: boolean) => { healthy = value; }, advance: (ms = 20_000) => { clock += ms; } };
}

it('repairs only the saved viewer with an atomic attach-only respawn and fresh live readback', async () => {
  const f = await fixture(); const before = f.session.toState();
  const hooks = vi.spyOn(f.session, 'applyFullAccessDefault');
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('connected');
  expect(f.mux.respawnPane).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    sessionId: f.session.id, workerAttachOnly: true, onlyIfDead: true, stillCurrent: expect.any(Function) }));
  expect(f.mux.readPaneLiveness).toHaveBeenCalledTimes(3);
  expect(f.session.paneExit).toBeUndefined(); expect(f.session.runtimeHealth).toBe('unknown');
  expect(f.session.toState().codexConfig).toEqual(before.codexConfig);
  expect(hooks).not.toHaveBeenCalled(); expect(f.mux.sendInput).not.toHaveBeenCalled();
  expect(f.deps.publish).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
});

it.each(['missing','invalid'] as const)('reports %s original viewer custody with unknown provider health through the authorized API and GUI without clearing input holds', async kind => {
  const f = await fixture();
  f.health(false); diagnosticEndpoint(f);
  const original = {...(f.session as unknown as {_muxSession:MuxSession})._muxSession};
  const manager = new TmuxManager(); cleanups.push(async () => manager.destroy());
  // A manually/restored record has no product launch provenance, even when all
  // public fields and current global configuration look plausible.
  if (kind === 'missing') manager.registerSession(original);
  else {
    vi.stubEnv('REVERIE_WORKER_VIEWER_SOCKET','invalid-relative.sock');
    // Actual ordinary creation still needs the original Session's canonical
    // acknowledgement, even though only the physical mux is synthetic here.
    const publication = getStore().stageProviderLaunch(f.session, {
      transport: 'native-ordinary', brokerSocket: process.env.REVERIE_WORKER_SOCKET,
      current: () => true, snapshot: () => f.session.toPersistedState(),
    });
    await manager.createSession({sessionId:f.session.id,workingDir:f.dir,mode:'codex',
      owner:f.session.owner,providerLaunch:publication,providerSubject:f.session,
      onProviderDispatch:()=>publication.claim()});
  }
  f.mux.respawnPane.mockImplementationOnce(options => manager.respawnPane(options) as Promise<number>);
  const app = Fastify(); cleanups.push(() => app.close());
  registerWorkerViewerReconnect(app, f.controller, () => true);
  const response = await app.inject({method:'POST', url:`/api/company/employees/${f.employee.id}/reconnect`, payload:f.expected});
  expect(response.statusCode).toBe(409);
  const reason = kind === 'missing' ? 'viewer-endpoint-custody-unavailable' : 'viewer-endpoint-configuration-invalid';
  expect(response.json()).toMatchObject({success:false,reconnect:{reason}});
  expect(response.json().error).toContain(kind === 'missing' ? 'original viewer endpoint' : 'endpoint is invalid');
  expect(f.session.viewerInputHeld).toBe(true); expect(f.session.paneExit).toBeDefined();
  expect(f.mux.sendInput).not.toHaveBeenCalled(); expect(f.deps.publish).not.toHaveBeenCalled();
  const describe = frontendClassMethods(readFileSync(resolve('src/web/public/chat-app.js'),'utf8'), 'ReverieChatApp', ['viewerReconnectDescription']);
  const render = new Function(`return ({${describe}}).viewerReconnectDescription;`)();
  expect(render(response.json().reconnect)).toBe(kind === 'missing'
    ? 'The original terminal connection could not be verified. Recovery needs operator attention; the employee was not restarted.'
    : 'The terminal viewer configuration is invalid. Recovery needs operator attention; the employee was not restarted.');
});

function diagnosticEndpoint(f: Awaited<ReturnType<typeof fixture>>, inspect = vi.fn(async () =>
  Object.assign(() => true, { close: vi.fn(), revalidate: async () => true }))) {
  Object.assign(f.deps, { diagnosticViewer: () => true, diagnosticMoveGuard: inspect });
  return inspect;
}

it('opens only an explicit diagnostic viewer without provider health and keeps every input path fenced', async () => {
  const f = await fixture(); f.health(false);
  const inspect = diagnosticEndpoint(f);
  f.mux.capturePaneText.mockReturnValue('The provider is stopped. Inspect its existing terminal.');
  await f.controller.tick();
  expect(inspect).not.toHaveBeenCalled(); expect(f.mux.respawnPane).not.toHaveBeenCalled();
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('inspection-requested');
  expect(f.deps.moveGuard).not.toHaveBeenCalled();
  expect(inspect).toHaveBeenCalledExactlyOnceWith(f.employee.id, undefined);
  expect(f.mux.respawnPane).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workerAttachOnly: true, onlyIfDead: true }));
  expect(f.session.toState()).toMatchObject({ viewerInspectionRequested: true, viewerInputHeld: true, runtimeHealth: 'disconnected' });
  expect(f.session.paneExit).toBeDefined(); expect(f.session.write('untrusted input\r')).toBe(false);
  expect(await f.session.writeViaMux('automated input')).toBe(false); expect(f.session.canAcceptChatInput()).toBe(false);
  expect(f.mux.sendInput).not.toHaveBeenCalled();
  expect(f.controller.status(f.employee.id, f.expected)).toMatchObject({ state: 'blocked', reason: 'diagnostic-requested-readiness-unconfirmed-input-held' });
});

it('upgrades a diagnostic viewer only after independent healthy-provider and ordinary move checks', async () => {
  const f = await fixture(); f.health(false); diagnosticEndpoint(f);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('inspection-requested');
  f.health(true);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined, true)).toBe('unavailable');
  expect(f.session.viewerInputHeld).toBe(true);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('connected');
  expect(f.deps.moveGuard).toHaveBeenCalledOnce(); expect(f.mux.respawnPane).toHaveBeenCalledOnce();
  expect(f.session.viewerInspectionRequested).toBe(false); expect(f.session.viewerInputHeld).toBe(false);
});

it('inspects a historical move without source cleanup proof, altering its journal, or releasing its hold', async () => {
  const f = await fixture();
  const record: PlanMoveRecord = { id: 'historical', employeeId: f.employee.id, name: 'Synthetic expert',
    oldSession: 'historical-source', newSession: 'historical-destination', fromAccount: 'before', toAccount: 'after',
    phase: 'recovery-required', at: 1 };
  const save = vi.fn(), moves = new PlanMoves({ load: async () => [{ ...record }], save } as unknown as PlanMovePort);
  const before = await moves.get(record.id);
  f.deps.moveGuard = vi.fn(async () => moves.viewerReconnectGuard(f.employee.id));
  diagnosticEndpoint(f, vi.fn(async () => moves.viewerInspectionGuard(f.employee.id)));
  const respawn = f.mux.respawnPane.getMockImplementation()!;
  f.mux.respawnPane.mockImplementation(async (...args) => {
    await expect(moves.resolve(record.id, { oldSession: record.oldSession, newSession: record.newSession!, toAccount: record.toAccount }))
      .rejects.toThrow('still active');
    return respawn(...args);
  });
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('inspection-requested');
  expect(f.session.viewerInputHeld).toBe(true); expect(f.session.viewerInspectionRequested).toBe(true);
  expect(await moves.get(record.id)).toEqual(before); expect(save).not.toHaveBeenCalled();
  await expect(moves.assertAvailable(f.employee.id)).rejects.toThrow('already has a move');
});

it.each(['authority', 'generation', 'migration', 'endpoint', 'move'] as const)(
  'rechecks %s after diagnostic admission before any terminal effect', async change => {
    const f = await fixture(); f.health(false); let authorized = true, configured = true;
    diagnosticEndpoint(f, vi.fn(async () => {
      if (change === 'authority') authorized = false;
      if (change === 'endpoint') configured = false;
      if (change === 'generation' || change === 'migration') await f.store.update(s => {
        if (change === 'generation') s.employees[0].sessionGeneration++;
        else s.employees[0].bindingMigration = { id: 'moving', from: f.session.id, to: 'moving' };
      });
      return Object.assign(() => change !== 'move', { close: vi.fn(), revalidate: async () => true });
    }));
    Object.assign(f.deps, { diagnosticViewer: () => configured });
    expect(await f.controller.reconnect(f.employee.id, f.expected, undefined, false, () => authorized)).toBe('changed');
    expect(f.mux.respawnPane).not.toHaveBeenCalled(); expect(f.deps.pause).not.toHaveBeenCalled();
  });

it.each(['Reverie worker unavailable: VIEWER_REFUSED', 'Reverie worker: RESERVATION_ADMISSION_LOCK_BUSY'])(
  'reports a dedicated helper refusal before its outer pane exits: %s', async refusal => {
  const f = await fixture(); f.health(false); diagnosticEndpoint(f);
  f.mux.capturePaneText.mockReturnValue(refusal);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('unavailable');
  expect(f.session.viewerInputHeld).toBe(true);
  expect(f.session.viewerInspectionRequested).toBe(false); expect(f.session.paneExit).toBeDefined();
  expect(f.deps.publish).not.toHaveBeenCalled(); expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it.each(['', '›\nGPT-6.1-Sol high · /work\n? for shortcuts'])(
  'never calls a fresh diagnostic attachment ready from blank or saved output: %j', async text => {
    const f = await fixture(); f.health(false); diagnosticEndpoint(f); f.mux.capturePaneText.mockReturnValue(text);
    expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('inspection-requested');
    expect(f.controller.status(f.employee.id, f.expected).state).toBe('blocked');
    expect(f.session.runtimeHealth).toBe('disconnected'); expect(f.session.viewerInputHeld).toBe(true);
    expect(f.mux.sendInput).not.toHaveBeenCalled();
  });

it('refuses a diagnostic request whose actual attachment step exceeds its original bound', async () => {
  const f = await fixture(); f.health(false); diagnosticEndpoint(f); let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const respawn = f.mux.respawnPane.getMockImplementation()!;
  f.mux.respawnPane.mockImplementation(async (...args) => { now = 10_000; return respawn(...args); });
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('unavailable');
  expect(f.session.viewerInspectionRequested).toBe(false); expect(f.session.viewerInputHeld).toBe(true);
});

it('restores only the saved input fence, never diagnostic transport or provider readiness', async () => {
  const f = await fixture(); f.health(false); diagnosticEndpoint(f);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('inspection-requested');
  const restored = new Session({ ...f.session.toState(), workingDir: f.dir, mux: f.mux as never, useMux: true });
  try {
    expect(restored.viewerInputHeld).toBe(true); expect(restored.viewerInspectionRequested).toBe(false);
    expect(restored.write('must remain fenced')).toBe(false);
  } finally { await restored.stop(false); }
});

it.each(['success', 'account-drift', 'proof-expiry', 'readiness-failure'] as const)(
  'retained ordinary destination repair: %s never unlocks or completes its journal', async failure => {
    const f = await fixture();
    const record: PlanMoveRecord = { id: 'existing-destination', employeeId: f.employee.id, name: 'Synthetic expert',
      oldSession: 'original-source', newSession: f.session.id, fromAccount: 'before', toAccount: 'current',
      phase: 'recovery-required', at: 1, sourceStopRequested: true, sourceCleanupVerified: true };
    const save = vi.fn(), request = vi.fn(), cleanup = vi.fn(); let account = 'current';
    const runtime = { company: f.company, sessions: new Map([[f.session.id, f.session]]), mux: f.mux,
      plans: { account: vi.fn(async () => ({ id: 'current', provider: 'openai', profileId: 'current' })),
        allocations: vi.fn(async () => ({ accounts: [{ id: account, sessionIds: [f.session.id] }] })) },
      chat: { rooms: () => [] }, request, cleanup, authorized: () => true } as unknown as PlanMoveRuntime;
    const moves = new PlanMoves({ load: async () => [{ ...record }], save } as unknown as PlanMovePort);
    const originalRecord = await moves.get(record.id);
    const executor = planMoveExecutor(runtime);
    f.deps.moveGuard = vi.fn(async () => moves.viewerReconnectGuard(f.employee.id, { sessionId: f.session.id, executor }));
    const original = f.mux.respawnPane.getMockImplementation()!;
    f.mux.respawnPane.mockImplementation(async (...args) => {
      expect((await moves.get(record.id))?.phase).toBe('checking');
      await expect(moves.resolve(record.id, { oldSession: record.oldSession, newSession: f.session.id, toAccount: 'current' }))
        .rejects.toThrow('still active');
      if (failure === 'account-drift') account = 'foreign';
      if (failure === 'proof-expiry') f.health(false);
      return failure === 'readiness-failure' ? null as never : original(...args);
    });
    expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe(failure === 'success' ? 'connected' :
      ['account-drift', 'proof-expiry'].includes(failure) ? 'changed' : 'unavailable');
    expect(f.mux.respawnPane).toHaveBeenCalledOnce();
    expect(f.mux.respawnPane.mock.calls[0][0]).toMatchObject({ workerAttachOnly: true, onlyIfDead: true });
    expect(await moves.get(record.id)).toEqual(originalRecord);
    if (failure !== 'success') expect(f.session.canAcceptChatInput()).toBe(false);
    await expect(moves.assertAvailable(f.employee.id)).rejects.toThrow('already has a move');
    expect(save).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    expect(f.mux.sendInput).not.toHaveBeenCalled();
  });

it('reattaches a missing website PTY through the canonical client factory without launching a provider', async () => {
  const f = await fixture();Object.assign(f.session,{ptyProcess:null,_pid:null,_viewerClientLost:true});
  expect(f.session.runtimeHealth).toBe('disconnected');
  expect(await f.controller.reconnect(f.employee.id,f.expected,undefined)).toBe('connected');
  const pid=f.session.pid!;expect(pid).toBeGreaterThan(1);expect(pid).not.toBe(42);
  const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
  expect(argv[1]).toBe('-e');expect(argv[2]).toContain('process.stdin.pipe(process.stdout)');
  expect(f.mux.respawnPane).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({workerAttachOnly:true}));
  expect(f.session.runtimeHealth).toBe('unknown');expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it.each(['unreadable', 'dead', 'wrong-pid'] as const)('retains disconnection/input hold after %s readback; respawn exit zero is insufficient', async state => {
  const f = await fixture();
  f.mux.readPaneLiveness.mockResolvedValueOnce({ state: 'dead' });
  f.mux.readPaneLiveness.mockResolvedValue(state === 'wrong-pid' ? { state: 'live', pid: 999 } : { state } as never);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('unavailable');
  expect(f.session.runtimeHealth).toBe('disconnected'); expect(f.session.setPaneExit(undefined)).toBe(false);
  expect(f.session.canAcceptChatInput()).toBe(false); expect(await f.session.writeViaMux('do not send\r')).toBe(false);
  expect(f.mux.sendInput).not.toHaveBeenCalled(); expect(f.deps.publish).not.toHaveBeenCalled();
});

it('keeps an unready new pane held, then confirms that same incarnation without another respawn', async () => {
  const f = await fixture(); vi.useFakeTimers(); f.mux.capturePaneText.mockReturnValue('Connecting…');
  const first = f.controller.reconnect(f.employee.id, f.expected, undefined);
  await vi.advanceTimersByTimeAsync(10_250);
  expect(await first).toBe('unavailable'); expect(f.session.runtimeHealth).toBe('disconnected');
  f.mux.capturePaneText.mockReturnValue('›\nGPT-6.1-Sol high · /work\n? for shortcuts');
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('connected');
  expect(f.mux.respawnPane).toHaveBeenCalledOnce(); expect(f.session.paneExit).toBeUndefined();
});

it('deduplicates a manual request against the automatic flight and pauses all programmatic input', async () => {
  const f = await fixture(); let finish!: (pid: number) => void;
  f.mux.respawnPane.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
  const automatic = f.controller.tick();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(f.session.canAcceptChatInput()).toBe(false);
  expect(await f.session.writeViaMux('never paste this\r')).toBe(false);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('busy');
  f.mux.readPaneLiveness.mockResolvedValue({ state: 'live', pid: 42 }); finish(42); await automatic;
  expect(f.mux.respawnPane).toHaveBeenCalledOnce(); expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it('settles a pending old submit as unknown and never retries Enter into the repaired viewer', async () => {
  const f = await fixture(); vi.useFakeTimers(); const outcome = vi.fn();
  f.session.verifySubmitted('retained user draft', outcome);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('connected');
  expect(outcome).toHaveBeenCalledExactlyOnceWith('unverified');
  await vi.advanceTimersByTimeAsync(70_000);
  expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it('refuses repair while an earlier actual mux write is still settling', async () => {
  const f = await fixture(); let finish!: (sent: boolean) => void;
  f.mux.sendInput.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const write = f.session.writeViaMux('one existing write');
  expect(finish).toBeTypeOf('function'); expect(f.mux.sendInput).toHaveBeenCalledOnce();
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('unavailable');
  expect(f.mux.respawnPane).not.toHaveBeenCalled(); finish(false); await write;
});

it('waits for an old verifier Enter already in flight before repairing the viewer', async () => {
  const f = await fixture(); vi.useFakeTimers(); let finish!: (sent: boolean) => void;
  f.mux.capturePaneText.mockReturnValue('› retained draft\nGPT-6.1-Sol high · /work');
  f.mux.sendInput.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const outcome = vi.fn(); f.session.verifySubmitted('retained draft', outcome);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(finish).toBeTypeOf('function');
  expect(await f.controller.reconnect(f.employee.id,f.expected,undefined)).toBe('unavailable');
  expect(f.mux.respawnPane).not.toHaveBeenCalled(); finish(false); await vi.advanceTimersByTimeAsync(1);
  f.mux.capturePaneText.mockReturnValue('›\nGPT-6.1-Sol high · /work\n? for shortcuts');
  expect(await f.controller.reconnect(f.employee.id,f.expected,undefined)).toBe('connected');
  await vi.advanceTimersByTimeAsync(70_000);
  expect(f.mux.sendInput).toHaveBeenCalledOnce(); expect(outcome).toHaveBeenCalledExactlyOnceWith('unverified');
});

it('continues eligible attach-only failures at a capped minute interval and keeps manual fallback', async () => {
  const f = await fixture(); f.mux.respawnPane.mockResolvedValue(null as never);
  await f.controller.tick();
  let calls = 1;
  for (const delay of [2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000]) {
    f.advance(delay - 1); await f.controller.tick();
    expect(f.mux.respawnPane).toHaveBeenCalledTimes(calls);
    f.advance(1); await f.controller.tick();
    expect(f.mux.respawnPane).toHaveBeenCalledTimes(++calls);
  }
  expect(f.mux.respawnPane.mock.calls.every(([options]) => options.workerAttachOnly && options.onlyIfDead)).toBe(true);
  f.health(false);
  await f.controller.reconnect(f.employee.id, f.expected, undefined);
  expect(f.mux.respawnPane).toHaveBeenCalledTimes(calls);
  f.health(true);
  await f.controller.reconnect(f.employee.id, f.expected, undefined);
  expect(f.mux.respawnPane).toHaveBeenCalledTimes(calls + 1);
  expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it('does not spend an automatic attempt without fresh native health or after health changes during admission', async () => {
  const f = await fixture(); f.health(false);
  await f.controller.tick(); expect(f.mux.respawnPane).not.toHaveBeenCalled();
  f.health(true);
  f.deps.moveGuard.mockImplementationOnce(async () => { f.health(false); return () => true; });
  await f.controller.tick(); expect(f.mux.respawnPane).not.toHaveBeenCalled();
  expect(f.deps.pause).not.toHaveBeenCalled(); expect(f.mux.sendInput).not.toHaveBeenCalled();
  f.health(true); f.advance(2_000);
  await f.controller.tick(); expect(f.mux.respawnPane).toHaveBeenCalledOnce();
});

it('gates ongoing attempts with the real native cache expiry, binding and dead-state checks', async () => {
  const f = await fixture(); f.mux.respawnPane.mockResolvedValue(null as never);
  let epoch = 100_000, mono = 100;
  const binding = () => { const e = f.company.registeredEmployees()[0]; return JSON.parse(JSON.stringify([
    e.id,e.owner,e.sessionId,e.sessionGeneration,e.desiredRunning,e.onVacation,e.bindingMigration,e.runtimeRecipe,e.permissions])); };
  const row = { observedBinding: binding(), employeeId: f.employee.id, sessionId: f.session.id,
    sessionGeneration: f.employee.sessionGeneration, state: 'healthy', observedAtEpochMs: epoch,
    reason: 'LIVE_NATIVE_COMMAND', proofKind: 'live-container', containerId: 'a'.repeat(64), initPID: 101, initStartTick: 202 };
  const native = new WorkerProviderHealth({ employees: () => f.company.registeredEmployees(), now: () => epoch,
    monotonic: () => mono, changed() {}, query: async () => ({ providerHealth: { version: 1, purpose: 'worker-provider-health-v1', providers: [row] } }) });
  cleanups.push(async () => native.close());
  f.deps.providerHealthy = vi.fn(() => native.read(f.company.registeredEmployees()[0])?.state === 'healthy');
  await f.controller.tick(); expect(f.mux.respawnPane).not.toHaveBeenCalled();
  await native.refresh(); await f.controller.tick(); expect(f.mux.respawnPane).toHaveBeenCalledOnce();
  epoch += 25_001; mono += 25_001; f.advance(60_000);
  await f.controller.tick(); expect(f.mux.respawnPane).toHaveBeenCalledOnce();
  row.observedAtEpochMs = epoch; await native.refresh(); await f.controller.tick();
  expect(f.mux.respawnPane).toHaveBeenCalledTimes(2);
  await f.store.update(s => { s.employees[0].permissions.recoverEmployees = !s.employees[0].permissions.recoverEmployees; });
  f.advance(60_000); await f.controller.tick(); expect(f.mux.respawnPane).toHaveBeenCalledTimes(2);
  row.observedBinding = binding(); row.state = 'dead'; row.reason = 'COMMAND_EXITED'; row.observedAtEpochMs = ++epoch;
  await native.refresh(); await f.controller.tick(); expect(f.mux.respawnPane).toHaveBeenCalledTimes(2);
  expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it('keeps other eligible seats moving while one viewer remains in capped backoff', async () => {
  const first = await fixture(), next = await fixture(); first.mux.respawnPane.mockResolvedValue(null as never);
  await first.controller.tick();
  for (const delay of [2_000, 5_000, 15_000, 30_000]) { first.advance(delay); await first.controller.tick(); }
  expect(first.mux.respawnPane).toHaveBeenCalledTimes(5);
  const employees = () => [...first.company.registeredEmployees(), ...next.company.registeredEmployees()];
  first.deps.company = { registeredEmployees: employees, prepareWake: next.deps.company.prepareWake.bind(next.deps.company) } as never;
  first.deps.session = id => id === first.session.id ? first.session : id === next.session.id ? next.session : undefined;
  // The first employee's in-flight wake is held by its original company service.
  const prepare = first.company.prepareWake.bind(first.company);
  first.deps.company.prepareWake = (id, sid) => id === first.employee.id ? prepare(id, sid) : next.company.prepareWake(id, sid);
  await first.controller.tick(); expect(next.mux.respawnPane).toHaveBeenCalledOnce();
  expect(first.mux.respawnPane).toHaveBeenCalledTimes(5);
});

it('rotates failed viewers when delayed ticks make every backoff eligible', async () => {
  const first = await fixture(), next = await fixture();
  first.mux.respawnPane.mockResolvedValue(null as never); next.mux.respawnPane.mockResolvedValue(null as never);
  const prepare = first.company.prepareWake.bind(first.company);
  first.deps.company = { registeredEmployees: () => [...first.company.registeredEmployees(), ...next.company.registeredEmployees()],
    prepareWake: (id: string, sid: string) => id === first.employee.id ? prepare(id, sid) : next.company.prepareWake(id, sid) } as never;
  first.deps.session = id => id === first.session.id ? first.session : id === next.session.id ? next.session : undefined;
  for (let n = 0; n < 10; n++) {
    await first.controller.tick();
    expect(first.mux.respawnPane.mock.calls.length + next.mux.respawnPane.mock.calls.length).toBe(n + 1);
    first.advance(60_000);
  }
  expect(first.mux.respawnPane).toHaveBeenCalledTimes(5);
  expect(next.mux.respawnPane).toHaveBeenCalledTimes(5);
});

it('advances the attempted seat even when asynchronous admission throws', async () => {
  const first = await fixture(), next = await fixture();
  first.mux.respawnPane.mockResolvedValue(null as never); next.mux.respawnPane.mockResolvedValue(null as never);
  const prepare = first.company.prepareWake.bind(first.company);
  first.deps.company = { registeredEmployees: () => [...first.company.registeredEmployees(), ...next.company.registeredEmployees()],
    prepareWake: (id: string, sid: string) => id === first.employee.id ? prepare(id, sid) : next.company.prepareWake(id, sid) } as never;
  first.deps.session = id => id === first.session.id ? first.session : id === next.session.id ? next.session : undefined;
  first.deps.moveGuard.mockRejectedValueOnce(new Error('Owned admission failure'));
  await expect(first.controller.tick()).rejects.toThrow('Owned admission failure');
  expect(first.mux.respawnPane).not.toHaveBeenCalled();
  first.advance(60_000); await first.controller.tick();
  expect(next.mux.respawnPane).toHaveBeenCalledOnce();
  expect(first.mux.respawnPane).not.toHaveBeenCalled();
});

it.each(['off', 'vacation', 'generation', 'owner', 'recipe', 'move', 'drain', 'migration'] as const)('refuses %s drift during admission before any respawn', async kind => {
  const f = await fixture();
  f.deps.moveGuard.mockImplementationOnce(async () => {
    if (kind === 'move') f.block();
    else if (kind === 'drain') f.drain();
    else await f.store.update(s => { const e = s.employees[0];
      if (kind === 'off') e.desiredRunning = false;
      if (kind === 'vacation') e.onVacation = true;
      if (kind === 'generation') e.sessionGeneration++;
      if (kind === 'owner') e.owner = 'foreign';
      if (kind === 'recipe') e.runtimeRecipe = { mode: 'claude', workingDir: f.dir, configs: {} };
      if (kind === 'migration') e.bindingMigration = { id: 'migration', from: e.sessionId, to: '11111111-1111-4111-8111-111111111111' };
    });
    return () => kind !== 'move';
  });
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('changed');
  expect(f.mux.respawnPane).not.toHaveBeenCalled(); expect(f.deps.publish).not.toHaveBeenCalled();
});

it('does not leave a failed viewer reconnect in attach-only mode when the owner really restarts', async () => {
  const f = await fixture(); f.mux.respawnPane.mockResolvedValueOnce(null as never);
  expect(await f.controller.reconnect(f.employee.id, f.expected, undefined)).toBe('unavailable');
  vi.spyOn(f.session, 'applyFullAccessDefault').mockResolvedValue([]);
  for (const key of ['_prepareSelectedClaudeProfile', '_prepareManagedCodexTrust', '_scheduleFullAccessCheck'])
    vi.spyOn(f.session as any, key).mockResolvedValue(undefined);
  vi.spyOn(f.session as any, '_buildRespawnPaneOptionsWithResumePin').mockResolvedValue({ sessionId: f.session.id, workingDir: f.dir, mode: 'opencode' });
  // Avoid the Codex hook installer: the saved runtime is unchanged by reconnect.
  vi.spyOn(f.session, 'mode', 'get').mockReturnValue('opencode');
  f.mux.respawnPane.mockImplementationOnce(async options => {
    await acknowledgeMuxFixture(options);
    // The successful physical fixture advances its own original registry row
    // and observable pane, just as the actual manager does after respawn.
    f.mux.getSession(f.session.id)!.pid = 42;
    f.mux.readPaneLiveness.mockResolvedValue({state:'live',pid:42});
    return 42;
  });
  expect(await f.session.restartDeadCli(() => true)).toBe(true);
  expect(f.mux.respawnPane.mock.calls[1][0]).not.toHaveProperty('workerAttachOnly');
  expect(f.session.paneExit).toBeUndefined(); expect(f.session.canAcceptChatInput()).toBe(true);
});

it('requires a verified owner and exact current binding; accepts no commands or owner flags', async () => {
  const f = await fixture(), app = Fastify(); cleanups.push(() => app.close());
  registerWorkerViewerReconnect(app, f.controller, req => req.headers['x-fixture-owner'] === 'yes'); await app.ready();
  const url = `/api/company/employees/${f.employee.id}/reconnect`;
  expect((await app.inject({ method: 'POST', url, payload: f.expected })).statusCode).toBe(403);
  const headers = { 'x-fixture-owner': 'yes' };
  expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-reverie-parent-session': f.session.id }, payload: f.expected })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...f.expected, owner: true } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...f.expected, diagnostic: true } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...f.expected, socket: '/untrusted/viewer.sock' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...f.expected, sessionGeneration: 99 } })).statusCode).toBe(409);
  expect(f.mux.respawnPane).not.toHaveBeenCalled();
  expect((await app.inject({ method: 'POST', url, headers, payload: f.expected })).statusCode).toBe(200);
});

it('returns a distinct requested response without claiming diagnostic readiness over the owner API', async () => {
  const f = await fixture(), app = Fastify(); cleanups.push(() => app.close()); f.health(false); diagnosticEndpoint(f);
  registerWorkerViewerReconnect(app, f.controller, req => req.headers['x-fixture-owner'] === 'yes'); await app.ready();
  const url = `/api/company/employees/${f.employee.id}/reconnect`, headers = { 'x-fixture-owner': 'yes' };
  const response = await app.inject({ method: 'POST', url, headers, payload: f.expected });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ state: 'viewer-inspection-requested',
    reconnect: { state: 'blocked', reason: 'diagnostic-requested-readiness-unconfirmed-input-held' } });
  expect(f.session.viewerInputHeld).toBe(true); expect(f.session.paneExit).toBeDefined();
  expect(f.mux.sendInput).not.toHaveBeenCalled();
});

async function installSessionUpdateCapabilities(h: Awaited<ReturnType<typeof createHarness>>) {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const methods = frontendClassMethods(source,'ReverieApp',['_onSessionUpdated','_observeInputRecovery',
    '_rememberInputRecovery','_renderInputRecoveryBanner','_sessionInputHeld']);
  h.window.eval(`Object.assign(window.ReverieApp.prototype,{${methods}});`);
  const context = {indexedDB:new IDBFactory(),navigator:{locks:new FixtureLocks()},crypto:webcrypto};
  const delivery = ['browser-input-journal.js','input-delivery.js']
    .map(name=>readFileSync(resolve(import.meta.dirname,'../src/web/public',name),'utf8')).join('\n');
  // fake-indexeddb returns records in this Node realm. Keep the actual journal
  // and delivery module in the same realm, with the harness's real DOM and app.
  // Browser storage and cross-page lease behavior have their Chromium runner.
  new Function('window','globalThis','ReverieApp','document','localStorage','fetch',delivery)(
    h.window,context,h.window.ReverieApp,h.document,h.window.localStorage,
    async (url:string)=>{
      expect(url).toBe('/api/input-identity');
      return Response.json({success:true,data:{version:1,kind:'session',scopeId:'viewer-projection',epoch:1}});
    }
  );
  expect(await h.app._loadReliableState()).toBe(true);
  cleanups.push(async()=>h.app._inputJournal.close());
}

it('runs the real recovery observation and persistence when full session updates remove a held flag',async()=>{
  const id=randomUUID();
  const h=await createHarness({loadShell:false,sessions:[{id,name:'Original employee',status:'idle',terminalInputHeld:true}],
    rooms:[room('r1','Office',[member(id,'Original employee')])]});
  cleanups.push(async()=>h.dom.window.close());
  await installSessionUpdateCapabilities(h);
  Object.assign(h.app,{activeSessionId:id,renderSessionTabs(){},updateCost(){},updateSubagentParentNames(){},
    recheckOrphanSubagents(){},updateConnectionLines(){}});
  const banner=h.document.createElement('div');banner.id='inputRecoveryBar';banner.hidden=true;h.document.body.append(banner);
  await h.startShell();await h.flush(80);
  h.app._chatEls.input.value='retained unsent draft';
  h.app._onSessionUpdated({session:{id,name:'Original employee',status:'idle',terminalInputHeld:false}});
  expect(h.app.sessions.get(id).terminalInputHeld).toBe(false);
  expect(h.app._sessionInputHeld(id)).toBe(true);
  expect((await h.app._inputJournal.snapshot()).holds).toEqual([{sid:id,reason:'server-unconfirmed'}]);
  expect(h.window.localStorage.getItem('reverie:pendingInput')).toBeNull();
  expect(banner.hidden).toBe(false);expect(banner.textContent).toContain('Input held');
  expect(h.app._chatEls.input.value).toBe('retained unsent draft');
  expect(h.app._pendingDeliveries.size).toBe(0);expect(h.server.posts).toEqual([]);
});

it.each(['idle','busy'] as const)('carries a repaired %s viewer through persistence and SSE without claiming unproven provider health', async status => {
  const f = await fixture(); Object.assign(f.session,{_status:status}); const web = new WebServer(0, false, true) as any;
  cleanups.push(() => web.stop()); web.sessions.set(f.session.id, f.session);
  const h = await createHarness({ loadShell: false, sessions: [f.session.toState()],
    company: { canManage: true, employees: [{ ...f.employee, runtimeHealth: 'disconnected', runtimeHealthScope: 'terminal', available: true }] },
    rooms: [room('r1', 'Office', [member(f.session.id, 'Alex')])] });
  cleanups.push(async () => h.dom.window.close());
  // Install the actual full-state browser handler, not the harness's partial-state merger.
  await installSessionUpdateCapabilities(h);
  Object.assign(h.app, { renderSessionTabs() {}, updateCost() {}, updateSubagentParentNames() {}, recheckOrphanSubagents() {}, updateConnectionLines() {} });
  const shell = await h.startShell(); await h.flush(120); shell.humanSelf = { role: 'owner' }; shell.phoneStatus = { self: 'owner', canSetOwn: true };
  const memberRow = () => h.document.querySelector(`[data-key="member:${f.session.id}"]`)!;
  shell.renderMembers(); expect(memberRow().textContent).toContain('Viewer unavailable');
  const frames: string[] = []; const reply = { raw: { write: (frame: string) => { frames.push(frame); return true; } } };
  web.sse.addClient(reply, null, false);
  f.deps.publish.mockImplementation(session => {
    web._persistSessionStateNow(session);
    web.broadcast(SseEvent.SessionUpdated, { session: web.getSessionStateWithRespawn(session) });
  });
  web.workerViewerReconnect = f.controller;
  web.mux.getPaneExit = () => ({ status: 1, at: 123 });
  web.mux.emit('paneExitsUpdated');
  await vi.waitFor(() => expect(f.deps.publish).toHaveBeenCalledOnce());
  const frame = frames.find(s => s.startsWith('event: session:updated\n'))!;
  expect(frame).toBeDefined(); const data = JSON.parse(frame.split('\ndata: ')[1].split('\n\n')[0]);
  expect(data.session.runtimeHealth).toBe('unknown'); expect(data.session).not.toHaveProperty('paneExit');
  expect(web.store.getSession(f.session.id).paneExit).toBeUndefined();
  h.app._onSessionUpdated(data); await h.flush();
  expect(h.app.sessions.get(f.session.id).paneExit).toBeUndefined();
  expect(memberRow().textContent).not.toContain('Disconnected');
  expect(memberRow().className).toContain('is-state-unknown');
  expect(memberRow().className).not.toContain('is-online');
  expect(memberRow().title).toContain('terminal viewer is connected');
  expect(memberRow().textContent).not.toContain('Working…');
  expect(h.app.sessions.get(f.session.id).status).toBe(status);
  expect(h.document.querySelector('.ca-members')!.textContent).toContain('Availability unknown — 1');
  expect(shell.company.employees[0].runtimeHealth).toBe('disconnected'); // cached company facts cannot override fresh session state
});

it('does not starve a later eligible viewer behind a disconnected OFF seat',async()=>{
 const f=await fixture(),off=await fixture();await off.company.setDesiredRunning(off.session.id,false);
 const ownRows=f.company.registeredEmployees.bind(f.company);
 vi.spyOn(f.company,'registeredEmployees').mockImplementation(()=>[...off.company.registeredEmployees(),...ownRows()]);
 f.deps.session=(id:string)=>id===off.session.id?off.session:id===f.session.id?f.session:undefined;
 await f.controller.tick();
 expect(off.mux.respawnPane).not.toHaveBeenCalled();expect(f.mux.respawnPane).toHaveBeenCalledOnce();
});

it('retries a fresh SID generation without inheriting the previous binding backoff',async()=>{
 const f=await fixture(),next=await fixture();f.mux.respawnPane.mockResolvedValue(null as never);
 for(let n=0;n<4;n++){await f.controller.tick();f.advance();}
 expect(f.mux.respawnPane).toHaveBeenCalledTimes(4);
 await f.store.update(s=>{s.employees[0].sessionId=next.session.id;s.employees[0].sessionGeneration++;});
 f.deps.session=(id:string)=>id===next.session.id?next.session:undefined;
 await f.controller.tick();
 expect(next.mux.respawnPane).toHaveBeenCalledOnce();
});

it('recognizes a live busy CLI without waiting for an idle-only shortcut footer',async()=>{
 const f=await fixture();vi.useFakeTimers();Object.assign(f.session,{_status:'busy'});
 f.mux.capturePaneText.mockReturnValue('• Working (5s • esc to interrupt)\n›\nGPT-6.1-Sol high · /work');
 const pending=f.controller.reconnect(f.employee.id,f.expected,undefined);
 await vi.advanceTimersByTimeAsync(10_250);
 expect(await pending).toBe('connected');expect(f.mux.sendInput).not.toHaveBeenCalled();
 expect(f.session.status).toBe('busy');expect(f.session.isWorking).toBe(true);
 expect(f.session.runtimeHealth).toBe('unknown');
});


it('carries independent native health through the real server SSE projection and browser handler without releasing a failed viewer hold',async()=>{
 const f=await fixture();Object.assign(f.session,{_pid:null,ptyProcess:null,_viewerInputHeld:true,_status:'idle'});
 const web=new WebServer(0,false,true)as any;cleanups.push(()=>web.stop());web.sessions.set(f.session.id,f.session);
 const frames:string[]=[];web.sse.addClient({raw:{write:(frame:string)=>{frames.push(frame);return true;}}},null,false);
 const employee=f.company.registeredEmployees()[0];
 const observedBinding=JSON.parse(JSON.stringify([employee.id,employee.owner,employee.sessionId,employee.sessionGeneration,employee.desiredRunning,employee.onVacation,employee.bindingMigration,employee.runtimeRecipe,employee.permissions]));
 const row={observedBinding,employeeId:f.employee.id,sessionId:f.session.id,sessionGeneration:f.employee.sessionGeneration,state:'healthy',
  observedAtEpochMs:Date.now(),reason:'LIVE_NATIVE_COMMAND',proofKind:'live-container',containerId:'a'.repeat(64),initPID:101,initStartTick:202};
 const health=new WorkerProviderHealth({employees:()=>f.company.registeredEmployees(),query:async()=>({providerHealth:{version:1,purpose:'worker-provider-health-v1',providers:[row]}}),
  changed:()=>web.broadcast(SseEvent.SessionUpdated,{session:web.getSessionStateWithRespawn(f.session)})});web.workerProviderHealth=health;
 (f.company as any).deps.providerHealth=(employee:CompanyEmployee)=>health.read(employee);
 const h=await createHarness({loadShell:false,sessions:[f.session.toState()],company:{canManage:true,...f.company.view()},
  rooms:[room('r1','Office',[member(f.session.id,'Alex',{alive:false,pendingDeliveries:3})])]});cleanups.push(async()=>h.dom.window.close());
 await installSessionUpdateCapabilities(h);
 Object.assign(h.app,{renderSessionTabs(){},updateCost(){},updateSubagentParentNames(){},recheckOrphanSubagents(){},updateConnectionLines(){}});
 const shell=await h.startShell();await h.flush(80);shell.renderMembers();
 expect(h.document.querySelector('.ca-member').textContent).toContain('Viewer unavailable');
 h.app._chatEls.input.value='retained unsent draft';web._persistSessionStateNow(f.session);await health.refresh();
 const frame=frames.find(s=>s.startsWith('event: session:updated\n'))!;expect(frame).toBeDefined();
 const data=JSON.parse(frame.split('\ndata: ')[1].split('\n\n')[0]);expect(data.session.providerHealth.state).toBe('healthy');
 expect(data.session.viewerHealth).toBe('disconnected');expect(data.session.paneExit).toEqual({status:1,at:123});
 h.app._onSessionUpdated(data);await h.flush();
 const memberRow=h.document.querySelector(`[data-key="member:${f.session.id}"]`)!;
 expect(memberRow.classList.contains('is-online')).toBe(true);expect(memberRow.querySelector('.ca-viewer-warning')).not.toBeNull();
 expect(shell.room.members[0].alive).toBe(false);expect(shell.room.members[0].pendingDeliveries).toBe(3);
 expect(h.app._chatEls.input.value).toBe('retained unsent draft');expect(f.session.canAcceptChatInput()).toBe(false);
 expect(web.store.getSession(f.session.id).providerHealth).toBeUndefined();expect(f.mux.sendInput).not.toHaveBeenCalled();
 expect(f.company.view().employees[0].providerHealth?.state).toBe('healthy');
 // The same production projection must show a confirmed stopped laptop red,
 // without changing the transport/input state or inventing an init process.
 frames.length=0;Object.assign(row,{state:'dead',reason:'CONTAINER_STOPPED',proofKind:'stopped-container',observedAtEpochMs:Date.now()+1});
 delete (row as any).initPID;delete (row as any).initStartTick;
 await new Promise(resolve=>setTimeout(resolve,5));await health.refresh();
 const stopped=frames.find(s=>s.startsWith('event: session:updated\n'))!;
 h.app._onSessionUpdated(JSON.parse(stopped.split('\ndata: ')[1].split('\n\n')[0]));await h.flush();
 expect(h.document.querySelector('.ca-member').classList.contains('is-state-dead')).toBe(true);
 expect(f.session.canAcceptChatInput()).toBe(false);expect(shell.room.members[0].alive).toBe(false);
 expect(h.app._chatEls.input.value).toBe('retained unsent draft');expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it('reports bounded native-health, retry, readiness and exact-binding diagnostics', async () => {
  const f = await fixture();
  f.health(false); expect(f.controller.status(f.employee.id, f.expected)).toMatchObject({reason:'native-health-unavailable',attempts:0});
  f.health(true); f.mux.readPaneLiveness.mockResolvedValue({state:'unreadable'} as never);
  await f.controller.reconnect(f.employee.id, f.expected, undefined);
  expect(f.controller.status(f.employee.id, f.expected)).toMatchObject({reason:'readiness-unconfirmed',attempts:1,retryAfterMs:2000});
  f.advance(1999.5); expect(f.controller.status(f.employee.id, f.expected).retryAfterMs).toBe(1);
  expect(f.controller.status(f.employee.id, {...f.expected,sessionGeneration:999}).reason).toBe('stale-binding');
});
it('rechecks owner authority and healthy provider after asynchronous admission before touching a viewer', async () => {
  for (const kind of ['owner','native-health']) {
    const f = await fixture(); let allowed = true;
    f.deps.moveGuard.mockImplementationOnce(async () => { if(kind === 'owner') allowed=false; else f.health(false); return () => true; });
    expect(await f.controller.reconnect(f.employee.id, f.expected, undefined, false, () => allowed)).toBe('changed');
    expect(f.mux.respawnPane).not.toHaveBeenCalled(); expect(f.deps.pause).not.toHaveBeenCalled();
  }
});
it('rechecks an explicit recovery grant after asynchronous admission and during attach readiness', async () => {
  for (const during of ['admission','readback']) {
    const f = await fixture(); await f.company.update(f.employee.id, undefined, {permissions:{recoverEmployees:true}} as never, () => {});
    const principal = {employeeId:f.employee.id,sessionId:f.session.id,sessionGeneration:f.expected.sessionGeneration,
      owner:undefined,assertCurrent:()=>{},assertIssued:()=>{}};
    const authorized = f.controller.delegated(principal);
    if(during==='admission') f.deps.moveGuard.mockImplementationOnce(async () => {
      await f.company.update(f.employee.id, undefined, {permissions:{recoverEmployees:false}} as never, () => {}); return () => true;
    });
    else f.mux.readPaneLiveness.mockImplementationOnce(async () => {
      await f.company.update(f.employee.id, undefined, {permissions:{recoverEmployees:false}} as never, () => {}); return {state:'dead'};
    });
    expect(await f.controller.reconnect(f.employee.id,f.expected,undefined,false,authorized)).not.toBe('connected');
    expect(f.deps.publish).not.toHaveBeenCalled(); expect(f.mux.sendInput).not.toHaveBeenCalled();
  }
});
it('status distinguishes a current move hold without attempting repair and rechecks target binding after awaits', async()=>{
  const f=await fixture();f.block();
  expect((await f.controller.diagnostics(f.employee.id,f.expected)).reason).toBe('move-in-progress');
  expect(f.mux.respawnPane).not.toHaveBeenCalled();
  f.deps.moveGuard.mockImplementationOnce(async()=>{await f.company.setDesiredRunning(f.session.id,false);return()=>true;});
  expect((await f.controller.diagnostics(f.employee.id,f.expected)).reason).toBe('viewer-subject-changed');
  expect(f.mux.readPaneLiveness).not.toHaveBeenCalled();
});
it('a native-authenticated delegate can repair its own missing website client while the provider stays healthy',async()=>{
  const f=await fixture();await f.company.update(f.employee.id,undefined,{permissions:{recoverEmployees:true}}, () => {});
  Object.assign(f.session,{ptyProcess:null,_pid:null,_viewerClientLost:true});
  const authority={employeeId:f.employee.id,sessionId:f.session.id,sessionGeneration:f.expected.sessionGeneration,owner:undefined,
    assertCurrent:()=>{},assertIssued:()=>{}};
  expect(await f.controller.reconnect(f.employee.id,f.expected,undefined,false,f.controller.delegated(authority))).toBe('connected');
  expect(f.mux.respawnPane).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({workerAttachOnly:true}));
  expect(f.mux.sendInput).not.toHaveBeenCalled();
});
it('native recovery HTTP status rechecks revoked grants after read-only move inspection',async()=>{
  const f=await fixture();await f.company.update(f.employee.id,undefined,{permissions:{recoverEmployees:true}}, () => {});
  const app=Fastify();cleanups.push(()=>app.close());
  const authority={employeeId:f.employee.id,sessionId:f.session.id,sessionGeneration:f.expected.sessionGeneration,owner:undefined,
    assertCurrent:()=>{},assertIssued:()=>{}};
  registerWorkerViewerReconnect(app,f.controller,()=>false,{authenticate:async()=>authority} as never);
  const req={method:'POST' as const,url:`/api/company/employees/${f.employee.id}/reconnect/status`,
    headers:{'x-reverie-recovery-assertion':'fixture-authenticated-by-private-adapter'},payload:f.expected};
  expect((await app.inject(req)).statusCode).toBe(200);
  f.deps.moveGuard.mockImplementationOnce(async()=>{
    await f.company.update(f.employee.id,undefined,{permissions:{recoverEmployees:false}}, () => {});return()=>true;
  });
  expect((await app.inject(req)).statusCode).toBe(403);expect(f.mux.respawnPane).not.toHaveBeenCalled();
});
it.each(['idle','busy'] as const)('reads a live %s outer viewer without claiming native readiness or clearing holds', async state => {
  const f = await fixture();
  Object.assign(f.session,{_paneExit:null,_status:state,_viewerInputHeld:true});
  f.health(false); f.mux.readPaneLiveness.mockResolvedValue({state:'live',pid:41});
  const original = f.registered.get(f.session.id), before = f.session.toState();
  expect(await f.controller.diagnostics(f.employee.id,f.expected)).toMatchObject({
    state:'idle',reason:'viewer-not-disconnected',observation:'outer-pane-responsive',attempts:0,
  });
  expect(f.registered.get(f.session.id)).toBe(original);
  expect(f.session.toState()).toMatchObject({id:before.id,pid:before.pid,mode:before.mode,status:before.status});
  expect(f.session.viewerInputHeld).toBe(true);
  expect(f.mux.respawnPane).not.toHaveBeenCalled(); expect(f.mux.sendInput).not.toHaveBeenCalled();
  expect(f.deps.pause).not.toHaveBeenCalled(); expect(f.deps.publish).not.toHaveBeenCalled();
});

it('carries a real manager query timeout through the original Session and owner status API as unconfirmed only', async () => {
  const f = await fixture(), app = Fastify(); cleanups.push(()=>app.close());
  const muxName=`reverie-${f.session.id}`;
  f.registered.get(f.session.id)!.muxName=muxName;
  const bin=join(f.dir,'bin'), done=join(f.dir,'query-done'), calls=join(f.dir,'query-args');
  await mkdir(bin);
  // A finite owned Node executable, never the host tmux or a provider. Without
  // the real manager's 5s deadline its late valid pane reply would be responsive.
  await writeFile(join(bin,'tmux'),`#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2)));\nprocess.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(done)},'TERM');process.exit(0)});\nsetTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'late');process.stdout.write(${JSON.stringify(`0 41 ${muxName}\n`)});process.exit(0)},6500);\n`,{mode:0o700});
  vi.stubEnv('PATH',`${bin}:${process.env.PATH}`);
  const manager=new TmuxManager(); cleanups.push(async()=>manager.destroy());
  f.mux.readPaneLiveness.mockImplementation(name=>manager.readPaneLiveness(name));
  Object.assign(f.session,{_paneExit:null,_status:'busy',_viewerInputHeld:true});
  registerWorkerViewerReconnect(app,f.controller,()=>true);
  const before=f.registered.get(f.session.id);
  const reply=await app.inject({method:'POST',url:`/api/company/employees/${f.employee.id}/reconnect/status`,payload:f.expected});
  expect(reply.statusCode).toBe(200);
  expect(reply.json().data.reconnect).toMatchObject({state:'blocked',reason:'pane-observation-unconfirmed',observation:'pane-observation-unconfirmed'});
  expect(JSON.parse(readFileSync(calls,'utf8'))).toContain('list-panes');
  expect(readFileSync(done,'utf8')).toBe('TERM');
  expect(f.registered.get(f.session.id)).toBe(before); expect(f.session.pid).toBe(123);
  expect(f.session.status).toBe('busy'); expect(f.session.viewerInputHeld).toBe(true);
  expect(f.mux.respawnPane).not.toHaveBeenCalled();expect(f.mux.sendInput).not.toHaveBeenCalled();
  expect(f.deps.publish).not.toHaveBeenCalled(); expect(f.deps.pause).not.toHaveBeenCalled();
});

it.each(['owner','delegate','binding','session','mux-owner','mux-subject','provider-epoch','mode'] as const)(
  'rechecks %s after the original pane read and discloses no stale observation',async change=>{
    const f=await fixture(), app=Fastify();cleanups.push(()=>app.close());let allowed=true;
    let finish!:(value:{state:'live';pid:number})=>void, entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    f.mux.readPaneLiveness.mockImplementationOnce(async()=>{entered();return new Promise(resolve=>{finish=resolve;});});
    await f.company.update(f.employee.id,undefined,{permissions:{recoverEmployees:true}}, () => {});
    const authority={employeeId:f.employee.id,sessionId:f.session.id,sessionGeneration:f.expected.sessionGeneration,owner:undefined,
      assertCurrent:()=>{if(!allowed)throw Error('revoked');},assertIssued:()=>{}};
    registerWorkerViewerReconnect(app,f.controller,()=>allowed,change==='delegate'?{authenticate:async()=>authority}as never:undefined);
    const pending=app.inject({method:'POST',url:`/api/company/employees/${f.employee.id}/reconnect/status`,payload:f.expected,
      ...(change==='delegate'?{headers:{'x-reverie-recovery-assertion':'fixture-authenticated-by-private-adapter'}}:{})});
    await started;
    if(change==='owner')allowed=false;
    if(change==='delegate')await f.company.update(f.employee.id,undefined,{permissions:{recoverEmployees:false}}, () => {});
    if(change==='binding')await f.store.update(s=>{s.employees[0].sessionGeneration++;});
    if(change==='session')f.deps.session=()=>undefined;
    if(change==='mux-owner')f.registered.get(f.session.id)!.owner='foreign';
    if(change==='mux-subject')f.registered.set(f.session.id,{...f.registered.get(f.session.id)!});
    if(change==='provider-epoch')(f.session as unknown as {_invalidateWorkspaceHooks():void})._invalidateWorkspaceHooks();
    if(change==='mode')Object.assign(f.session,{_mode:'claude'});
    finish({state:'live',pid:41});const response=await pending;
    expect(response.statusCode).toBe(change==='owner'||change==='delegate'?403:change==='binding'||change==='session'?409:200);
    expect(response.body).not.toContain('outer-pane-responsive');
    if(change.startsWith('mux-')||change==='provider-epoch'||change==='mode')expect(response.json().data.reconnect).toMatchObject({reason:'viewer-subject-changed'});
    expect(f.mux.respawnPane).not.toHaveBeenCalled();expect(f.mux.sendInput).not.toHaveBeenCalled();expect(f.deps.publish).not.toHaveBeenCalled();
  });

it('does not publish a responsive read after a real PlanMoves preparation invalidates its original inspection lease',async()=>{
  const f=await fixture(),app=Fastify();cleanups.push(()=>app.close());
  let finishRead!:(value:{state:'live';pid:number})=>void,readEntered!:()=>void;
  let finishSnapshot!:()=>void,snapshotEntered!:()=>void;
  const reading=new Promise<void>(resolve=>{readEntered=resolve;}),preparing=new Promise<void>(resolve=>{snapshotEntered=resolve;});
  const save=vi.fn(), snapshot=vi.fn(async()=>{snapshotEntered();await new Promise<void>(resolve=>{finishSnapshot=resolve;});throw Error('Owned snapshot fixture refused');});
  const moves=new PlanMoves({load:async()=>[],save,snapshot}as unknown as PlanMovePort);
  diagnosticEndpoint(f,vi.fn(async()=>moves.viewerInspectionGuard(f.employee.id)));
  f.mux.readPaneLiveness.mockImplementationOnce(async()=>{readEntered();return new Promise(resolve=>{finishRead=resolve;});});
  registerWorkerViewerReconnect(app,f.controller,()=>true);
  const request=app.inject({method:'POST',url:`/api/company/employees/${f.employee.id}/reconnect/status`,payload:f.expected});
  await reading;
  const move=moves.begin({id:randomUUID(),employeeId:f.employee.id,sessionId:f.session.id,fromAccount:'before',toAccount:'after',forceBusy:false,handoff:''})
    .then(()=>{throw Error('Unexpected move success');},error=>error);
  await preparing;finishRead({state:'live',pid:41});
  const response=await request;
  finishSnapshot();expect((await move).message).toBe('Owned snapshot fixture refused');
  expect(response.statusCode).toBe(200);
  expect(response.json().data.reconnect).toMatchObject({state:'blocked',reason:'move-in-progress'});
  expect(response.json().data.reconnect.observation).toBeUndefined();
  expect(f.mux.respawnPane).not.toHaveBeenCalled();expect(f.mux.sendInput).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it.each(['current','revoked','moved'] as const)('sanitizes a failed repair with %s authority and binding',async change=>{
  const f=await fixture(),app=Fastify();cleanups.push(()=>app.close());let allowed=true;
  registerWorkerViewerReconnect(app,f.controller,()=>allowed);
  f.deps.moveGuard.mockImplementationOnce(async()=>{
    if(change==='revoked')allowed=false;
    if(change==='moved')await f.store.update(s=>{s.employees[0].sessionGeneration++;});
    throw Error('private host endpoint and conversation must not be echoed');
  });
  const reply=await app.inject({method:'POST',url:`/api/company/employees/${f.employee.id}/reconnect`,payload:f.expected});
  expect(reply.statusCode).toBe(change==='current'?503:change==='revoked'?403:409);
  if(change==='current')expect(reply.json().reconnect).toMatchObject({state:'blocked',reason:'admission-unavailable'});
  else expect(reply.json().reconnect).toBeUndefined();
  expect(reply.body).not.toContain('private host');
  expect(f.mux.respawnPane).not.toHaveBeenCalled();expect(f.mux.sendInput).not.toHaveBeenCalled();
});

it.each(['applyFullAccessDefault','_prepareSelectedClaudeProfile','_prepareManagedCodexTrust','_prepareCodexHookTrust'])(
  'delegated interactive start rechecks authority after awaited %s preparation before any mux or PTY effect',async preparation=>{
    const f=await fixture();Object.assign(f.session,{ptyProcess:null,_pid:null});let allowed=true;
    for(const method of ['applyFullAccessDefault','_prepareSelectedClaudeProfile','_prepareManagedCodexTrust','_prepareCodexHookTrust'])
      vi.spyOn(f.session as any,method).mockImplementation(async()=>{if(method===preparation)allowed=false;});
    await expect(f.session.startInteractive(()=>allowed)).rejects.toThrow('authorization changed');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();expect(f.mux.sendInput).not.toHaveBeenCalled();expect(f.session.pid).toBeNull();
  });
it('delegated admission survives mux setup awaits and a revocation cannot fall back to a direct provider',async()=>{
  const f=await fixture();Object.assign(f.session,{ptyProcess:null,_pid:null});let allowed=true;
  for(const method of ['applyFullAccessDefault','_prepareSelectedClaudeProfile','_prepareManagedCodexTrust','_prepareCodexHookTrust'])
    vi.spyOn(f.session as any,method).mockResolvedValue(undefined);
  f.mux.respawnPane.mockImplementationOnce(async options=>{allowed=false;expect(options.admitted!()).toBe(false);return null as never;});
  await expect(f.session.startInteractive(()=>allowed)).rejects.toThrow('authorization changed');
  expect(f.mux.respawnPane).toHaveBeenCalledOnce();expect(f.session.pid).toBeNull();expect(f.mux.sendInput).not.toHaveBeenCalled();
});
