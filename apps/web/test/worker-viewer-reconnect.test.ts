import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../src/session.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { WorkerViewerReconnect, registerWorkerViewerReconnect } from '../src/worker-viewer-reconnect.js';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/fixture/worker.sock');
  const dir = await mkdtemp(join(tmpdir(), 'viewer-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let dead = true;
  const mux = { isAvailable: () => true, muxSessionExists: () => true,
    isPaneDead: vi.fn(() => dead), readPaneLiveness: vi.fn(async () => dead ? { state: 'dead' } : { state: 'live', pid: 42 }),
    respawnPane: vi.fn(async () => { dead = false; return 42; }), clearPaneExit: vi.fn(),
    capturePaneText: vi.fn(() => '›\nGPT-6.1-Sol high · /work\n? for shortcuts'), sendInput: vi.fn(), setAttached: vi.fn() };
  const session = new Session({ workingDir: dir, mode: 'codex', useMux: true, mux: mux as never,
    muxSession: { muxName: 'reverie-owned', sessionId: 'owned', pid: 41 } as never });
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
  let blocked = false, ready = true, clock = 100;
  const release = vi.fn(), pause = vi.fn(() => release), publish = vi.fn();
  const deps = { company, session: (id: string) => id === session.id ? session : undefined,
    ready: () => ready, moveGuard: vi.fn(async () => () => !blocked), pause, publish, now: () => clock };
  const controller = new WorkerViewerReconnect(deps);
  const expected = { sessionId: session.id, sessionGeneration: employee.sessionGeneration };
  return { dir, session, mux, store, company, employee, controller, deps, expected, release,
    block: () => { blocked = true; }, drain: () => { ready = false; }, advance: () => { clock += 20_000; } };
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

it('limits automatic failures to three spaced attempts while leaving one explicit fallback available', async () => {
  const f = await fixture(); f.mux.respawnPane.mockResolvedValue(null as never);
  await f.controller.tick(); await f.controller.tick(); expect(f.mux.respawnPane).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 5; n++) { f.advance(); await f.controller.tick(); }
  expect(f.mux.respawnPane).toHaveBeenCalledTimes(3);
  await f.controller.reconnect(f.employee.id, f.expected, undefined);
  expect(f.mux.respawnPane).toHaveBeenCalledTimes(4);
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
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...f.expected, sessionGeneration: 99 } })).statusCode).toBe(409);
  expect(f.mux.respawnPane).not.toHaveBeenCalled();
  expect((await app.inject({ method: 'POST', url, headers, payload: f.expected })).statusCode).toBe(200);
});

it.each(['idle','busy'] as const)('carries a real repaired %s Session through persistence, SSE JSON and the actual browser handler into the member list', async status => {
  const f = await fixture(); Object.assign(f.session,{_status:status}); const web = new WebServer(0, false, true) as any;
  cleanups.push(() => web.stop()); web.sessions.set(f.session.id, f.session);
  const h = await createHarness({ loadShell: false, sessions: [f.session.toState()],
    company: { canManage: true, employees: [{ ...f.employee, runtimeHealth: 'disconnected', runtimeHealthScope: 'terminal', available: true }] },
    rooms: [room('r1', 'Office', [member(f.session.id, 'Alex')])] });
  cleanups.push(async () => h.dom.window.close());
  // Install the actual full-state browser handler, not the harness's partial-state merger.
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const method = source.slice(source.indexOf('  _onSessionUpdated(data) {'), source.indexOf('  _onSessionDeleted(data) {'));
  h.window.eval(`window.ReverieApp.prototype._onSessionUpdated = function(data) ${method.slice(method.indexOf('{'))};`);
  Object.assign(h.app, { renderSessionTabs() {}, updateCost() {}, updateSubagentParentNames() {}, recheckOrphanSubagents() {}, updateConnectionLines() {} });
  const shell = await h.startShell(); await h.flush(120); shell.humanSelf = { role: 'owner' }; shell.phoneStatus = { self: 'owner', canSetOwn: true };
  const memberRow = () => h.document.querySelector(`[data-key="member:${f.session.id}"]`)!;
  shell.renderMembers(); expect(memberRow().textContent).toContain('Disconnected');
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
  expect(memberRow().className, JSON.stringify({row:memberRow().outerHTML,session:h.app.sessions.get(f.session.id),members:shell.room.members})).toContain(`is-state-${status==='busy'?'working':'idle'}`);
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

it('retries a fresh SID generation after the previous binding exhausted automatic attempts',async()=>{
 const f=await fixture(),next=await fixture();f.mux.respawnPane.mockResolvedValue(null as never);
 for(let n=0;n<4;n++){await f.controller.tick();f.advance();}
 expect(f.mux.respawnPane).toHaveBeenCalledTimes(3);
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
