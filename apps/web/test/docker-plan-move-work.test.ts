/** Real target-work coordinator and durable PlanMoveStore, with controlled native
 * observation ports. These tests prove orchestration/fencing, not Docker effects. */
import fs from 'node:fs';
import ts from 'typescript';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerPlanMoveWork } from '../src/docker-plan-move-work.js';
import { DockerPlanMoveJournalState } from '../src/docker-plan-move-data.js';
import { DockerEmployeePlanReplacementWorkRecord } from '../src/docker-employee-continuation-data.js';
import type { DockerContainerObservation } from '../src/docker-employee-continuation.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import { DockerResourceRevisionStore } from '../src/docker-resource-revisions.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import type { PlanMoveDockerJournal } from '../src/plan-move-docker.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import type {
  DockerContinuationTask,
  DockerContinuationTaskRole,
  DockerContinuationTaskJournal,
} from '../src/docker-continuation-task.js';
import { EphemeralRestoration, type EphemeralJournal } from '../src/docker-ephemeral-data.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';

// Capture the public constructor boundary while retaining the actual Engine.
// This exposes only Work's supplied journal port to the contract tests below;
// it grants no native proof, and unexpected native commands still fail.
const taskPorts = vi.hoisted(() => new WeakMap<object, DockerContinuationTaskJournal & EphemeralJournal>());
const resourcePins = vi.hoisted(() => new WeakMap<object, string | undefined>());
vi.mock('../src/docker-contained-resource-controller.js', async (original) => {
  const actual = await original<typeof import('../src/docker-contained-resource-controller.js')>();
  return {
    ...actual,
    DockerContainedResources: class extends actual.DockerContainedResources {
      constructor(...args: ConstructorParameters<typeof actual.DockerContainedResources>) {
        super(...args);
        resourcePins.set(this, args[2].poolRestoreHelperImageId);
      }
    },
  };
});

