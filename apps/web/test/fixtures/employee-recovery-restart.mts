/** Separate real Node process over terminal files and a controlled AF_UNIX Q port.
 * No physical provider/native execution is permitted in this fixture. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { PlanMovePort } from '../../src/plan-move.js';
const [root, employeeId, sessionId, serializedApproval, profile] = process.argv.slice(2);
assert.ok(profile === undefined || profile === 'office-source');
assert.ok(root && employeeId && sessionId && serializedApproval);
process.env.HOME = root;
process.env.REVERIE_CAPACITY_RETRY = '0';
process.env.REVERIE_WORKER_SOCKET = join(root, 'native.sock');
const spawn = () => {
  throw Error('Restart fixture forbids physical PTY/provider creation');
};
mock.module('node-pty', { namedExports: { spawn }, defaultExport: { spawn } });
process.stderr.write('restart: importing original owners\n');
const { Session } = await import('../../src/session.js');
const { StateStore } = await import('../../src/state-store.js');
const { CompanyStore } = await import('../../src/company-store.js');
const { CompanyService } = await import('../../src/company-service.js');
const { ChatroomStore } = await import('../../src/chatroom-store.js');
const { PlanMoves } = await import('../../src/plan-move.js');
const { PlanMoveStore } = await import('../../src/plan-move-store.js');
const { OwnerAuthStore } = await import('../../src/owner-auth/store.js');
const { OwnerAuthService } = await import('../../src/owner-auth/service.js');
const { OfficeAuthService } = await import('../../src/owner-auth/office.js');
const { EmployeeRecoveryApproval } = await import('../../src/employee-recovery-operation.js');
const { EmployeeRecoveryService, registerEmployeeRecoveryRoutes } =
  await import('../../src/employee-recovery-service.js');
process.stderr.write('restart: constructing fresh stores\n');
const selected = EmployeeRecoveryApproval.parse(JSON.parse(serializedApproval));
const store = new CompanyStore(join(root, 'company.json'));
await store.init();
const main = new StateStore(join(root, 'state.json')),
  saved = main.getSession(sessionId);
assert.ok(saved);
const session = new Session({
  id: sessionId,
  mode: saved.mode,
  workingDir: saved.workingDir,
  owner: saved.owner,
  useMux: false,
  publicationStore: main,
  providerDispatchHeld: saved.providerDispatchHeld,
  terminalInputHeld: saved.terminalInputHeld,
});
const rooms = new ChatroomStore(),
  deny = async () => {
    throw Error('Restart fixture forbids lifecycle/effect operations');
  };
const company = new CompanyService(store, {
  getSession: (id) => (id === session.id ? session : undefined),
  chatrooms: {
    rooms: () => rooms.list(),
    room: (id) => rooms.get(id),
    addMember: (id, s, opts) => rooms.addMember(id, s, opts).member,
    setStatus: (id, s, status) => rooms.setStatus(id, s, status),
  },
  research: { start: deny, inspect: deny, stop: deny },
});
const moves = new PlanMoveStore(join(root, 'moves.json'));
const port: PlanMovePort = {
  load: () => moves.load(),
  save: (rows) => moves.save(rows),
  snapshot: deny,
  idle: deny,
  create: deny,
  start: deny,
  ready: deny,
  beforeStop: deny,
  binding: (id) => company.registeredEmployees().find((row) => row.id === id)?.sessionId,
  exists: (id) => id === session.id,
  rebind: deny,
  stop: deny,
  audit: deny,
};
const plans = new PlanMoves(port),
  auth =
    profile === 'office-source'
      ? new OfficeAuthService({
          store: new OwnerAuthStore(join(root, 'owner-auth.json')),
          auditFile: join(root, 'audit'),
          setupEnabled: true,
        })
      : new OwnerAuthService({
          store: new OwnerAuthStore(join(root, 'auth.json')),
          auditFile: join(root, 'audit'),
          setupEnabled: true,
        });
process.stderr.write('restart: authenticating fresh owner\n');
const login = await auth.login(
  profile === 'office-source' ? 'fixture-primary' : 'fixture-owner',
  'Synthetic-recovery-fixture-42!',
  '127.0.0.1'
);
assert.equal(typeof login.session, 'string');
const service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans),
  app = Fastify();
await app.register(cookie);
registerEmployeeRecoveryRoutes(app, service);
const path = '/api/company/employees/' + employeeId + '/recovery';
const headers = { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + login.session };
try {
  process.stderr.write('restart: selecting loaded denial\n');
  const before = await app.inject({ method: 'GET', url: path + '-selection', headers });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().data.recovery.kind, 'owner-unavailable');
  assert.equal(before.json().data.recovery.application.state, 'recovery-required');
  process.stderr.write('restart: refusing loaded effect\n');
  const effect = await app.inject({ method: 'POST', url: path, headers, payload: { approval: selected } });
  assert.equal(effect.statusCode, 409, effect.body);
  process.stderr.write('restart: observing original channel\n');
  const observed = await app.inject({
    method: 'POST',
    url: path + '/observe',
    headers,
    payload: { approval: selected },
  });
  assert.equal(observed.statusCode, 200, observed.body);
  assert.equal(observed.json().data.application.state, 'completed-stopped');
  assert.equal(store.snapshot().employees.find((row) => row.id === employeeId)?.desiredRunning, false);
  assert.equal(company.employeeRecoveryAvailable(employeeId, session.owner), true);
  assert.equal(session.pid, null);
  assert.equal(session.providerDispatchHeld, false);
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      loadedDenied: true,
      freshOwner: true,
      freshOriginalObserve: true,
      completedStopped: true,
      noProvider: true,
    }) + '\n'
  );
} finally {
  service.close();
  await app.close();
  assert.equal(session.pid, null);
  await session.stop(false);
  process.stderr.write('restart: cleanup complete ' + JSON.stringify(process.getActiveResourcesInfo()) + '\n');
}
