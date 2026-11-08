import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session } from './src/session.js';
import { TmuxManager } from './src/tmux-manager.js';
import { CompanyStore } from './src/company-store.js';
import { CompanyService } from './src/company-service.js';
import { WorkerViewerReconnect, registerWorkerViewerReconnect } from './src/worker-viewer-reconnect.js';
import { ChatroomDelivery, WAKE_LINE } from './src/chatroom-delivery.js';
import { PendingDeliveryStore } from './src/chatroom-pending-delivery.js';
import { expertRuntimeRecipe } from './src/expert-runtime-recipe.js';
import { recordOwnerStop, ownerStopPending, useOwnerStopJournal } from './src/owner-stop-journal.js';
const root = process.env.FIXTURE_ROOT!,
  out = process.env.FIXTURE_RESULT!,
  sid = process.env.FIXTURE_SID!;
const tmux = process.env.FIXTURE_TMUX!,
  python = process.env.FIXTURE_PYTHON!,
  outer = process.env.REVERIE_TMUX_SOCKET!;
const name = 'reverie-' + sid.slice(0, 8),
  work = join(root, 'work');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trace: any = {
  variant: process.env.FIXTURE_VARIANT,
  proofBoundary:
    'Real owned tmux/PTY + worker frame client/handler, deterministic interactive provider stand-in; metadata-only engine adapter. No actual Docker or authenticated commercial provider qualification.',
  events: [],
  submitted: [],
  uncertain: [],
};
const event = (phase: string, value: any = {}) => {
  trace.events.push({ at: Date.now(), phase, ...value });
  console.log(phase, JSON.stringify(value));
};
function native(...args: string[]) {
  return execFileSync(tmux, ['-L', outer, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
}
function birth(pid: number) {
  return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/)[19];
}
async function wait(test: () => boolean | Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(100);
  }
  throw Error('timeout: ' + label);
}
const ready = JSON.parse(readFileSync(join(root, 'helper-ready.json'), 'utf8'));
const providerPID = ready.provider_pid;
const providerBirth = birth(providerPID);
assert.equal(providerBirth, ready.provider_start_tick);
const health = () => {
  try {
    return (
      birth(providerPID) === providerBirth &&
      execFileSync(tmux, ['-S', ready.inner_socket, 'display-message', '-p', '-t', 'office', '#{pane_dead}'], {
        encoding: 'utf8',
      }).trim() === '0'
    );
  } catch {
    return false;
  }
};
let mux: TmuxManager | undefined,
  session: Session | undefined,
  delivery: ChatroomDelivery | undefined,
  store: PendingDeliveryStore | undefined;