it.each([
  'poolRestoreHelperImageId',
  'leafWriterHelperImageId',
])('forwards the optional %s at the actual Actor work-construction boundary', (pin) => {
  const file = new URL('../src/docker-plan-move-actor.ts', import.meta.url);
  const source = ts.createSourceFile(file.pathname, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const actor = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'DockerPlanMoveActor'
  );
  const method = actor?.members.find(
    (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === '#workFor'
  );
  const calls: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'DockerPlanMoveWork')
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  if (method) visit(method);
  expect(calls).toHaveLength(1);
  const input = calls[0]!.arguments?.[0];
  expect(input && ts.isObjectLiteralExpression(input)).toBe(true);
  const field =
    input && ts.isObjectLiteralExpression(input)
      ? input.properties.find(
          (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) && node.name.getText(source) === pin
        )
      : undefined;
  expect(field?.initializer.getText(source)).toBe('this.#d.configuration.' + pin);
});
vi.mock('../src/docker-employee-engine.js', async (original) => {
  const actual = await original<typeof import('../src/docker-employee-engine.js')>();
  return {
    ...actual,
    DockerEmployeeEngine: class extends actual.DockerEmployeeEngine {
      constructor(...args: ConstructorParameters<typeof actual.DockerEmployeeEngine>) {
        super(...args);
        taskPorts.set(this, args[4] as DockerContinuationTaskJournal & EphemeralJournal);
      }
    },
  };
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

async function fixture(phase: DockerEmployeePlanReplacementWorkRecord['phase'] = 'staged') {
  const f = dockerPlanJournalFixture(),
    directory = fs.mkdtempSync(join(tmpdir(), 'plan-work-'));
  fs.chmodSync(directory, 0o700);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const moves = new PlanMoveStore(join(directory, 'moves.json'));
  await moves.dockerReserve(f.record, () => {});
  await moves.dockerPublish(f.record.id, f.state, f.closed, () => {});
  const pool = {
    containerId: '1'.repeat(64),
    cgroupParent: '/synthetic-box',
    policyDigest: dockerContinuationDigest(f.work.policy.pool),
    physicalDigest: '2'.repeat(64),
  };
  const destination = { ...f.work.original, containerId: '0'.repeat(64), sessionId: f.targetSid };
  let state = DockerPlanMoveJournalState.parse({
    ...f.closed,
    material: f.material,
    work: {
      ...f.work,
      phase,
      ...(phase !== 'staged' ? { pool } : {}),
      ...(!['staged', 'pool-issued', 'pool-ready', 'destination-issued'].includes(phase) ? { destination } : {}),
    },
  });
  await moves.dockerPublish(f.record.id, f.closed, state, () => {});
  let revoked = false;
  const current = () => {
    if (revoked) throw Error('Request grant revoked');
    moves.dockerCurrent(f.record.id, f.epoch, dockerContinuationDigest(f.state.seed));
  };
  let publicationFault: ((next: Readonly<DockerPlanMoveJournalState>, after: boolean) => void) | undefined;
  const journal: PlanMoveDockerJournal = {
    moveId: f.record.id,
    epoch: f.epoch,
    publication: 'admitting',
    current,
    read: () => structuredClone(state),
    publish: async (before, next) => {
      current();
      publicationFault?.(next, false);
      await moves.dockerPublish(f.record.id, before, next, current);
      publicationFault?.(next, true);
      state = structuredClone(next);
    },
  };
  const companyStore = new CompanyStore(join(directory, 'company.json'));
  await companyStore.init();
  // No CompanyService operation is admitted by this fixture. Unexpected native
  // commands are likewise a hard failure, not a permissive default response.
  const company = new CompanyService(companyStore, {
    getSession: () => undefined,
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  const command: DockerEngineCommand = {
    run: vi.fn(async () => {
      throw Error('Unexpected native command');
    }),
    create: vi.fn(async () => {
      throw Error('Unexpected native CREATE');
    }),
  };
  const work = new DockerPlanMoveWork(
    {
      command,
      deployment: 'synthetic-office',
      boxId: '7'.repeat(64),
      helperImageId: 'sha256:' + '8'.repeat(64),
      poolRestoreHelperImageId: 'sha256:' + '9'.repeat(64),
      target: { ...f.work.workerImage, sourceImageIds: [f.work.workerImage.imageId] },
      canonical: new CompanyDockerContinuationStore(company, () => undefined),
      moves,
      revisions: new DockerResourceRevisionStore(join(directory, 'revisions')),
      providerMode: 'claude',
    },
    journal
  );
  cleanup.push(() => work.close());
  expect(resourcePins.get(work.resources)).toBe('sha256:' + '9'.repeat(64));
  const calls: string[] = [];
  let observe: DockerContainerObservation | null = {
    original: destination,
    state: phase === 'staged' ? 'stopped' : 'running',
    provider: { kind: 'absent' },
    resources: f.work.policy,
    credentialDigest: null,
  };
  let after: ((name: string) => void) | undefined;
  const record = (name: string) => {
    current();
    calls.push(name);
    after?.(name);
  };
  const validate = vi.spyOn(work.engine, 'validatePlanReplacement').mockImplementation(async () => {
    record('validate');
  });
  vi.spyOn(work.engine, 'prepareStorage').mockImplementation(async () => {
    record('storage');
  });
  vi.spyOn(work.resources, 'prepareRetainedPool').mockImplementation(async () => {
    expect(work.row().phase).toBe('pool-issued');
    record('pool');
  });
  vi.spyOn(work.engine, 'observePool').mockImplementation(async () => {
    record('observe-pool');
    return pool;
  });
  const create = vi.spyOn(work.engine, 'createPlanReplacementDestination').mockImplementation(async () => {
    expect(work.row().phase).toBe('destination-issued');
    record('create');
  });
  const observation = vi.spyOn(work.engine, 'observePlanReplacementWork').mockImplementation(async () => {
    record('observe');
    return structuredClone(observe);
  });
  const start = vi.spyOn(work.engine, 'start').mockImplementation(async () => {
    expect(work.row().phase).toBe('start-issued');
    record('start');
    observe = { ...observe!, state: 'running' };
  });
  const configure = vi.spyOn(work.engine, 'configureResources').mockImplementation(async () => {
    expect(work.row().phase).toBe('resources-issued');
    record('configure');
  });
  vi.spyOn(work.engine, 'settlePlanReplacementStorage').mockImplementation(async () => {
    record('settle-storage');
  });
  vi.spyOn(work.resources, 'settleObservedHelpers').mockImplementation(async () => {
    record('settle-helpers');
  });
  vi.spyOn(work.engine, 'observeStorage').mockImplementation(async () => {
    record('observe-storage');
    return 'ready';
  });
  return {
    ...f,
    work,
    journal,
    moves,
    command,
    calls,
    pool,
    destination,
    validate,
    create,
    start,
    configure,
    observation,
    port: taskPorts.get(work.engine)!,
    get state() {
      return structuredClone(state);
    },
    observe: (value: DockerContainerObservation | null) => {
      observe = value;
    },
    after: (hook?: typeof after) => {
      after = hook;
    },
    fault: (hook?: typeof publicationFault) => {
      publicationFault = hook;
    },
    revoke: () => {
      revoked = true;
    },
    publish: (next: DockerPlanMoveJournalState) => journal.publish(state, next),
    reload: async () => {
      state = structuredClone((await moves.dockerRecord(f.record.id)).dockerReplacement!);
    },
    task: async (role: DockerContinuationTaskRole, phase: DockerContinuationTask['phase']) => {
      const base = {
        role,
        name: 'reverie-boxed-synthetic-' + role,
        imageId: f.work.workerImage.imageId,
        configurationDigest: 'c'.repeat(64),
      };
      const rows: DockerContinuationTask[] = [
        { ...base, phase: 'create-issued' },
        { ...base, phase: 'created', containerId: '3'.repeat(64) },
        { ...base, phase: 'start-issued', containerId: '3'.repeat(64) },
        { ...base, phase: 'running', containerId: '3'.repeat(64), initPid: 42, initStartTicks: '1234' },
        { ...base, phase: 'completed', containerId: '3'.repeat(64), resultDigest: 'd'.repeat(64) },
      ];
      for (const next of rows) {
        await journal.publish(state, { ...state, work: { ...state.work!, tasks: [next] } });
        if (next.phase === phase) break;
      }
    },
  };
}

describe('original Docker target work', () => {
  it('persists intents before effects and re-observes a settled target without another CREATE or START', async () => {
    const f = await fixture();
    await f.work.prepareNative();
    expect(f.work.row()).toMatchObject({ phase: 'resources-ready', pool: f.pool, destination: f.destination });
    expect(f.calls).toEqual([
      'validate',
      'storage',
      'pool',
      'observe-pool',
      'create',
      'observe',
      'start',
      'observe',
      'configure',
      'observe',
    ]);
    const persisted = (await f.moves.dockerRecord(f.record.id)).dockerReplacement;
    expect(persisted).toEqual(f.state);
    await f.work.prepareNative();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.configure).toHaveBeenCalledTimes(1);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(persisted);
    expect(f.command.run).not.toHaveBeenCalled();
    expect(f.command.create).not.toHaveBeenCalled();
  });

  it('keeps a lost CREATE reply issued, refuses missing readback, and adopts only that original destination', async () => {
    const f = await fixture(),
      loss = Error('Lost CREATE reply');
    f.create.mockRejectedValueOnce(loss);
    await expect(f.work.prepareNative()).rejects.toBe(loss);
    expect(f.work.row().phase).toBe('destination-issued');
    f.observe(null);
    await expect(f.work.prepareNative()).rejects.toThrow('CREATE is unconfirmed');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
    f.observe({
      original: f.destination,
      state: 'stopped',
      provider: { kind: 'absent' },
      resources: f.work.row().policy,
      credentialDigest: null,
    });
    await f.work.prepareNative();
    expect(f.work.row().phase).toBe('resources-ready');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('keeps a lost START reply issued and waits for actual running readback without repeating START', async () => {
    const f = await fixture(),
      loss = Error('Lost START reply');
    f.start.mockRejectedValueOnce(loss);
    await expect(f.work.prepareNative()).rejects.toBe(loss);
    expect(f.work.row().phase).toBe('start-issued');
    await expect(f.work.prepareNative()).rejects.toThrow('START is unconfirmed');
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.configure).not.toHaveBeenCalled();
    f.observe({
      original: f.destination,
      state: 'running',
      provider: { kind: 'absent' },
      resources: f.work.row().policy,
      credentialDigest: null,
    });
    await f.work.prepareNative();
    expect(f.work.row().phase).toBe('resources-ready');
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('does not dispatch after a journal publication failure (committed=%s)', async (committed) => {
    const f = await fixture(),
      loss = Error('Publication reply unavailable');
    f.fault((next, after) => {
      if (next.work?.phase === 'destination-issued' && after === committed) throw loss;
    });
    await expect(f.work.prepareNative()).rejects.toBe(loss);
    expect(f.work.row().phase).toBe('pool-ready');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    const durable = (await f.moves.dockerRecord(f.record.id)).dockerReplacement!;
    expect(durable.work?.phase).toBe(committed ? 'destination-issued' : 'pool-ready');
    if (committed) {
      f.fault();
      // The rejected write left the caller's cursor stale. The real store CAS
      // refuses its next publication before any effect can be dispatched.
      await expect(f.work.prepareNative()).rejects.toThrow();
      expect(f.create).not.toHaveBeenCalled();
      await f.reload();
      f.observe(null);
      await expect(f.work.prepareNative()).rejects.toThrow('CREATE is unconfirmed');
      expect(f.create).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.state).toEqual(durable);
    } else expect(durable).toEqual(f.state);
  });

  it.each(['validate', 'storage', 'pool', 'observe-pool', 'create', 'observe', 'start', 'configure'])(
    'refuses further work when authority is revoked across the %s await',
    async (edge) => {
      const f = await fixture();
      f.after((name) => {
        if (name === edge) f.revoke();
      });
      await expect(f.work.prepareNative()).rejects.toThrow('Request grant revoked');
      expect(f.calls.at(-1)).toBe(edge);
      expect(f.state.paidDispatch).toBeUndefined();
      expect(f.state.companyPublication).toBeUndefined();
    }
  );

  it('refuses an unexpectedly running target before its START intent', async () => {
    const f = await fixture('destination-issued');
    await expect(f.work.prepareNative()).rejects.toThrow('START was not issued');
    expect(f.start).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.work.row().phase).toBe('destination-ready');
  });

  it.each([null, 'different-policy'])('holds unconfirmed resource enforcement (%s)', async (kind) => {
    const f = await fixture('resources-issued');
    f.observation.mockResolvedValueOnce({
      original: f.destination,
      state: 'running',
      provider: { kind: 'absent' },
      resources: f.work.row().policy,
      credentialDigest: null,
    });
    f.observation.mockResolvedValueOnce({
      original: f.destination,
      state: 'running',
      provider: { kind: 'absent' },
      resources: f.work.row().policy,
      credentialDigest: null,
    });
    f.observe(
      kind === null
        ? null
        : {
            original: f.destination,
            state: 'running',
            provider: { kind: 'absent' },
            resources: { ...f.work.row().policy, memoryHighBytes: 8 * 1024 ** 3 },
            credentialDigest: null,
          }
    );
    await expect(f.work.prepareNative()).rejects.toThrow('resource helper is unconfirmed');
    expect(f.work.row().phase).toBe('resources-issued');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.state.paidDispatch).toBeUndefined();
  });

  it('rejects phase regression and rejects missing original work', async () => {
    const f = await fixture('resources-ready');
    await expect(f.work.phase('pool-issued')).rejects.toThrow('phase regressed');
    const read = vi.spyOn(f.journal, 'read').mockReturnValue(f.closed);
    expect(() => f.work.row()).toThrow('work is unavailable');
    read.mockRestore();
    expect(f.work.row().phase).toBe('resources-ready');
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(f.state);
  });

  it('does not qualify an original destination whose current readback is missing', async () => {
    const f = await fixture('resources-ready');
    f.observe(null);
    await expect(f.work.inspect()).rejects.toThrow('destination is unconfirmed');
    expect(f.calls).toEqual(['settle-storage', 'settle-helpers', 'observe']);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(f.state);
  });

  it.each(
    (['resources-ready', 'identity-issued', 'identity-ready'] as const).flatMap((phase) =>
      [null, 'different-policy'].map((kind) => ({ phase, kind }))
    )
  )(
    'refuses missing or drifted resources when resuming an already prepared target ($phase/$kind)',
    async ({ phase, kind }) => {
      const f = await fixture(phase);
      const before = f.state;
      f.observe({
        original: f.destination,
        state: 'running',
        provider: { kind: 'absent' },
        resources: kind === null ? null : { ...f.work.row().policy, memoryHighBytes: 8 * 1024 ** 3 },
        credentialDigest: null,
      });
      await expect(f.work.prepareNative()).rejects.toThrow('resource enforcement is unconfirmed');
      expect(f.create).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.configure).not.toHaveBeenCalled();
      expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    }
  );

  it.each(['anchor', 'storage-holder'] as const)(
    'allows a confirmed long-lived %s while inspecting without dispatch',
    async (role) => {
      const f = await fixture('resources-ready');
      await f.task(role, 'running');
      const before = f.state;
      await f.work.inspect();
      expect(f.calls).toEqual([
        'settle-storage',
        'settle-helpers',
        role === 'anchor' ? 'observe-pool' : 'observe-storage',
        'observe',
      ]);
      expect(f.state).toEqual(before);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.configure).not.toHaveBeenCalled();
    }
  );

  it.each(['create-issued', 'start-issued', 'running'] as const)(
    'refuses an unconfirmed helper at %s without repeating its task',
    async (phase) => {
      const f = await fixture('resources-ready');
      await f.task('leaf-helper', phase);
      const before = f.state;
      await expect(f.work.inspect()).rejects.toThrow('writer outcome is unconfirmed');
      expect(f.state).toEqual(before);
      expect(f.command.run).not.toHaveBeenCalled();
      expect(f.command.create).not.toHaveBeenCalled();
    }
  );

  it('lets a terminally failed leaf writer through inspection, and the continued move runs its resource step again', async () => {
    const f = await fixture('resources-issued');
    await f.task('leaf-helper', 'start-issued');
    const started = f.state.work!.tasks![0]!;
    if (started.phase !== 'start-issued') throw Error('Expected a started leaf writer');
    await expect(f.work.inspect()).rejects.toThrow('writer outcome is unconfirmed');
    // What the read-only settlement records once the writer is proved failed.
    const failed = { ...started, phase: 'failed' as const, exitCode: 1, failure: 'lost-process' as const };
    await f.port.publish(f.work.row(), started, failed, () => {});
    await f.work.inspect();
    expect(f.configure).not.toHaveBeenCalled();
    // The claimed continuation then reaches the same resource step, which
    // reruns the writer under the next attempt's own journal intent.
    const retried = {
      role: started.role,
      name: 'reverie-boxed-synthetic-leaf-helper-second',
      imageId: started.imageId,
      configurationDigest: 'e'.repeat(64),
      attempt: 2,
      phase: 'create-issued' as const,
    };
    f.configure.mockImplementationOnce(async () => {
      const row = f.work.row();
      expect(row.tasks?.[0]).toEqual(failed);
      await f.port.publish(row, failed, retried, () => {});
    });
    f.observe({
      original: f.destination,
      state: 'running',
      provider: { kind: 'absent' },
      resources: f.work.row().policy,
      credentialDigest: null,
    });
    await expect(
      f.port.publish(f.work.row(), failed, { ...started, phase: 'completed', resultDigest: 'd'.repeat(64) }, () => {})
    ).rejects.toThrow('original native task changed');
    await f.work.prepareNative();
    expect(f.configure).toHaveBeenCalledOnce();
    expect(f.work.row().phase).toBe('resources-ready');
    expect(f.work.row().tasks?.[0]).toMatchObject({ phase: 'create-issued', attempt: 2, name: retried.name });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(['settle-storage', 'settle-helpers', 'observe-storage', 'observe-pool', 'observe'])(
    'rejects revoked original authority after the %s inspection await',
    async (edge) => {
      const f = await fixture('resources-ready');
      if (edge === 'observe-storage') await f.task('storage-holder', 'running');
      if (edge === 'observe-pool') await f.task('anchor', 'running');
      f.after((name) => {
        if (name === edge) f.revoke();
      });
      await expect(f.work.inspect()).rejects.toThrow('Request grant revoked');
      expect(f.calls.at(-1)).toBe(edge);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    }
  );

  it('requires actual storage and the exact retained pool during inspection', async () => {
    const storage = await fixture('resources-ready');
    await storage.task('storage-holder', 'running');
    vi.spyOn(storage.work.engine, 'observeStorage').mockResolvedValue('unknown');
    await expect(storage.work.inspect()).rejects.toThrow('storage holder is unconfirmed');
    const pool = await fixture('resources-ready');
    await pool.task('anchor', 'running');
    vi.spyOn(pool.work.engine, 'observePool').mockResolvedValue({ ...pool.pool, physicalDigest: '4'.repeat(64) });
    await expect(pool.work.inspect()).rejects.toThrow('anchor or pool is unconfirmed');
    expect(pool.observation).not.toHaveBeenCalled();
  });

  it('keeps helper subcursors in the real original journal and returns isolated snapshots', async () => {
    const f = await fixture();
    const task: DockerContinuationTask = {
      role: 'leaf-helper',
      phase: 'create-issued',
      name: 'reverie-boxed-leaf-synthetic',
      imageId: f.work.row().workerImage.imageId,
      configurationDigest: 'c'.repeat(64),
    };
    expect(f.port.read(f.work.row(), 'leaf-helper')).toBeUndefined();
    const row = f.work.row();
    await f.port.publish(row, undefined, task, () => f.journal.current());
    const created: DockerContinuationTask = { ...task, phase: 'created', containerId: '3'.repeat(64) };
    await f.port.publish(row, task, created, () => f.journal.current());
    const snapshot = f.port.read(row, 'leaf-helper')!;
    snapshot.name = 'reverie-boxed-changed';
    task.name = 'reverie-boxed-also-changed';
    expect(f.port.read(row, 'leaf-helper')).toEqual(created);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement?.work?.tasks).toEqual([created]);
    expect(f.command.create).not.toHaveBeenCalled();
  });

  it('rejects stale helper CAS, skipped helper intent, and changed original work before publication', async () => {
    const f = await fixture();
    const row = f.work.row();
    const task: DockerContinuationTask = {
      role: 'leaf-helper',
      phase: 'create-issued',
      name: 'reverie-boxed-leaf-synthetic',
      imageId: row.workerImage.imageId,
      configurationDigest: 'c'.repeat(64),
    };
    const created: DockerContinuationTask = { ...task, phase: 'created', containerId: '3'.repeat(64) };
    await expect(f.port.publish(row, undefined, created, () => {})).rejects.toThrow('native task changed');
    await f.port.publish(row, undefined, task, () => {});
    const before = f.state;
    await expect(f.port.publish(row, undefined, created, () => {})).rejects.toThrow('native task changed');
    await expect(
      f.port.publish(row, task, { ...created, configurationDigest: 'd'.repeat(64) }, () => {})
    ).rejects.toThrow('native task changed');
    expect(() => f.port.read({ ...row, credentialId: f.state.seed.source.record.credentialId }, 'leaf-helper')).toThrow(
      'target work changed'
    );
    expect(f.state).toEqual(before);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
  });

  it('checks the original grant independently of a supplied helper callback', async () => {
    const f = await fixture();
    const row = f.work.row();
    f.revoke();
    expect(() => f.port.read(row, 'anchor')).toThrow('Request grant revoked');
    await expect(
      f.port.publish(
        row,
        undefined,
        {
          role: 'anchor',
          phase: 'create-issued',
          name: 'reverie-boxed-anchor-synthetic',
          imageId: row.workerImage.imageId,
          configurationDigest: 'c'.repeat(64),
        },
        () => {}
      )
    ).rejects.toThrow('Request grant revoked');
    expect(f.state.work?.tasks).toBeUndefined();
  });

  it('publishes only forward ephemeral cursors for the same work and refuses stale or substituted input', async () => {
    const f = await fixture(),
      row = f.work.row();
    const issued = EphemeralRestoration.parse({
      version: 1,
      purpose: 'reverie-ephemeral-restoration-v1',
      attempts: [
        {
          ordinal: 1,
          name: 'reverie-boxed-ephemeral-' + 'a'.repeat(64),
          imageId: row.workerImage.imageId,
          configurationDigest: 'b'.repeat(64),
          rootSource: '/synthetic-scratch',
          phase: 'create-issued',
          request: {
            version: 1,
            purpose: 'reverie-ephemeral-directory-restore-v1',
            operationId: row.request.operationId,
            employeeId: row.employeeId,
            sessionId: row.original.sessionId,
            sessionGeneration: row.request.sessionGeneration,
            invocation: 1,
            layout: 'employees',
            root: { dev: '1', ino: '2', uid: 1000, gid: 100, mode: 0o700 },
            forbidden: [],
          },
        },
      ],
    });
    expect(f.port.readEphemeral(row)).toBeUndefined();
    await f.port.publishEphemeral(row, undefined, issued, () => {});
    const created = EphemeralRestoration.parse({
      ...issued,
      attempts: [{ ...issued.attempts[0]!, phase: 'created', containerId: '3'.repeat(64) }],
    });
    await f.port.publishEphemeral(row, issued, created, () => {});
    const snapshot = f.port.readEphemeral(row)!;
    snapshot.attempts[0]!.rootSource = '/changed';
    expect(f.port.readEphemeral(row)).toEqual(created);
    const before = f.state;
    await expect(f.port.publishEphemeral(row, issued, created, () => {})).rejects.toThrow('ephemeral task changed');
    await expect(f.port.publishEphemeral(row, created, issued, () => {})).rejects.toThrow('ephemeral task changed');
    await expect(
      f.port.publishEphemeral({ ...row, sourceDigest: '9'.repeat(63) + '8' }, created, created, () => {})
    ).rejects.toThrow('target work changed');
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    expect(f.command.run).not.toHaveBeenCalled();
  });
});
