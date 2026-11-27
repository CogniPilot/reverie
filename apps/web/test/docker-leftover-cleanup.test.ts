/** The owner's cleanup of superseded laptop leftovers: which helpers and images
 * are provably superseded, everything that is kept and why, the digest-bound
 * apply over the real Engine port, and the authenticated owner API. The Engine
 * is a synthetic in-memory one; no Docker command runs. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import { PackagedDockerEngineCommand, dockerSupersededHelperProven } from '../src/docker-engine-command.js';
import {
  DOCKER_LEFTOVER_CONTAINER_BATCH,
  dockerLeftoverKind,
  parseDockerSize,
  type DockerLeftoverRecords,
} from '../src/docker-leftover-cleanup-data.js';
import { DockerLeftoverCleanup, type DockerLeftoverReport } from '../src/docker-leftover-cleanup.js';
import { registerDockerLeftoverCleanupRoutes } from '../src/web/routes/docker-leftover-cleanup-routes.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { ownerFor } from '../src/web/route-helpers.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const hex = (seed: string) => createHash('sha256').update(seed).digest('hex'),
  image = (seed: string) => 'sha256:' + hex('image:' + seed),
  uuid = (seed: string) => {
    const value = hex('uuid:' + seed);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
  };
const box = 'b'.repeat(64),
  otherBox = 'c'.repeat(64),
  deployment = 'synthetic',
  current = image('current'),
  old = image('old'),
  bound = image('bound'),
  next = image('next'),
  mixed = image('mixed'),
  helperImage = image('helper'),
  leafImage = image('leaf-writer'),
  ada = uuid('ada'),
  bev = uuid('bev');

interface Row {
  Id: string;
  Name: string;
  Image: string;
  State: { Status: string; Running: boolean; Paused: boolean; Restarting: boolean; Dead: boolean; Pid: number };
  Config: { Labels: Record<string, string> | null; Cmd: string[] | null };
}
const state = (status: 'exited' | 'running' | 'created'): Row['State'] => ({
  Status: status,
  Running: status === 'running',
  Paused: false,
  Restarting: false,
  Dead: false,
  Pid: status === 'running' ? 4242 : 0,
});
/** The real Engine port over a synthetic Engine: only its `run` is replaced,
 * so every removal goes through the port's own re-reads and refusals. */
