/** The signed-in owner's explicit abandonment of a plan move that is held for
 * recovery, over the real private journal. No Engine, provider or live data. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanMoveStore, dockerPlanMoveContainers } from '../src/plan-move-store.js';
import { PlanMoveError, PlanMoves, type PlanMovePort } from '../src/plan-move.js';
import { DockerPlanMoveJournalState } from '../src/docker-plan-move-data.js';
import { dockerPlanMaximumStates } from '../src/docker-plan-move-capacity.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import { registerPlanMoveRoutes } from '../src/web/routes/plan-move-routes.js';
import { RECOVERY_HEADER } from '../src/worker-recovery-auth.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';

const helperImage = 'sha256:' + '9'.repeat(64);
const holderCid = '1'.repeat(64),
  storageCid = '2'.repeat(64),
  leafCid = '3'.repeat(64),
  anchorCid = '4'.repeat(64),
  targetCid = '5'.repeat(64);
const task = (role: string, containerId: string) => ({
  role,
  name: 'reverie-boxed-' + role + '-synthetic',
  imageId: helperImage,
  configurationDigest: 'b'.repeat(64),
  phase: 'created' as const,
  containerId,
});
/** Cursor DATA of a move stopped after it created its candidate: a closed
 * holder and recorded helpers, each under its own ID. Shape only; the durable
 * cases below use states the journal itself accepts. */
