import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerPlanMoveRoutes } from '../src/web/routes/plan-move-routes.js';
import { StaleExpirationMap } from '../src/utils/stale-expiration-map.js';
import type { AuthSessionRecord } from '../src/web/ports/auth-port.js';
import type { PlanMoves, PlanMoveExecutor } from '../src/plan-move.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { dockerPlanMaximumStates, dockerPlanMaximumStateBytes } from '../src/docker-plan-move-capacity.js';
import { assertDockerPlanMoveTransition, DockerPlanMoveJournalState } from '../src/docker-plan-move-data.js';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import { PlanMoveStore, dockerPlanMoveNotIssuedOf } from '../src/plan-move-store.js';
import type { PlanMoveRecord } from '../src/plan-move.js';
const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'plan-capacity-'));
  cleanup.push(dir);
  return new PlanMoveStore(join(dir, 'moves.json'));
}
function candidate(index: number, huge = false) {
  const f = dockerPlanJournalFixture(),
    seed = structuredClone(f.state.seed);
  const id = (prefix: string) => prefix + '0000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
  const row = seed.source.record;
  row.employeeId = id('1');
  row.request.sessionId = id('2');
  row.request.operationId = id('3');
  row.credentialId = id('6');
  row.original = {
    ...row.original,
    containerId: '1' + String(index + 1).padStart(63, '0'),
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
  };
  row.request.containerId = row.original.containerId;
  row.destination = {
    ...row.destination!,
    containerId: '2' + String(index + 1).padStart(63, '0'),
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
  };
  if (huge) {
    const maximum = dockerPlanMaximumStates(f.state.seed, f.epoch)[1]!.work!;
    row.policy = maximum.policy;
    row.request.expectedPolicyDigest = dockerContinuationDigest(row.policy);
    row.original.home.source = '\0'.repeat(4096);
    row.destination.home.source = row.original.home.source;
    row.pool = maximum.pool;
    row.tasks = maximum.tasks;
    row.ephemeralRestoration = structuredClone(maximum.ephemeralRestoration);
    for (const attempt of row.ephemeralRestoration!.attempts) {
      attempt.request.employeeId = row.employeeId;
      attempt.request.sessionId = row.request.sessionId;
      attempt.request.operationId = row.request.operationId;
      attempt.request.sessionGeneration = row.request.sessionGeneration;
    }
  }
  seed.source.record = DockerEmployeeContinuationRecord.parse(row);
  seed.source.binding = {
    ...seed.source.binding,
    containerId: row.destination!.containerId,
    originalDigest: dockerContinuationDigest(row.destination),
    policyDigest: dockerContinuationDigest(row.policy),
    sessionId: row.request.sessionId,
    operationId: row.request.operationId,
    credentialId: row.credentialId,
  };
  seed.moveId = 'capacity-' + index;
  seed.target.sessionId = id('4');
  seed.target.operationId = id('5');
  seed.target.credentialId = id('7');
  const state = DockerPlanMoveJournalState.parse({ ...f.state, seed });
  const record: PlanMoveRecord = {
    ...f.record,
    id: seed.moveId,
    employeeId: row.employeeId,
    oldSession: row.request.sessionId,
    newSession: seed.target.sessionId,
    dockerReplacement: state,
  };
  return { record, state };
}
function compactCompletion(state: ReturnType<typeof candidate>['state']) {
  const maximum = dockerPlanMaximumStates(state.seed, state.epoch)[1]!;
  return DockerPlanMoveJournalState.parse({
    ...maximum,
    work: {
      ...maximum.work!,
      phase: 'ready',
      ephemeralRestoration: undefined,
      pool: { ...maximum.work!.pool!, cgroupParent: '/synthetic-pool' },
    },
  });
}
async function publishMaximum(
  s: PlanMoveStore,
  record: PlanMoveRecord,
  maximum: ReturnType<typeof dockerPlanMaximumStates>[number]
) {
  const original = record.dockerReplacement!,
    reader = maximum.sourceReader!;
  if (reader.phase !== 'closed' || !reader.init) throw Error('Maximum closed reader required');
  let state = DockerPlanMoveJournalState.parse({ ...original, sourceStop: maximum.sourceStop });
  await s.dockerPublish(record.id, original, state, () => {});
  const base = {
    version: reader.version,
    purpose: reader.purpose,
    name: reader.name,
    imageId: reader.imageId,
    configurationDigest: reader.configurationDigest,
  };
  for (const cursor of [
    { ...base, phase: 'create-issued' },
    { ...base, phase: 'created', containerId: reader.containerId },
    { ...base, phase: 'start-issued', containerId: reader.containerId },
    { ...base, phase: 'running', containerId: reader.containerId, init: reader.init },
    { ...base, phase: 'close-issued', containerId: reader.containerId, init: reader.init },
    reader,
  ]) {
    const next = DockerPlanMoveJournalState.parse({ ...state, sourceReader: cursor });
    await s.dockerPublish(record.id, state, next, () => {});
    state = next;
  }
  const issued = DockerPlanMoveJournalState.parse({ ...maximum, handoff: { ...maximum.handoff!, phase: 'issued' } });
  await s.dockerPublish(record.id, state, issued, () => {});
  return s.dockerPublish(record.id, issued, maximum, () => {});
}
describe('whole-document native settlement capacity', () => {
  it('requires the original handoff input intent and retains uncertain input without permitting a replay', () => {
    const f = candidate(0),
      completed = dockerPlanMaximumStates(f.state.seed, f.state.epoch)[1]!;
    const before = DockerPlanMoveJournalState.parse({ ...completed, handoff: undefined });
    const issued = DockerPlanMoveJournalState.parse({
      ...completed,
      handoff: { ...completed.handoff!, phase: 'issued' },
    });
    expect(() => assertDockerPlanMoveTransition(before, completed)).toThrow('original input intent');
    expect(() => assertDockerPlanMoveTransition(before, issued)).not.toThrow();
    expect(() => assertDockerPlanMoveTransition(issued, completed)).not.toThrow();
    expect(() => assertDockerPlanMoveTransition(issued, before)).toThrow('publication changed');
    expect(() => assertDockerPlanMoveTransition(completed, issued)).toThrow('publication changed');
    expect(() =>
      DockerPlanMoveJournalState.parse({ ...issued, handoff: { ...issued.handoff!, digest: '0'.repeat(64) } })
    ).toThrow();
  });
  it('decodes constructive maxima including all32 escaped paths and duplicated source identities', async () => {
    const f = candidate(0, true),
      s = await store();
    await s.save([f.record]);
    expect(Buffer.byteLength(JSON.stringify(f.state.seed.source.record))).toBeGreaterThan(850000);
    const maximum = dockerPlanMaximumStateBytes(f.state.seed, f.state.epoch);
    expect(maximum).toBeGreaterThan(1_700_000);
    const actual = await s.dockerRecord(f.record.id);
    expect(actual.dockerSettlementBudget?.maxRecordBytes).toBeGreaterThan(maximum + 24000);
    expect(
      dockerPlanMaximumStates(f.state.seed, f.state.epoch)[0]!.work!.planReplacement.source.networkIds
    ).toHaveLength(16);
    for (const witness of dockerPlanMaximumStates(f.state.seed, f.state.epoch))
      expect(DockerPlanMoveJournalState.parse(JSON.parse(JSON.stringify(witness)))).toEqual(witness);
    expect(
      Buffer.byteLength(
        JSON.stringify(dockerPlanMaximumStates(f.state.seed, f.state.epoch)[0]!.work!.ephemeralRestoration)
      )
    ).toBeGreaterThan(800000);
  });
  it('refuses only the new original before publication while keeping all prior closure reserves', async () => {
    const s = await store(),
      rows: PlanMoveRecord[] = [];
    let denied: unknown, next: ReturnType<typeof candidate> | undefined;
    for (let i = 0; i < 8; i++) {
      const f = candidate(i, true);
      try {
        await s.save([...rows, f.record]);
        rows.push(f.record);
      } catch (error) {
        denied = error;
        next = f;
        break;
      }
    }
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(4);
    const before = await readFile(s.file, 'utf8'),
      receipt = dockerPlanMoveNotIssuedOf(denied);
    expect(receipt).toMatchObject({
      purpose: 'docker-plan-move-not-issued-v1',
      code: 'CAPACITY',
      action: 'begin',
      publication: 'not-issued',
      id: next!.record.id,
      employeeId: next!.record.employeeId,
      sessionId: next!.record.oldSession,
      sessionGeneration: 1,
      toAccount: next!.record.toAccount,
      requestDigest: next!.record.requestDigest,
    });
    expect(await readFile(s.file, 'utf8')).toBe(before);
    await expect(s.dockerRecord(next!.record.id)).rejects.toThrow();
    // Each earlier request can still publish the complete maximum state: no effect
    // dispatch here, only real canonical file writes testing the reserved bound.
    for (const row of rows) {
      const state = row.dockerReplacement!,
        maximum = dockerPlanMaximumStates(state.seed, state.epoch)[1]!;
      await publishMaximum(s, row, maximum);
    }
    expect((await readFile(s.file)).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(dockerPlanMoveNotIssuedOf(new Error('Plan move settlement capacity is unavailable'))).toBeUndefined();
    expect(dockerPlanMoveNotIssuedOf({ notIssued: receipt })).toBeUndefined();
  });
  it('releases only immutable terminal growth reserve while retaining every source/account history', async () => {
    const s = await store(),
      rows: PlanMoveRecord[] = [];
    let next: ReturnType<typeof candidate> | undefined;
    for (let i = 0; i < 8; i++) {
      const f = candidate(i, true);
      try {
        await s.save([...rows, f.record]);
        rows.push(f.record);
      } catch {
        next = f;
        break;
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!,
        done = compactCompletion(row.dockerReplacement!);
      const actual = await publishMaximum(s, row, done);
      rows[i] = { ...actual, phase: 'completed' };
    }
    await s.save(rows);
    await s.save([...rows, next!.record]);
    expect((await s.load()).map((r) => r.id)).toEqual([...rows, next!.record].map((r) => r.id));
    for (const row of rows) {
      const original = await s.dockerRecord(row.id);
      expect(original.dockerReplacement!.seed.source.record).toEqual(row.dockerReplacement!.seed.source.record);
      expect(() =>
        s.dockerCurrent(row.id, row.dockerReplacement!.epoch, dockerContinuationDigest(row.dockerReplacement!.seed))
      ).toThrow('cannot dispatch');
      await expect(s.dockerPublish(row.id, row.dockerReplacement!, row.dockerReplacement!, () => {})).rejects.toThrow(
        'immutable'
      );
    }
    await expect(s.save([{ ...rows[0]!, phase: 'recovery-required' }, ...rows.slice(1), next!.record])).rejects.toThrow(
      'immutable'
    );
  });
  it('retains a failed unissued cursor as immutable history without reserving new effects forever', async () => {
    const s = await store(),
      f = candidate(0);
    await s.save([f.record]);
    const failed: PlanMoveRecord = {
      ...(await s.dockerRecord(f.record.id)),
      phase: 'failed',
      error: 'Cancelled before source intent',
    };
    await s.save([failed]);
    expect(() => s.dockerCurrent(f.record.id, f.state.epoch, dockerContinuationDigest(f.state.seed))).toThrow(
      'cannot dispatch'
    );
    await expect(
      s.dockerClaim(
        f.record.id,
        f.state,
        '90000000-0000-4000-8000-000000000009',
        () => {},
        () => {}
      )
    ).rejects.toThrow('immutable');
    expect((await s.dockerRecord(f.record.id)).phase).toBe('failed');
  });

  it('bounds the optional source reader and refuses scope changes or paid dispatch before closure', () => {
    const f = candidate(0),
      maximum = dockerPlanMaximumStates(f.state.seed, f.state.epoch)[1]!,
      reader = maximum.sourceReader!;
    if (reader.phase !== 'closed' || !reader.init) throw Error('Maximum reader required');
    const base = {
      version: reader.version,
      purpose: reader.purpose,
      name: reader.name,
      imageId: reader.imageId,
      configurationDigest: reader.configurationDigest,
      phase: 'create-issued' as const,
    };
    expect(() => DockerPlanMoveJournalState.parse({ ...f.state, sourceReader: base })).toThrow();
    const stopped = DockerPlanMoveJournalState.parse({ ...f.state, sourceStop: maximum.sourceStop });
    const created = DockerPlanMoveJournalState.parse({ ...stopped, sourceReader: base });
    expect(() => assertDockerPlanMoveTransition(stopped, created)).not.toThrow();
    expect(() => assertDockerPlanMoveTransition(stopped, maximum)).toThrow('original create intent');
    expect(() => assertDockerPlanMoveTransition(created, stopped)).toThrow('scope changed');
    expect(() =>
      DockerPlanMoveJournalState.parse({ ...maximum, sourceReader: { ...reader, imageId: 'sha256:' + '0'.repeat(64) } })
    ).toThrow();
    expect(() =>
      DockerPlanMoveJournalState.parse({
        ...maximum,
        sourceReader: { ...base, phase: 'running', containerId: reader.containerId, init: reader.init },
      })
    ).toThrow();
    expect(() =>
      assertDockerPlanMoveTransition(maximum, {
        ...maximum,
        sourceReader: { ...reader, terminalStateDigest: '0'.repeat(64) },
      })
    ).toThrow('cursor changed');
    expect(() => DockerPlanMoveJournalState.parse({ ...created, sourceReader: { ...base, token: 'never' } })).toThrow();
  });
  it('never turns a lost consuming lock-close acknowledgement into not-issued authority', async () => {
    const s = await store(),
      rows: PlanMoveRecord[] = [];
    let next: ReturnType<typeof candidate> | undefined;
    for (let i = 0; i < 8; i++) {
      const f = candidate(i, true);
      try {
        await s.save([...rows, f.record]);
        rows.push(f.record);
      } catch {
        next = f;
        break;
      }
    }
    const before = await readFile(s.file, 'utf8'),
      open = fs.open.bind(fs);
    let lost = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === s.file + '.lock') {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          lost = true;
          throw Error('Lost lock close acknowledgement');
        };
      }
      return handle;
    });
    let error: unknown;
    try {
      await s.save([...rows, next!.record]);
    } catch (value) {
      error = value;
    }
    expect(lost).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(dockerPlanMoveNotIssuedOf(error)).toBeUndefined();
    expect(await readFile(s.file, 'utf8')).toBe(before);
  });
  it('surfaces only the exact genuine capacity origin through the ordinary owner force HTTP route', async () => {
    const s = await store(),
      rows: PlanMoveRecord[] = [];
    let next: ReturnType<typeof candidate> | undefined, error: unknown;
    for (let i = 0; i < 8; i++) {
      const f = candidate(i, true);
      f.record.owner = undefined;
      f.state.seed.source.record.owner = undefined;
      try {
        await s.save([...rows, f.record]);
        rows.push(f.record);
      } catch (value) {
        next = f;
        error = value;
        break;
      }
    }
    const receipt = dockerPlanMoveNotIssuedOf(error)!;
    expect(receipt).toBeDefined();
    const app = Fastify();
    await app.register(cookie);
    const sessions = new StaleExpirationMap<string, AuthSessionRecord>({ ttlMs: 60_000 });
    sessions.set('owner', { ip: '127.0.0.1', ua: 'synthetic', createdAt: Date.now(), method: 'basic' });
    let failure = error,
      dispatches = 0;
    // Actual HTTP and actual Store-origin classification only. Physical actor ports
    // are absent: this test does not claim native plan admission/closure.
    registerPlanMoveRoutes(
      app,
      {
        begin: async () => {
          dispatches++;
          throw failure;
        },
      } as unknown as PlanMoves,
      { authSessions: sessions },
      undefined,
      () =>
        ({
          snapshot: async () => ({
            sessionId: next!.record.oldSession,
            account: next!.record.fromAccount,
            name: 'Synthetic',
            working: false,
            mode: 'claude',
          }),
        }) as unknown as PlanMoveExecutor,
      async () => 'claude'
    );
    await app.ready();
    try {
      const body = {
        id: next!.record.id,
        employeeId: next!.record.employeeId,
        sessionId: next!.record.oldSession,
        toAccount: next!.record.toAccount,
        handoff: 'Synthetic handoff.',
      };
      const invoke = (payload = body) =>
        app.inject({
          method: 'POST',
          url: '/api/plans/moves/force',
          headers: { host: 'office.test', origin: 'https://office.test', cookie: 'reverie_session=owner' },
          payload,
        });
      const denied = await invoke();
      expect(denied.statusCode).toBe(409);
      expect(denied.json().notIssued).toEqual(receipt);
      expect((await invoke({ ...body, id: 'different-original' })).json()).not.toHaveProperty('notIssued');
      failure = Object.assign(Error('Plan move settlement capacity is unavailable'), { notIssued: receipt });
      expect((await invoke()).json()).not.toHaveProperty('notIssued');
      expect(dispatches).toBe(3);
      expect(await readFile(s.file, 'utf8')).not.toContain(next!.record.id);
    } finally {
      sessions.dispose();
      await app.close();
    }
  });
});