class SyntheticEngine extends PackagedDockerEngineCommand {
  readonly containers = new Map<string, Row>();
  readonly images = new Map<string, { tags: string[]; unique: string }>();
  readonly log: string[] = [];
  /** Runs before each command, to change the world mid-operation. */
  before?: (args: readonly string[]) => void;
  noUsage = false;
  add(name: string, imageId: string, status: 'exited' | 'running' | 'created', labels: Record<string, string>) {
    const row: Row = {
      Id: hex('container:' + name),
      Name: '/' + name,
      Image: imageId,
      State: state(status),
      Config: { Labels: labels, Cmd: null },
    };
    this.containers.set(row.Id, row);
    return row;
  }
  get mutations(): string[] {
    return this.log.filter((line) => /^(container|image) rm /.test(line));
  }
  #filtered(args: readonly string[]): Row[] {
    let rows = [...this.containers.values()];
    args.forEach((arg, index) => {
      if (arg !== '--filter') return;
      const [key, value] = args[index + 1]!.split('=');
      rows = rows.filter((row) => (key === 'id' ? row.Id === value : key === 'ancestor' ? row.Image === value : false));
    });
    return rows;
  }
  override async run(args: readonly string[]): Promise<string> {
    this.before?.(args);
    this.log.push(args.filter((arg) => !arg.startsWith('{"Id"')).join(' '));
    const [kind, verb] = args;
    if (kind === 'container' && verb === 'ls')
      return this.#filtered(args)
        .map((row) => row.Id + '\n')
        .join('');
    if (kind === 'container' && verb === 'inspect') {
      const formatted = args[2] === '--format',
        rows = args.slice(formatted ? 4 : 2).map((id) => {
          const row = this.containers.get(id);
          if (!row) throw Error('No such container');
          return row;
        });
      if (!formatted) return JSON.stringify(rows);
      return rows
        .map(
          (row) =>
            JSON.stringify({
              Id: row.Id,
              Name: row.Name,
              Image: row.Image,
              State: row.State,
              Labels: row.Config.Labels,
              Cmd: row.Config.Labels?.['reverie.box.resource.role'] === 'leaf-helper' ? row.Config.Cmd : null,
            }) + '\n'
        )
        .join('');
    }
    if (kind === 'container' && verb === 'rm' && args.length === 3) {
      const row = this.containers.get(args[2]!);
      if (!row || row.State.Running) throw Error('Engine refused the removal');
      this.containers.delete(row.Id);
      return row.Id + '\n';
    }
    if (kind === 'image' && verb === 'ls')
      return [...this.images]
        .flatMap(([id, value]) =>
          args.at(-1) === '{{.ID}}'
            ? [id]
            : (value.tags.length ? value.tags : ['<none>:<none>']).map((tag) => [id, ...tag.split(':')].join('\t'))
        )
        .map((line) => line + '\n')
        .join('');
    if (kind === 'image' && verb === 'inspect') {
      const value = this.images.get(args[2]!);
      if (!value) throw Error('No such image');
      return JSON.stringify([{ Id: args[2], RepoTags: value.tags }]);
    }
    if (kind === 'image' && verb === 'rm' && args[2] === '--no-prune' && args.length === 4) {
      const found = [...this.images].find(([, value]) => value.tags.includes(args[3]!));
      if (!found) throw Error('No such image');
      const [id, value] = found;
      if (value.tags.length === 1 && [...this.containers.values()].some((row) => row.Image === id))
        throw Error('conflict: container is using its referenced image');
      value.tags = value.tags.filter((tag) => tag !== args[3]);
      if (!value.tags.length) this.images.delete(id);
      return '';
    }
    if (kind === 'system' && verb === 'df') {
      if (this.noUsage) throw Error('Engine did not answer');
      if (args.includes('--verbose'))
        return JSON.stringify(
          [...this.images].map(([ID, value]) => ({ ID, UniqueSize: value.unique, Size: '11.5GB' }))
        );
      return (
        JSON.stringify({ Type: 'Images', TotalCount: '7', Active: '3', Size: '174.5GB', Reclaimable: '98.5GB (56%)' }) +
        '\n' +
        JSON.stringify({
          Type: 'Containers',
          TotalCount: '20',
          Active: '4',
          Size: '5.5MB',
          Reclaimable: '3.7MB (67%)',
        }) +
        '\n'
      );
    }
    throw Error('Unexpected Engine command: ' + args.join(' '));
  }
}
interface Generation {
  record: Record<string, unknown>;
  ids: { ephemeral: string; identity: string; leaf: string; storage: string; laptop: string; source: string };
}
/** One laptop generation of one employee: its record and the helpers its set-up left behind. */
function generation(
  engine: SyntheticEngine,
  employeeId: string,
  seed: string,
  imageId: string,
  laptop: 'absent' | 'running' | 'exited' = 'absent'
): Generation {
  const operationId = uuid('operation:' + seed),
    laptopName = 'reverie-boxed-' + dockerContinuationDigest([box, 'destination', operationId]),
    sourceName = 'reverie-boxed-source-' + dockerContinuationDigest([box, 'reprovision-source', operationId]),
    laptopId = hex('container:' + laptopName),
    sourceId = hex('container:' + sourceName);
  if (laptop !== 'absent') {
    engine.add(laptopName, imageId, laptop, {
      'reverie.boxed.box': box,
      'reverie.boxed.instance': deployment,
      'reverie.boxed.employee': employeeId,
      'reverie.boxed.operation': operationId,
    });
    engine.add(sourceName, imageId, 'created', { 'reverie.employee': employeeId, 'reverie.worker': deployment });
  }
  const names = {
    ephemeral: 'reverie-boxed-ephemeral-' + dockerContinuationDigest([box, operationId, 1]),
    identity: 'reverie-boxed-identity-' + dockerContinuationDigest([box, 'identity-helper', operationId]),
    leaf: 'reverie-boxed-leaf-helper-' + dockerContinuationDigest([box, 'leaf-helper', operationId]),
    storage: 'reverie-boxed-storage-' + dockerContinuationDigest([box, 'storage-holder', operationId]),
  };
  const ephemeral = engine.add(names.ephemeral, imageId, 'exited', {
    'org.reverie.worker.uid': '1000',
    'reverie.box.ephemeral.box': box,
    'reverie.box.ephemeral.operation': operationId,
    'reverie.box.ephemeral.ordinal': '1',
  });
  const identity = engine.add(names.identity, imageId, 'exited', {
    'reverie.box.identity.box': box,
    'reverie.box.identity.employee': employeeId,
    'reverie.box.identity.operation': operationId,
  });
  const leaf = engine.add(names.leaf, leafImage, 'exited', {
    'org.reverie.purpose': 'boxed-resource-helper-v1',
    'reverie.box.resource.box': box,
    'reverie.box.resource.name': names.leaf,
    'reverie.box.resource.role': 'leaf-helper',
  });
  leaf.Config.Cmd = [
    'configure-high',
    ...['--box-id', box, '--anchor-id', hex('anchor'), '--anchor-pid', '10', '--anchor-start', '100'],
    ...['--worker-id', laptopId, '--worker-pid', '20', '--worker-start', '200', '--leaf-dev', '1', '--leaf-ino', '2'],
    ...['--memory-max', '1073741824', '--swap-max', '0', '--pids-max', '100', '--memory-high', '536870912'],
    ...['--cpu-weight', '100'],
  ];
  const storage = engine.add(names.storage, helperImage, 'running', {
    'org.reverie.purpose': 'boxed-resource-helper-v1',
    'reverie.box.storage.box': box,
    'reverie.box.storage.employee': employeeId,
    'reverie.box.storage.operation': operationId,
  });
  const task = (role: string, name: string, imageId: string, containerId: string) => ({
    role,
    name,
    imageId,
    configurationDigest: hex('configuration:' + name),
    phase: role === 'storage-holder' ? 'running' : 'completed',
    containerId,
  });
  return {
    ids: {
      ephemeral: ephemeral.Id,
      identity: identity.Id,
      leaf: leaf.Id,
      storage: storage.Id,
      laptop: laptopId,
      source: sourceId,
    },
    record: {
      version: 2,
      employeeId,
      request: { operationId, sessionId: uuid('session:' + employeeId), sessionGeneration: 1, imageId },
      original: { containerId: sourceId, imageId },
      destination: { containerId: laptopId, imageId },
      workerImage: { imageId, sourceImageId: imageId },
      tasks: [
        task('storage-holder', names.storage, helperImage, storage.Id),
        task('anchor', 'reverie-boxed-anchor-' + box.slice(0, 32), helperImage, hex('container:anchor')),
        task('leaf-helper', names.leaf, leafImage, leaf.Id),
        task('identity-helper', names.identity, imageId, identity.Id),
      ],
      ephemeralRestoration: {
        attempts: [{ ordinal: 1, name: names.ephemeral, imageId, containerId: ephemeral.Id, phase: 'completed' }],
      },
    },
  };
}
/** The office retired `record` and made the source the next generation starts from. */
function retirement(employeeId: string, seed: string, record: Generation, nextSource: string, previous?: string) {
  return {
    operationId: uuid('reprovision:' + seed),
    reason: 'recorded-containers-absent',
    employeeId,
    ...(previous ? { previous } : {}),
    record: record.record,
    binding: null,
    absent: { containerIds: [record.ids.laptop, record.ids.source].sort(), planMoveIds: [] },
    session: { phase: 'cleared', containerName: null },
    source: { phase: 'created', name: 'reverie-boxed-source-' + hex(seed), imageId: current, containerId: nextSource },
  };
}
/** Ada works on the current image after two retired generations on an older
 * one. Bev is out of the office and still bound to an image of her own, after
 * one retired generation on it. Around them: storage holders, the shared pool,
 * the office itself, a deployment leftover and another box's helper. */