function heldState() {
  const fx = dockerPlanJournalFixture();
  const destination = { ...fx.work.original, containerId: targetCid };
  const state = {
    ...fx.closed,
    sourceReader: {
      version: 1,
      purpose: 'docker-plan-source-reader-v1',
      name: 'reverie-boxed-' + 'c'.repeat(64),
      imageId: fx.state.seed.target.workerImage.imageId,
      configurationDigest: 'd'.repeat(64),
      phase: 'closed',
      containerId: holderCid,
      terminalStateDigest: 'e'.repeat(64),
    },
    material: fx.material,
    work: {
      ...fx.work,
      phase: 'resources-issued',
      pool: {
        containerId: anchorCid,
        cgroupParent: 'synthetic.slice',
        policyDigest: dockerContinuationDigest(fx.work.policy.pool),
        physicalDigest: 'f'.repeat(64),
      },
      destination,
      tasks: [
        task('storage-holder', storageCid),
        task('anchor', anchorCid),
        task('leaf-helper', leafCid),
        { ...task('identity-helper', '6'.repeat(64)), phase: 'create-issued' as const, containerId: undefined },
      ],
    },
  } as unknown as DockerPlanMoveJournalState;
  return { fx, state };
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plan-owner-abandon-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A durable journal whose source is closed; `advanced` adds the candidate and its helpers. */
async function journal(advanced = false) {
  const fx = dockerPlanJournalFixture();
  const store = new PlanMoveStore(join(directory, 'moves.json'));
  await store.save([fx.record]);
  await store.dockerPublish(fx.record.id, fx.state, fx.closed, () => {});
  let state = fx.closed;
  if (advanced) {
    // Recording native state only, as the runner suite does: no Engine effect.
    const maximum = dockerPlanMaximumStates(fx.closed.seed, fx.closed.epoch)[1]!;
    state = DockerPlanMoveJournalState.parse({
      ...maximum,
      sourceStop: fx.closed.sourceStop,
      sourceReader: undefined,
      companyPublication: undefined,
      handoff: undefined,
    });
    await store.dockerPublish(fx.record.id, fx.closed, state, () => {});
  }
  const port = {
    load: () => store.load(),
    save: (records) => store.save(records),
    dockerJournal: {
      record: (id: string) => store.dockerRecord(id),
      abandonOwner: (...args: Parameters<PlanMoveStore['abandonOwnerDockerMove']>) =>
        store.abandonOwnerDockerMove(...args),
      abandonAbsent: (...args: Parameters<PlanMoveStore['abandonAbsentDockerMove']>) =>
        store.abandonAbsentDockerMove(...args),
    },
  } as unknown as PlanMovePort;
  return { fx, state, store, port, moves: new PlanMoves(port) };
}

describe('recorded containers of a move', () => {
  it('names the source, candidate, holder and per-operation helpers but never the shared pool', () => {
    const { fx, state } = heldState();
    expect(dockerPlanMoveContainers(state)).toEqual({
      source: fx.state.seed.source.binding.containerId,
      target: targetCid,
      sourceHolder: holderCid,
      helpers: [
        { role: 'storage-holder', containerId: storageCid },
        { role: 'leaf-helper', containerId: leafCid },
      ],
    });
    expect(JSON.stringify(dockerPlanMoveContainers(state))).not.toContain(anchorCid);
    // A move that stopped before creating anything names only where it started.
    expect(dockerPlanMoveContainers(fx.state)).toEqual({
      source: fx.state.seed.source.binding.containerId,
      helpers: [],
    });
  });
});

describe('owner abandonment of a held move', () => {
  it('closes the held move, releases the employee and records what the move named', async () => {
    const { fx, store, moves } = await journal();
    const owner = fx.record.owner,
      employee = fx.record.employeeId;
    // After a restart every open move is held for recovery and locks its employee.
    const held = await moves.get(fx.record.id, owner);
    expect(held).toMatchObject({ phase: 'recovery-required', allowedActions: ['continue-original', 'abandon'] });
    await expect(moves.assertAvailable(employee, owner)).rejects.toMatchObject({
      blocker: { id: fx.record.id, action: 'inspect-existing' },
    });
    const authorized = vi.fn();
    const closed = await moves.abandonHeldDockerMove(fx.record.id, employee, owner, authorized);
    expect(authorized).toHaveBeenCalled();
    expect(closed).toMatchObject({
      phase: 'failed',
      allowedActions: [],
      dockerAbandonment: {
        version: 1,
        reason: 'owner-abandoned',
        containers: { source: fx.state.seed.source.binding.containerId, helpers: [] },
      },
    });
    expect(closed.error).toContain('Abandoned by the owner');
    // The private journal is never exposed, and the closed record is durable history.
    expect(closed).not.toHaveProperty('dockerReplacement');
    const durable = await new PlanMoveStore(store.file).dockerRecord(fx.record.id);
    expect(durable).toMatchObject({
      phase: 'failed',
      dockerAbandonment: { reason: 'owner-abandoned' },
      dockerReplacement: fx.closed,
    });
    // The lock is gone: discovery and the absent workflow see no open move.
    await expect(moves.assertAvailable(employee, owner)).resolves.toBeUndefined();
    expect(await moves.openMoves(employee, owner)).toEqual([]);
    expect(await moves.ownerAbandonedContainers(employee, owner)).toEqual([
      { moveId: fx.record.id, containers: { source: fx.state.seed.source.binding.containerId, helpers: [] } },
    ]);
    expect(await moves.ownerAbandonedContainers(employee, 'someone-else')).toEqual([]);
    // No late actor can dispatch from the closed journal.
    expect(() => store.dockerCurrent(fx.record.id, fx.epoch, dockerContinuationDigest(fx.state.seed))).toThrow(
      'Terminal native plan history cannot dispatch'
    );
    // A replay answers with the same closed record and writes nothing.
    await expect(moves.abandonHeldDockerMove(fx.record.id, employee, owner)).resolves.toMatchObject({
      phase: 'failed',
      dockerAbandonment: { at: closed.dockerAbandonment!.at },
    });
    // After a restart the closed move stays closed and locks nothing.
    const restarted = new PlanMoves({
      load: () => new PlanMoveStore(store.file).load(),
      save: async () => {},
    } as unknown as PlanMovePort);
    await expect(restarted.assertAvailable(employee, owner)).resolves.toBeUndefined();
    expect(await restarted.get(fx.record.id, owner)).toMatchObject({ phase: 'failed' });
  });
  it('records the candidate and helpers the journal named at that moment', async () => {
    const { fx, state, store, moves } = await journal(true);
    const named = dockerPlanMoveContainers(state);
    expect(named.target).toMatch(/^[a-f0-9]{64}$/);
    expect(named.target).not.toBe(named.source);
    expect(named.helpers.length).toBeGreaterThan(0);
    // A stale cursor cannot close the move: the store derives the list from its own current one.
    await expect(store.abandonOwnerDockerMove(fx.record.id, fx.closed, 8, () => {})).rejects.toThrow(
      'Original Docker plan move cursor changed'
    );
    const closed = await moves.abandonHeldDockerMove(fx.record.id, fx.record.employeeId, fx.record.owner);
    expect(closed.dockerAbandonment).toMatchObject({ reason: 'owner-abandoned', containers: named });
    expect(await moves.ownerAbandonedContainers(fx.record.employeeId, fx.record.owner)).toEqual([
      { moveId: fx.record.id, containers: named },
    ]);
    // Issued native work stays immutable history under the abandonment.
    const durable = await store.dockerRecord(fx.record.id);
    expect(durable.phase).toBe('failed');
    expect(dockerContinuationDigest(durable.dockerReplacement)).toBe(dockerContinuationDigest(state));
    await expect(store.dockerPhase(fx.record.id, state, { phase: 'recovery-required' }, () => {})).rejects.toThrow(
      'Terminal native plan history is immutable'
    );
  });
  it('refuses another owner, another employee, a busy move and a move that is not held', async () => {
    const { fx, moves, port } = await journal();
    const owner = fx.record.owner,
      employee = fx.record.employeeId;
    await expect(moves.abandonHeldDockerMove(fx.record.id, employee, 'someone-else')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      moves.abandonHeldDockerMove(fx.record.id, '90000000-0000-4000-8000-000000000009', owner)
    ).rejects.toMatchObject({ status: 404 });
    await expect(moves.abandonHeldDockerMove('unknown', employee, owner)).rejects.toMatchObject({ status: 404 });
    // A revoked owner changes nothing.
    await expect(
      moves.abandonHeldDockerMove(fx.record.id, employee, owner, () => {
        throw new PlanMoveError('revoked', 403);
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(await moves.get(fx.record.id, owner)).toMatchObject({ phase: 'recovery-required' });
    // A flight that owns the move (a viewer repair, a continuation) excludes the abandonment.
    const lease = await moves.viewerInspectionGuard(employee, owner);
    await expect(moves.abandonHeldDockerMove(fx.record.id, employee, owner)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('still working'),
    });
    lease.close();
    // Without the journal's own closure the move keeps its recovery.
    const plain = new PlanMoves({ ...port, dockerJournal: { record: port.dockerJournal!.record } } as never);
    await expect(plain.abandonHeldDockerMove(fx.record.id, employee, owner)).rejects.toMatchObject({ status: 409 });
    expect(await plain.get(fx.record.id, owner)).toMatchObject({ allowedActions: ['continue-original'] });
    await moves.abandonHeldDockerMove(fx.record.id, employee, owner);
    expect(await moves.get(fx.record.id, owner)).toMatchObject({ phase: 'failed' });
  });
  it('keeps the move held when the journal does not confirm, and settles a lost acknowledgement', async () => {
    const { fx, store, port } = await journal();
    const owner = fx.record.owner,
      employee = fx.record.employeeId;
    let outcome: 'fail' | 'lost' = 'fail';
    const flaky = new PlanMoves({
      ...port,
      dockerJournal: {
        ...port.dockerJournal!,
        abandonOwner: async (...args: Parameters<PlanMoveStore['abandonOwnerDockerMove']>) => {
          if (outcome === 'lost') await store.abandonOwnerDockerMove(...args);
          throw Error('synthetic journal failure with private detail');
        },
      },
    } as never);
    const refused = await flaky.abandonHeldDockerMove(fx.record.id, employee, owner).catch((error) => error);
    expect(refused).toBeInstanceOf(PlanMoveError);
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('still held') });
    expect(refused.message).not.toContain('private detail');
    expect(await flaky.get(fx.record.id, owner)).toMatchObject({ phase: 'recovery-required' });
    await expect(flaky.assertAvailable(employee, owner)).rejects.toBeInstanceOf(PlanMoveError);
    // The write landed but its answer was lost: the retry adopts the durable record.
    outcome = 'lost';
    await expect(flaky.abandonHeldDockerMove(fx.record.id, employee, owner)).rejects.toMatchObject({ status: 409 });
    await expect(flaky.abandonHeldDockerMove(fx.record.id, employee, owner)).resolves.toMatchObject({
      phase: 'failed',
      dockerAbandonment: { reason: 'owner-abandoned' },
    });
    await expect(flaky.assertAvailable(employee, owner)).resolves.toBeUndefined();
  });
});

describe('abandon route', () => {
  async function app(result: () => Promise<unknown>) {
    const server = Fastify();
    await server.register(cookie);
    const abandonHeldDockerMove = vi.fn(async (_id: string, _employee: string, _owner: unknown, check: () => void) => {
      check();
      return result();
    });
    const sessions = new Map([['owner', { ip: '127.0.0.1', ua: 'test', createdAt: 1, method: 'basic' }]]);
    registerPlanMoveRoutes(
      server,
      { abandonHeldDockerMove } as never,
      { authSessions: sessions as never },
      undefined,
      () => ({}) as never
    );
    const headers = { host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=owner' };
    const send = (extra: Record<string, string> = {}, payload: unknown = { employeeId: 'expert' }) =>
      server.inject({ method: 'POST', url: '/api/plans/moves/held/abandon', headers: { ...headers, ...extra }, payload });
    return { server, send, abandonHeldDockerMove, sessions };
  }
  it('abandons for the signed-in owner and names the next step', async () => {
    const f = await app(async () => ({ id: 'held', phase: 'failed' }));
    const response = await f.send();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      success: true,
      data: { id: 'held', phase: 'failed' },
      allowedActions: ['rebuild'],
      message: expect.stringContaining('Nothing was stopped or removed'),
    });
    expect(f.abandonHeldDockerMove).toHaveBeenCalledWith('held', 'expert', undefined, expect.any(Function));
    await f.server.close();
  });
  it('refuses every caller that is not the signed-in owner before any journal code', async () => {
    const f = await app(async () => ({ id: 'held', phase: 'failed' }));
    for (const extra of [
      { 'x-reverie-parent-session': 'agent' },
      { 'x-reverie-service-token': 'token' },
      { 'x-reverie-worker-identity': 'identity' },
      { [RECOVERY_HEADER]: 'proof' },
      { origin: 'https://evil.test' },
      { cookie: '' },
    ])
      expect((await f.send(extra)).statusCode, JSON.stringify(extra)).toBe(403);
    expect((await f.send({}, {})).statusCode).toBe(400);
    expect((await f.send({}, { employeeId: 'expert', force: true })).statusCode).toBe(400);
    expect(f.abandonHeldDockerMove).not.toHaveBeenCalled();
    await f.server.close();
  });
  it('rechecks the owner sign-in inside the journal transaction', async () => {
    const f = await app(async () => ({ id: 'held', phase: 'failed' }));
    f.abandonHeldDockerMove.mockImplementationOnce(async (_id, _employee, _owner, check) => {
      f.sessions.clear();
      check();
      return {};
    });
    expect((await f.send()).statusCode).toBe(403);
    await f.server.close();
  });
  it('answers a refusal with a sentence and the action that is still open', async () => {
    const f = await app(async () => {
      throw new PlanMoveError('This move is still working on a step; wait until it is held for recovery', 409);
    });
    const response = await f.send();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('still working'),
      allowedActions: ['status'],
    });
    const missing = await app(async () => {
      throw new PlanMoveError('Unknown move', 404);
    });
    expect((await missing.send()).statusCode).toBe(404);
    await f.server.close();
    await missing.server.close();
  });
});