let finished = false;
try {
  native('-f', '/dev/null', 'new-session', '-d', '-x', '160', '-y', '40', '-s', name, 'exec sleep 90');
  native('set-option', '-t', name, 'remain-on-exit', 'on');
  native(
    'respawn-pane',
    '-k',
    '-t',
    name,
    `exec ${join(root, 'bin/reverie-worker-exec')} --attach-only --session-id ${sid} --cwd ${work} --command must-never-run`
  );
  await wait(
    () => native('capture-pane', '-p', '-t', name).includes('esc to interrupt'),
    5000,
    'initial live provider screen'
  );
  const firstViewerPID = Number(native('display-message', '-p', '-t', name, '#{pane_pid}'));
  mux = new TmuxManager();
  const record: any = {
    sessionId: sid,
    muxName: name,
    pid: firstViewerPID,
    createdAt: Date.now(),
    workingDir: work,
    mode: 'codex',
    attached: false,
  };
  mux.registerSession(record);
  session = new Session({ id: sid, workingDir: work, mode: 'codex', useMux: true, mux, muxSession: record });
  (session as any)._attachExistingMuxClient('isolated baseline attach');
  (session as any)._bindInteractivePty(false);
  await wait(() => session!.isWorking, 5000, 'real initial working detection');
  const recipe = JSON.stringify(expertRuntimeRecipe(session));
  const companyStore = new CompanyStore(join(root, 'company-controller.json'));
  await companyStore.init();
  const company = new CompanyService(companyStore, {
    getSession: (id: string) => (id === sid ? session : undefined),
    chatrooms: { rooms: () => [] },
    research: {},
  } as never);
  const employee = await company.hire({
    name: 'Fixture',
    icon: 'F',
    position: 'Engineer',
    expertise: ['fixture'],
    sessionId: sid,
    researchEnabled: false,
  } as never);
  await company.setDesiredRunning(sid, true);
  store = PendingDeliveryStore.open(join(root, 'pending.db'));
  delivery = new ChatroomDelivery({
    getSession: (id: string) => (id === sid ? session : undefined),
    pendingStore: () => store,
    onSubmitted: (_id: any, m: any) => {
      trace.submitted.push(m);
      event('submitted-receipt', { count: m.length });
    },
    onUncertain: (_id: any, m: any) => trace.uncertain.push(m),
  });
  const controller = new WorkerViewerReconnect({
    company,
    session: (id: string) => (id === sid ? session : undefined),
    ready: () => true,
    providerHealthy: () => health(),
    moveGuard: async () => () => true,
    pause: (id: string) => delivery!.pauseForMigration(id),
    publish: () => event('viewer-published'),
  });
  const drop = async () => {
    const pid = Number(native('display-message', '-p', '-t', name, '#{pane_pid}'));
    assert.notEqual(pid, providerPID);
    const start = birth(pid);
    execFileSync(python, [
      '-I',
      '-B',
      '-c',
      'import os,signal,sys;pid=int(sys.argv[1]);expected=sys.argv[2];fd=os.pidfd_open(pid);assert open("/proc/"+str(pid)+"/stat").read().rsplit(")",1)[1].split()[19]==expected;signal.pidfd_send_signal(fd,signal.SIGTERM)',
      String(pid),
      start,
    ]);
    await wait(() => native('display-message', '-p', '-t', name, '#{pane_dead}') === '1', 5000, 'viewer exit');
    session!.setPaneExit({ status: 143, at: Date.now() });
    assert.equal(session!.runtimeHealth, 'disconnected');
    assert(health());
  };
  event('baseline-native-identities', {
    providerPID,
    providerBirth,
    firstViewerPID,
    sessionWorking: session.isWorking,
  });
  await drop();
  writeFileSync(join(root, 'unready-control'), 'owned fixture transition to unready\n');
  await wait(
    () =>
      execFileSync(tmux, ['-S', ready.inner_socket, 'capture-pane', '-p', '-t', 'office'], {
        encoding: 'utf8',
      }).includes('Connecting'),
    3000,
    'provider unready while viewer disconnected'
  );
  delivery.enqueue(sid, { id: 'fixture-room', name: 'R' }, '\"Fixture\": \"native-accept-once\"', {
    messageId: 'fixture-message',
    durable: true,
  });
  await delivery.flushAll();
  assert.equal(delivery.pendingFor(sid), 1);
  await controller.tick();
  assert.equal(session.runtimeHealth, 'disconnected');
  assert.equal(session.viewerInputHeld, true);
  assert.equal(trace.submitted.length, 0);
  assert(!existsSync(join(root, 'provider-input.jsonl')));
  assert(health());
  event('readiness-failure-retained-chat', { pending: delivery.pendingFor(sid), held: session.viewerInputHeld });
  writeFileSync(join(root, 'idle-control'), 'owned fixture transition to idle\n');
  await wait(
    () =>
      execFileSync(tmux, ['-S', ready.inner_socket, 'capture-pane', '-p', '-t', 'office'], {
        encoding: 'utf8',
      }).includes('? for shortcuts'),
    3000,
    'provider idle while viewer disconnected'
  );
  assert.equal(session.isWorking, true);
  event('loss-reproduced', { sessionWorking: session.isWorking, providerHealthy: health() });
  await delivery.flushAll();
  assert.equal(delivery.pendingFor(sid), 1);
  assert(!existsSync(join(root, 'provider-input.jsonl')));
  event('queued-before-repair');
  await controller.tick();
  event('automatic-tick-returned', {
    runtimeHealth: session.runtimeHealth,
    working: session.isWorking,
    held: session.viewerInputHeld,
  });
  assert.notEqual(session.runtimeHealth, 'disconnected');
  assert(health());
  assert.equal(JSON.stringify(expertRuntimeRecipe(session)), recipe);
  await wait(
    () => !session!.isWorking && session!.canAcceptChatInput(),
    35000,
    'observed idle and input readiness after repair'
  );
  const accepted = await delivery.flush(sid);
  event('delivery-flush-returned', { accepted });
  assert(accepted);
  await wait(() => existsSync(join(root, 'provider-input.jsonl')), 5000, 'native provider stdin receipt');
  await wait(() => trace.submitted.length === 1, 10000, 'separate chat submitted receipt');
  const inputs = () =>
    readFileSync(join(root, 'provider-input.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  assert.equal(inputs().length, 1);
  // The provider gets the constant wake once; the message itself reaches it only through its hook.
  assert(inputs()[0].text.includes(WAKE_LINE));
  assert(!inputs()[0].text.includes('native-accept-once'));
  assert.equal(inputs()[0].pid, providerPID);
  await delivery.flushAll();
  await sleep(2300);
  assert.equal(inputs().length, 1);
  event('actual-chat-delivery-confirmed-once', { providerPID, pending: delivery.pendingFor(sid) });
  // Independent second phase: unknown input and a real pending stop stay held;
  // no owner resolution or forced clearing is used to claim a delivery success.
  useOwnerStopJournal(join(root, 'owner-stops'));
  recordOwnerStop(sid, { fence: 'c'.repeat(32), notAfter: Date.now() + 60000 });
  const fencePath = join(root, 'owner-stops', sid + '.json'),
    fenceBefore = readFileSync(fencePath);
  const unknown: any = {
    id: randomUUID(),
    sessionId: sid,
    roomId: 'fixture-room',
    messageId: 'retained-unknown',
    passive: false,
    at: Date.now(),
    state: 'uncertain',
  };
  store.add(unknown);
  delivery.holdForInspection(sid, [{ roomId: 'fixture-room', messageId: 'retained-unknown' }]);
  session.verifySubmitted('unknown-old-draft', (outcome: any) => event('old-verifier-outcome', { outcome }));
  await drop();
  const app = Fastify();
  registerWorkerViewerReconnect(app, controller, () => true);
  const response = await app.inject({
    method: 'POST',
    url: `/api/company/employees/${employee.id}/reconnect`,
    payload: { sessionId: sid, sessionGeneration: employee.sessionGeneration },
  });
  event('reconnect-http-response', { statusCode: response.statusCode, body: response.json() });
  assert.equal(response.statusCode, 200);
  await app.close();
  assert.deepEqual(
    store.list().find((x) => x.id === unknown.id),
    unknown
  );
  assert(ownerStopPending(sid));
  assert.deepEqual(readFileSync(fencePath), fenceBefore);
  assert.equal(
    delivery.inspectionFor(sid).some((x) => x.messageId === 'retained-unknown'),
    true
  );
  assert.equal(await session.writeViaMux('must-not-enter\r'), false);
  await delivery.flushAll();
  await sleep(2300);
  assert.equal(inputs().length, 1);
  assert(health());
  assert.equal(birth(providerPID), providerBirth);
  assert.equal(JSON.stringify(expertRuntimeRecipe(session)), recipe);
  event('unknown-and-stop-fence-preserved', { inputCount: inputs().length });
  trace.passed = true;
  trace.providerPID = providerPID;
  trace.providerBirth = providerBirth;
  trace.nativeInputCount = inputs().length;
  trace.inputReceipts = inputs();
  trace.recipeSHA256 = createHash('sha256').update(recipe).digest('hex');
  trace.realCommercialProviderExercised = false;
} catch (error) {
  trace.passed = false;
  trace.error = String(error);
  trace.stack = (error as Error).stack;
  try {
    trace.finalScreen = native('capture-pane', '-p', '-S', '-200', '-t', name);
  } catch {}
  event('failure', { error: String(error) });
  process.exitCode = 1;
} finally {
  delivery?.stop();
  store?.close();
  mux?.destroy();
  if (session) {
    const pty = (session as any).ptyProcess;
    if (pty) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        pty.onExit(() => {
          clearTimeout(timer);
          resolve();
        });
        pty.kill();
      });
    }
    (session as any).ptyProcess = null;
    (session as any)._muxSession = null;
    await session.stop(false);
  }
  try {
    native('kill-server');
  } catch {}
  writeFileSync(out, JSON.stringify(trace, null, 2) + '\n');
}