function office() {
  const engine = new SyntheticEngine();
  const a1 = generation(engine, ada, 'ada-1', old),
    a2 = generation(engine, ada, 'ada-2', old),
    a3 = generation(engine, ada, 'ada-3', current, 'running'),
    b1 = generation(engine, bev, 'bev-1', bound),
    b2 = generation(engine, bev, 'bev-2', bound, 'exited');
  engine.add('reverie-boxed-anchor-' + box.slice(0, 32), helperImage, 'running', {
    'reverie.box.resource.box': box,
    'reverie.box.resource.role': 'anchor',
  });
  engine.add('reverie-boxed-pool-helper-' + hex('pool'), helperImage, 'exited', {
    'reverie.box.resource.box': box,
    'reverie.box.resource.role': 'pool-helper',
  });
  engine.add('reverie', image('office'), 'running', {});
  engine.add('reverie-before-front-0123456789abcdef', image('office-before'), 'exited', {});
  engine.add('reverie-boxed-ephemeral-' + hex('elsewhere'), image('other-box'), 'exited', {
    'reverie.box.ephemeral.box': otherBox,
    'reverie.box.ephemeral.operation': uuid('elsewhere'),
    'reverie.box.ephemeral.ordinal': '1',
  });
  const tag = (id: string, tags: string[], unique: string) => engine.images.set(id, { tags, unique });
  tag(current, ['reverie-boxed-worker:stage-current'], '224.8MB');
  tag(old, ['reverie-boxed-worker:stage-old', 'reverie-boxed-source:0123abcd'], '1.5GB');
  tag(bound, ['reverie-boxed-worker:reprovision'], '7.422GB');
  tag(next, ['reverie-boxed-worker:stage-next'], '300MB');
  tag(mixed, ['reverie-boxed-source:feedbeef', 'reverie-worker:latest'], '67.56kB');
  tag(helperImage, ['reverie-boxed-resource-helper:latest'], '2.0MB');
  tag(leafImage, ['reverie-boxed-leaf-writer-helper:latest'], '1.2kB');
  tag(image('postgres'), ['postgres:16'], '400MB');
  const r1 = retirement(ada, 'ada-r1', a1, a2.ids.source),
    r2 = retirement(ada, 'ada-r2', a2, a3.ids.source, r1.operationId),
    r3 = retirement(bev, 'bev-r1', b1, b2.ids.source);
  const world = {
    records: {
      employees: [
        { id: ada },
        {
          id: bev,
          dockerBinding: { operationId: uuid('operation:bev-2'), containerId: b2.ids.laptop, imageId: bound },
        },
      ],
      dockerEmployeeContinuations: [a3.record, b2.record],
      retiredDockerEmployeeContinuations: [r1, r2, r3],
    } as unknown as DockerLeftoverRecords,
    flights: new Set<string>(),
    moves: new Map<string, { id: string }[]>(),
    journal: true,
    runtime: true,
  };
  const service = new DockerLeftoverCleanup(
    engine,
    {
      boxId: box,
      deployment,
      workerImageId: current,
      sourceImageIds: [old, bound, current, image('gone')],
      helperImageIds: [helperImage, leafImage],
    },
    {
      records: () => world.records,
      inFlight: (employeeId) => world.flights.has(employeeId),
      planMoves: () =>
        world.journal ? { openMoves: async (employeeId: string) => world.moves.get(employeeId) ?? [] } : undefined,
      runtimeCurrent: () => {
        if (!world.runtime) throw Error('Synthetic runtime revoked');
      },
    }
  );
  /** Replaces the records, as the company store does on every write. */
  const rewrite = (change: (records: Record<string, unknown[]>) => void) => {
    const copy = structuredClone(world.records) as unknown as Record<string, unknown[]>;
    change(copy);
    world.records = copy as unknown as DockerLeftoverRecords;
  };
  return { engine, service, world, rewrite, a1, a2, a3, b1, b2, retirements: [r1, r2, r3] };
}
const allowed = () => {};
const reasons = (report: DockerLeftoverReport) =>
  Object.fromEntries(report.containers.keptByReason.map((row) => [row.kind + ':' + row.reason, row.count]));
const keptReason = (report: DockerLeftoverReport, containerId: string) =>
  report.containers.kept.find((entry) => entry.containerId === containerId)?.reason;
const removes = (report: DockerLeftoverReport) => report.containers.remove.map((entry) => entry.containerId).sort();

describe('which leftovers are superseded', () => {
  it('lists the helpers of retired laptop generations and keeps everything else, with the reason', async () => {
    const f = office(),
      report = await f.service.report(allowed);
    expect(removes(report)).toEqual(
      [f.a1, f.a2, f.b1].flatMap((value) => [value.ids.ephemeral, value.ids.identity, value.ids.leaf]).sort()
    );
    expect(report.containers.remove.every((entry) => entry.reason === 'superseded-operation')).toBe(true);
    expect(report.containers.deferred).toBe(0);
    expect(reasons(report)).toEqual({
      // The helpers of the two laptops on record.
      'ephemeral-helper:current-operation': 2,
      'identity-helper:current-operation': 2,
      'leaf-helper:current-operation': 2,
      // Another box's helper, the office and a deployment leftover.
      'ephemeral-helper:foreign': 1,
      'foreign:foreign': 2,
      // Every storage holder, current or not; the pool; laptops and their sources.
      'storage-holder:storage-holder': 5,
      'pool-anchor:shared-pool': 1,
      'pool-helper:shared-pool': 1,
      'laptop:laptop': 2,
      'laptop-source:laptop': 2,
    });
    expect(report.containers.listed).toBe(report.containers.remove.length + report.containers.kept.length);
    expect(report.allowedActions).toEqual(['apply']);
    // Reading removes nothing.
    expect(f.engine.mutations).toEqual([]);
    expect(f.engine.containers.size).toBe(report.containers.listed);
  });
  it('keeps the image an out-of-office employee is bound to, and offers only a retired generation image', async () => {
    const f = office(),
      report = await f.service.report(allowed);
    expect(report.images.remove).toEqual([
      {
        imageId: old,
        tags: ['reverie-boxed-source:0123abcd', 'reverie-boxed-worker:stage-old'],
        uniqueBytes: 1_500_000_000,
        reason: 'superseded-image',
        containers: 0,
        approvedSource: true,
      },
    ]);
    expect(Object.fromEntries(report.images.kept.map((entry) => [entry.imageId, entry.reason]))).toEqual({
      [current]: 'configured-image',
      // Bev's stopped laptop, her record and her binding all name it.
      [bound]: 'recorded',
      // Built, never used by a laptop on record: it may be the next update.
      [next]: 'never-recorded',
      [mixed]: 'foreign-tag',
    });
    // Helper images and images of other software are not this cleanup's subject at all.
    expect([...report.images.remove, ...report.images.kept].map((entry) => entry.imageId)).not.toContain(helperImage);
    expect(report.reclaimableImageBytes).toBe(1_500_000_000);
    expect(report.docker.images).toEqual({
      total: 7,
      active: 3,
      size: '174.5GB',
      sizeBytes: 174_500_000_000,
      reclaimable: '98.5GB (56%)',
      reclaimableBytes: 98_500_000_000,
    });
    expect(report.sourceImageIds).toEqual({
      configured: 4,
      limit: 32,
      unneeded: [old, image('gone')].sort(),
      absent: [image('gone')],
      needed: [
        { imageId: bound, reason: 'recorded' },
        { imageId: current, reason: 'worker-image' },
      ].sort((left, right) => (left.imageId < right.imageId ? -1 : 1)),
    });
  });
  it('keeps an image a remaining container was created from, even an unrecorded one', async () => {
    const f = office();
    // A stray helper of the old image that no record names.
    const stray = f.engine.add('reverie-boxed-ephemeral-' + hex('stray'), old, 'exited', {
      'reverie.box.ephemeral.box': box,
      'reverie.box.ephemeral.operation': uuid('stray'),
      'reverie.box.ephemeral.ordinal': '1',
    });
    const report = await f.service.report(allowed);
    expect(keptReason(report, stray.Id)).toBe('unrecorded');
    expect(report.images.remove).toEqual([]);
    expect(report.images.kept.find((entry) => entry.imageId === old)).toMatchObject({
      reason: 'in-use',
      containers: 1,
    });
    expect(report.sourceImageIds.needed).toContainEqual({ imageId: old, reason: 'in-use' });
  });
  it('keeps every approved source while the configured laptop image is not on the host', async () => {
    const f = office();
    f.engine.images.delete(current);
    const report = await f.service.report(allowed);
    expect(report.images.remove).toEqual([]);
    expect(report.images.kept.find((entry) => entry.imageId === old)?.reason).toBe('worker-image-absent');
  });
  it('still reports and removes the same things when Docker reports no sizes', async () => {
    const f = office();
    f.engine.noUsage = true;
    const report = await f.service.report(allowed);
    expect(report.docker).toEqual({ images: null, containers: null });
    expect(report.reclaimableImageBytes).toBeNull();
    expect(report.images.remove.map((entry) => [entry.imageId, entry.uniqueBytes])).toEqual([[old, null]]);
    expect(report.containers.remove).toHaveLength(9);
  });
});

describe('what is never superseded', () => {
  it('keeps a helper that is not exited, and one whose name, image or labels differ from its record', async () => {
    const f = office();
    f.engine.containers.get(f.a1.ids.ephemeral)!.State = state('created');
    f.engine.containers.get(f.a1.ids.identity)!.State = state('running');
    f.engine.containers.get(f.a2.ids.ephemeral)!.Image = next;
    f.engine.containers.get(f.a2.ids.identity)!.Config.Labels!['reverie.box.identity.employee'] = bev;
    f.engine.containers.get(f.b1.ids.ephemeral)!.Config.Labels!['reverie.box.ephemeral.ordinal'] = '2';
    const report = await f.service.report(allowed);
    expect(keptReason(report, f.a1.ids.ephemeral)).toBe('not-terminal');
    expect(keptReason(report, f.a1.ids.identity)).toBe('not-terminal');
    expect(keptReason(report, f.a2.ids.ephemeral)).toBe('record-mismatch');
    expect(keptReason(report, f.a2.ids.identity)).toBe('record-mismatch');
    expect(keptReason(report, f.b1.ids.ephemeral)).toBe('record-mismatch');
    expect(removes(report)).toEqual([f.a1.ids.leaf, f.a2.ids.leaf, f.b1.ids.identity, f.b1.ids.leaf].sort());
  });
  it('keeps the helpers of an employee whose operation is in flight, however it is in flight', async () => {
    const cases: Array<[string, (f: ReturnType<typeof office>) => void, string]> = [
      ['a laptop operation of this office process', (f) => f.world.flights.add(ada), 'laptop-operation'],
      ['an open plan move', (f) => f.world.moves.set(ada, [{ id: 'move-1' }]), 'plan-move-open'],
      ['an unbound plan journal', (f) => (f.world.journal = false), 'plan-journal-unavailable'],
      [
        'a reprovision whose new source is not created yet',
        (f) =>
          f.rewrite((records) => {
            const head = records.retiredDockerEmployeeContinuations![1] as { source: Record<string, unknown> };
            head.source = { phase: 'issued', name: head.source.name, imageId: current };
          }),
        'reprovision-pending',
      ],
      [
        'a history with two newest entries',
        (f) =>
          f.rewrite((records) => {
            delete (records.retiredDockerEmployeeContinuations![1] as { previous?: string }).previous;
          }),
        'history-inconsistent',
      ],
    ];
    for (const [name, arrange, detail] of cases) {
      const f = office();
      arrange(f);
      const report = await f.service.report(allowed),
        held = report.containers.kept.filter((entry) => entry.reason === 'operation-in-flight');
      expect(new Set(held.map((entry) => entry.detail)), name).toEqual(new Set([detail]));
      expect(
        held
          .filter((entry) => entry.employeeId === ada)
          .map((entry) => entry.containerId)
          .sort(),
        name
      ).toEqual([f.a1, f.a2].flatMap((value) => [value.ids.ephemeral, value.ids.identity, value.ids.leaf]).sort());
      // The old image stays as long as one of those helpers does.
      expect(report.images.remove, name).toEqual([]);
    }
  });
  it('keeps a retired helper that a current record still names', async () => {
    const f = office();
    // A plan replacement keeps reading the laptop it replaced through that laptop's operation.
    f.rewrite((records) => {
      (records.dockerEmployeeContinuations![0] as Record<string, unknown>).planReplacement = {
        source: { binding: { operationId: uuid('operation:ada-2') } },
      };
    });
    const report = await f.service.report(allowed);
    expect(keptReason(report, f.a2.ids.ephemeral)).toBe('current-operation');
    expect(keptReason(report, f.a2.ids.identity)).toBe('current-operation');
    expect(keptReason(report, f.a2.ids.leaf)).toBe('current-operation');
    expect(removes(report)).toEqual(
      [f.a1, f.b1].flatMap((value) => [value.ids.ephemeral, value.ids.identity, value.ids.leaf]).sort()
    );
  });
  it('keeps old installers while the current one is missing, and a leaf writer whose laptop still exists', async () => {
    const f = office();
    f.engine.containers.delete(f.a3.ids.identity);
    // Bev's retired generation wrote to a laptop that is, unusually, still listed.
    f.engine.add('reverie-boxed-' + hex('revenant'), bound, 'exited', { 'reverie.boxed.box': box });
    const revenant = hex('container:reverie-boxed-' + hex('revenant')),
      command = f.engine.containers.get(f.b1.ids.leaf)!.Config.Cmd!;
    command[command.indexOf('--worker-id') + 1] = revenant;
    const report = await f.service.report(allowed);
    expect(keptReason(report, f.a1.ids.identity)).toBe('installer-inventory');
    expect(keptReason(report, f.a2.ids.identity)).toBe('installer-inventory');
    expect(keptReason(report, f.b1.ids.leaf)).toBe('worker-present');
    f.engine.containers.get(f.a1.ids.leaf)!.Config.Cmd = ['configure-high', '--box-id', otherBox];
    expect(keptReason(await f.service.report(allowed), f.a1.ids.leaf)).toBe('unclassified');
  });
  it('names each kind by its fixed name only', () => {
    expect(dockerLeftoverKind('/reverie-boxed-' + 'a'.repeat(64))).toBe('laptop');
    expect(dockerLeftoverKind('/reverie-boxed-source-' + 'a'.repeat(64))).toBe('laptop-source');
    expect(dockerLeftoverKind('/reverie-boxed-nix-prepare-' + 'a'.repeat(32))).toBe('other-boxed');
    expect(dockerLeftoverKind('/reverie-boxed-ephemeral-' + 'a'.repeat(63))).toBe('other-boxed');
    expect(dockerLeftoverKind('/reverie-candidate-0123')).toBe('foreign');
    expect(dockerLeftoverKind('/xreverie-boxed-storage-' + 'a'.repeat(64))).toBe('foreign');
  });
});

describe('apply', () => {
  it('removes exactly the reported helpers, then the image they pinned, and nothing else', async () => {
    const f = office(),
      report = await f.service.report(allowed),
      before = new Set(f.engine.containers.keys());
    const result = await f.service.apply({ expectedDigest: report.digest }, allowed);
    expect(result).toEqual({
      digest: report.digest,
      state: 'complete',
      removed: { containers: removes(report), images: [old] },
      deferred: { containers: 0, images: 0 },
    });
    expect([...before].filter((id) => !f.engine.containers.has(id)).sort()).toEqual(removes(report));
    expect(f.engine.images.has(old)).toBe(false);
    for (const kept of [current, bound, next, mixed, helperImage]) expect(f.engine.images.has(kept)).toBe(true);
    // Reads, plus exactly two removal forms: no force, no volumes, no stop, no prune of anything else.
    const permitted =
      /^(?:container (?:ls|inspect) |container rm [a-f0-9]{64}$|image (?:ls|inspect) |image rm --no-prune reverie-boxed-(?:worker|source):[a-z0-9-]+$|system df )/;
    expect(f.engine.log.filter((line) => !permitted.test(line))).toEqual([]);
    expect(f.engine.mutations).toHaveLength(11);
    // Nothing is left to do, and an empty report cannot be applied.
    const after = await f.service.report(allowed);
    expect(after.allowedActions).toEqual([]);
    await expect(f.service.apply({ expectedDigest: after.digest }, allowed)).rejects.toThrow(
      'DOCKER_LEFTOVER_NOTHING_TO_REMOVE'
    );
  });
  it('refuses a digest from another world and removes nothing', async () => {
    const f = office(),
      report = await f.service.report(allowed);
    // Between the report and the confirmation one helper's employee starts a laptop operation.
    f.world.flights.add(bev);
    await expect(f.service.apply({ expectedDigest: report.digest }, allowed)).rejects.toThrow(
      'DOCKER_LEFTOVER_SCOPE_CHANGED'
    );
    f.world.flights.clear();
    // Or a further superseded helper appears.
    f.engine.containers.get(f.b1.ids.ephemeral)!.State = state('running');
    await expect(f.service.apply({ expectedDigest: report.digest }, allowed)).rejects.toThrow(
      'DOCKER_LEFTOVER_SCOPE_CHANGED'
    );
    await expect(f.service.apply({ expectedDigest: '0'.repeat(64) }, allowed)).rejects.toThrow(
      'DOCKER_LEFTOVER_SCOPE_CHANGED'
    );
    expect(f.engine.mutations).toEqual([]);
  });
  it('stops at a helper that started again and reports how far it got', async () => {
    const f = office(),
      report = await f.service.report(allowed),
      [first, second] = removes(report);
    // The second helper is started by something else right after the first removal.
    f.engine.before = (args) => {
      if (args[0] === 'container' && args[1] === 'rm' && args[2] === first)
        f.engine.containers.get(second!)!.State = state('running');
    };
    const result = await f.service.apply({ expectedDigest: report.digest }, allowed);
    expect(result).toMatchObject({
      state: 'incomplete',
      code: 'DOCKER_LEFTOVER_HELPER_NOT_REMOVABLE',
      removed: { containers: [first], images: [] },
    });
    expect(f.engine.containers.has(second!)).toBe(true);
    expect(f.engine.images.has(old)).toBe(true);
    expect(f.engine.mutations).toEqual(['container rm ' + first]);
  });
  it('stops when the records change or the employee starts an operation during the removals', async () => {
    for (const [code, disturb] of [
      [
        'DOCKER_LEFTOVER_SCOPE_CHANGED',
        (f: ReturnType<typeof office>) =>
          f.rewrite((records) => {
            (records.dockerEmployeeContinuations![0] as { phase?: string }).phase = 'ready';
          }),
      ],
      ['DOCKER_LEFTOVER_OPERATION_IN_FLIGHT', (f: ReturnType<typeof office>) => f.world.flights.add(ada).add(bev)],
    ] as const) {
      const f = office(),
        report = await f.service.report(allowed),
        first = removes(report)[0]!;
      f.engine.before = (args) => {
        if (args[0] === 'container' && args[1] === 'rm' && args[2] === first) disturb(f);
      };
      const result = await f.service.apply({ expectedDigest: report.digest }, allowed);
      expect(result).toMatchObject({ state: 'incomplete', code, removed: { containers: [first], images: [] } });
      expect(f.engine.mutations).toEqual(['container rm ' + first]);
    }
  });
  it('stops with the authority error once the owner or the runtime is no longer current', async () => {
    const f = office(),
      report = await f.service.report(allowed);
    let removals = 0;
    f.engine.before = (args) => {
      if (args[0] === 'container' && args[1] === 'rm' && ++removals === 2) f.world.runtime = false;
    };
    await expect(f.service.apply({ expectedDigest: report.digest }, allowed)).rejects.toThrow(
      'Synthetic runtime revoked'
    );
    expect(f.engine.mutations).toHaveLength(2);
    const g = office();
    await expect(
      g.service.report(() => {
        throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
    expect(g.engine.log).toEqual([]);
  });
  it('leaves an image whose tags changed, or that a container now uses, to the Engine port to refuse', async () => {
    const f = office(),
      report = await f.service.report(allowed);
    f.engine.before = (args) => {
      if (args[0] === 'image' && args[1] === 'inspect')
        f.engine.images.get(old)!.tags.push('reverie-boxed-worker:again');
    };
    const result = await f.service.apply({ expectedDigest: report.digest }, allowed);
    expect(result).toMatchObject({ state: 'incomplete', code: 'DOCKER_LEFTOVER_IMAGE_NOT_REMOVABLE' });
    expect(result.removed.containers).toHaveLength(9);
    expect(f.engine.images.get(old)!.tags).toHaveLength(3);
    const g = office(),
      second = await g.service.report(allowed);
    g.engine.before = (args) => {
      if (args[0] === 'image' && args[1] === 'inspect')
        g.engine.add('reverie-boxed-' + hex('late'), old, 'created', {});
    };
    expect(await g.service.apply({ expectedDigest: second.digest }, allowed)).toMatchObject({
      state: 'incomplete',
      code: 'DOCKER_LEFTOVER_IMAGE_NOT_REMOVABLE',
    });
    expect(g.engine.images.has(old)).toBe(true);
  });
  it('removes a bounded batch and offers the rest, and the images they pin, in a later report', async () => {
    const f = office(),
      entries = [...f.retirements];
    let previous = f.retirements[2]!.operationId;
    for (let index = 0; index < 20; index++) {
      const extra = generation(f.engine, bev, 'bev-extra-' + index, old),
        entry = retirement(bev, 'bev-extra-r' + index, extra, hex('source:' + index), previous);
      entries.push(entry);
      previous = entry.operationId;
    }
    // Bev's own retired generation now precedes the twenty added ones in her history.
    f.world.records = { ...f.world.records, retiredDockerEmployeeContinuations: entries } as never;
    const report = await f.service.report(allowed);
    expect(report.containers.remove).toHaveLength(DOCKER_LEFTOVER_CONTAINER_BATCH);
    expect(report.containers.deferred).toBe(69 - DOCKER_LEFTOVER_CONTAINER_BATCH);
    // Helpers of the old image remain after this batch, so the image waits.
    expect(report.images.remove).toEqual([]);
    const first = await f.service.apply({ expectedDigest: report.digest }, allowed);
    expect(first.removed.containers).toHaveLength(DOCKER_LEFTOVER_CONTAINER_BATCH);
    expect(first.deferred.containers).toBe(21);
    const rest = await f.service.report(allowed);
    expect(rest.containers.remove).toHaveLength(21);
    expect(rest.images.remove.map((entry) => entry.imageId)).toEqual([old]);
    expect(await f.service.apply({ expectedDigest: rest.digest }, allowed)).toMatchObject({ state: 'complete' });
    expect((await f.service.report(allowed)).allowedActions).toEqual([]);
  });
  it('runs one report or apply at a time and refuses an inventory that moved while it was read', async () => {
    const f = office(),
      both = await Promise.allSettled([f.service.report(allowed), f.service.report(allowed)]);
    expect(both.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((both.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)).toContain(
      'DOCKER_LEFTOVER_BUSY'
    );
    let listings = 0;
    f.engine.before = (args) => {
      if (args[0] === 'container' && args[1] === 'ls' && ++listings === 2)
        f.engine.add('late-arrival', next, 'running', {});
    };
    await expect(f.service.report(allowed)).rejects.toThrow('DOCKER_LEFTOVER_INVENTORY_CHANGED');
    f.engine.before = (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') f.engine.containers.delete(f.a1.ids.leaf);
    };
    await expect(f.service.report(allowed)).rejects.toThrow('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED');
    expect(f.engine.mutations).toEqual([]);
  });
});

describe('the Engine port proof and Docker sizes', () => {
  const proof = {
    name: '/reverie-boxed-ephemeral-' + 'a'.repeat(64),
    imageId: old,
    labels: { 'reverie.box.ephemeral.box': box, 'reverie.box.ephemeral.operation': uuid('x') },
  };
  const row = () => ({
    Id: 'd'.repeat(64),
    Name: proof.name,
    Image: old,
    State: { ...state('exited') },
    Config: { Labels: { ...proof.labels, other: 'label' } },
  });
  it('accepts only the exact exited helper', () => {
    expect(dockerSupersededHelperProven(row(), 'd'.repeat(64), proof)).toBe(true);
    const changes: Array<(value: ReturnType<typeof row>) => void> = [
      (value) => (value.Id = 'e'.repeat(64)),
      (value) => (value.Name = '/reverie-boxed-identity-' + 'a'.repeat(64)),
      (value) => (value.Image = current),
      (value) => (value.State = state('running')),
      (value) => (value.State = state('created')),
      (value) => (value.State.Dead = true),
      (value) => (value.State.Paused = true),
      (value) => (value.State.Restarting = true),
      (value) => (value.State.Pid = 7),
      (value) => (value.Config.Labels['reverie.box.ephemeral.box'] = otherBox),
      (value) => delete (value.Config.Labels as Record<string, string>)['reverie.box.ephemeral.operation'],
    ];
    for (const [index, change] of changes.entries()) {
      const value = row();
      change(value);
      expect(dockerSupersededHelperProven(value, 'd'.repeat(64), proof), String(index)).toBe(false);
    }
    expect(dockerSupersededHelperProven(null, 'd'.repeat(64), proof)).toBe(false);
    // A storage holder, a laptop or an unlabelled container can never be proven.
    for (const name of ['/reverie-boxed-storage-' + 'a'.repeat(64), '/reverie-boxed-' + 'a'.repeat(64), '/reverie'])
      expect(dockerSupersededHelperProven({ ...row(), Name: name }, 'd'.repeat(64), { ...proof, name })).toBe(false);
    expect(dockerSupersededHelperProven(row(), 'd'.repeat(64), { ...proof, labels: {} })).toBe(false);
    expect(
      dockerSupersededHelperProven(row(), 'd'.repeat(64), { ...proof, labels: { other: 'label', another: 'label' } })
    ).toBe(false);
  });
  it('refuses to remove anything but a listed laptop image tag', async () => {
    const engine = new SyntheticEngine();
    engine.images.set(old, { tags: ['reverie-boxed-worker:stage-old'], unique: '1GB' });
    for (const tags of [
      [],
      ['postgres:16'],
      ['reverie-boxed:latest'],
      ['reverie-boxed-worker:a', 'reverie-boxed-worker:a'],
    ])
      await expect(engine.removeUnusedLaptopImage(old, tags, allowed)).rejects.toThrow('Fixed laptop image required');
    await expect(engine.removeUnusedLaptopImage('latest', ['reverie-boxed-worker:a'], allowed)).rejects.toThrow(
      'Fixed laptop image required'
    );
    await expect(
      engine.removeSupersededHelper('d'.repeat(64), { ...proof, name: '/reverie' }, allowed)
    ).rejects.toThrow('Fixed superseded helper required');
    expect(engine.log).toEqual([]);
  });
  it('reads the sizes Docker prints', () => {
    expect(parseDockerSize('98.5GB (56%)')).toBe(98_500_000_000);
    expect(parseDockerSize('67.56kB')).toBe(67_560);
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('1.108MB (100%)')).toBe(1_108_000);
    for (const bad of ['', 'GB', '-1GB', '1.5 parsecs', 12, null]) expect(parseDockerSize(bad)).toBeNull();
  });
});

describe('owner API for the leftover cleanup', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });
  async function apiFixture() {
    const f = office(),
      root = await fs.mkdtemp(join(tmpdir(), 'leftover-cleanup-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const ownerAuth = new OwnerAuthService({
      store: new OwnerAuthStore(join(root, 'owner.json')),
      auditFile: join(root, 'audit.jsonl'),
      setupEnabled: true,
    });
    const ownerToken = await ownerAuth.setup(
      'synthetic-owner',
      'Synthetic-only-Ocean42!',
      'Synthetic-only-Ocean42!',
      '127.0.0.1'
    );
    const app = Fastify();
    await app.register(cookie);
    const authState = registerAuthMiddleware(app, false, '', ownerAuth),
      sessions = new Map<string, unknown>(),
      ctx = { sessions } as unknown as SessionPort;
    registerOwnerPolicy(app, {
      service: ownerAuth,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: (id) => sessions.has(id),
        related: (a, b) => a === b,
        coordinated: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerDockerLeftoverCleanupRoutes(app, f.service, {
      verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
      owner: ownerFor,
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      for (const timer of Object.values(authState)) timer?.dispose();
    });
    const url = '/api/company/docker-resources/leftovers',
      ownerHeaders = { cookie: 'reverie_owner=' + ownerToken, origin: 'http://localhost', host: 'localhost' };
    return {
      ...f,
      ownerHeaders,
      get: (headers: Record<string, string> = ownerHeaders) => app.inject({ method: 'GET', url, headers }),
      post: (payload: unknown, headers: Record<string, string> = ownerHeaders) =>
        app.inject({ method: 'POST', url: url + '/apply', headers, payload: payload as object }),
    };
  }
  it('reports to the owner and removes only on the echoed digest', async () => {
    const f = await apiFixture(),
      report = (await f.get()).json();
    expect(report.success).toBe(true);
    expect(report.data.containers.remove).toHaveLength(9);
    expect(JSON.stringify(report.data)).not.toContain('"proof"');
    expect(f.engine.mutations).toEqual([]);
    const stale = await f.post({ expectedDigest: 'f'.repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('DOCKER_LEFTOVER_SCOPE_CHANGED');
    expect(f.engine.mutations).toEqual([]);
    const applied = await f.post({ expectedDigest: report.data.digest });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ state: 'complete', removed: { images: [old] } });
    expect(f.engine.mutations).toHaveLength(11);
  });
  it('accepts only a signed-in same-origin human owner and well-formed input', async () => {
    const f = await apiFixture(),
      digest = (await f.get()).json().data.digest,
      { cookie: ownerCookie, ...anonymous } = f.ownerHeaders;
    expect((await f.get(anonymous)).statusCode).toBeOneOf([401, 403]);
    expect((await f.post({ expectedDigest: digest }, anonymous)).statusCode).toBeOneOf([401, 403]);
    for (const header of ['x-reverie-parent-session', 'x-reverie-worker-identity', 'x-reverie-service-token']) {
      const headers = { ...f.ownerHeaders, [header]: uuid('agent') };
      expect((await f.get(headers)).statusCode, header).toBeOneOf([401, 403]);
      expect((await f.post({ expectedDigest: digest }, headers)).statusCode, header).toBeOneOf([401, 403]);
    }
    const foreign = await f.post(
      { expectedDigest: digest },
      { cookie: ownerCookie, origin: 'http://elsewhere.example', host: 'localhost' }
    );
    expect(foreign.statusCode).toBe(403);
    for (const body of [{}, { expectedDigest: 'latest' }, { expectedDigest: digest, force: true }]) {
      const response = await f.post(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json().error.code).toBe('DOCKER_LEFTOVER_INVALID_INPUT');
    }
    f.world.runtime = false;
    expect((await f.post({ expectedDigest: digest })).statusCode).toBe(409);
    expect(f.engine.mutations).toEqual([]);
  });
});
