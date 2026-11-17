/** Injected physical Engine port; actual SourceReader earns every private source
 * proof. This suite exercises application effect ordering, not Docker itself. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DockerPlanAccountSnapshot } from '../src/docker-plan-account.js';
import { boxedOriginal } from '../src/docker-employee-engine-data.js';
import type { PlanAccount } from '../src/plan-accounts.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
import { DockerPlanSourceHolder } from '../src/docker-plan-source-holder.js';
import { dockerPlanSourceFixture } from './helpers/docker-plan-source-fixture.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { DockerPlanSourceReader, DOCKER_PLAN_INIT_PROGRAM } from '../src/docker-plan-source.js';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { DockerPlanMoveJournalState, assertDockerPlanMoveTransition } from '../src/docker-plan-move-data.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
import { DOCKER_PLAN_SOURCE_READ_PROGRAM } from '../src/docker-plan-source-native.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import type { PlanMoveDockerJournal } from '../src/plan-move-docker.js';
const cid = '9'.repeat(64);
function fixture(imageEnvironment?: readonly string[]) {
  const src = dockerPlanSourceFixture(false),
    f = dockerPlanJournalFixture(),
    seed = structuredClone(f.state.seed);
  seed.forceBusy = true;
  seed.source.record = src.row;
  seed.source.binding = src.binding;
  seed.source.providerSourceDigest = src.row.version === 1 ? src.row.sourceDigest : src.row.providerSourceDigest;
  seed.source.observation = { kind: 'stopped', terminalStateDigest: digest(src.raw.State) };
  seed.target.workerImage = {
    ...seed.target.workerImage,
    imageId: src.row.workerImage.imageId,
    sourceImageId: src.binding.imageId,
    clientManifestDigest: src.row.workerImage.clientManifestDigest,
  };
  let state = DockerPlanMoveJournalState.parse({
    ...f.state,
    seed,
    sourceStop: {
      phase: 'closed',
      epoch: f.epoch,
      sourceContainerId: src.binding.containerId,
      sourceConfigurationDigest: src.row.destination!.configurationDigest,
      sourceInit: null,
      terminalStateDigest: digest(src.raw.State),
    },
  });
  const record = {
    ...f.record,
    employeeId: src.row.employeeId,
    owner: src.row.owner,
    oldSession: src.binding.sessionId,
    dockerReplacement: state,
  };
  const home = { source: src.row.destination!.home.source, user: '1000:100', dev: '11', ino: '12' };
  let privateReply: undefined | string;
  let active = true,
    ticks = '5000',
    helper: Record<string, unknown> | undefined,
    config: Record<string, unknown> | undefined;
  let createLoss: 'none' | 'before' | 'after' = 'none',
    startLoss: 'none' | 'before' | 'after' = 'none',
    stopLoss = false;
  let afterPublish: undefined | ((next: DockerPlanMoveJournalState) => void);
  const effects: Array<{ kind: string; phase: string | undefined }> = [],
    reads: string[] = [];
  const current = () => {
    if (!active) throw Error('Actual requester revoked');
  };
  const journal: PlanMoveDockerJournal = {
    moveId: record.id,
    epoch: f.epoch,
    publication: 'admitting',
    current,
    read: () => structuredClone(state),
    publish: async (before, next) => {
      current();
      expect(digest(before)).toBe(digest(state));
      assertDockerPlanMoveTransition(before, next);
      state = DockerPlanMoveJournalState.parse(next);
      afterPublish?.(state);
      current();
    },
  };
  const command: DockerEngineCommand = {
    create: vi.fn(async (_name, body, requireCurrent) => {
      requireCurrent();
      effects.push({ kind: 'create', phase: state.sourceReader?.phase });
      if (createLoss === 'before') throw Error('Unknown CREATE before response');
      config = structuredClone(body);
      const host = structuredClone(body.HostConfig) as Record<string, unknown>;
      host.RestartPolicy = { Name: 'no', MaximumRetryCount: 0 };
      const { HostConfig: _host, Image: _image, ...rest } = structuredClone(body);
      helper = {
        Id: cid,
        Image: body.Image,
        Config: { ...rest, Volumes: null },
        HostConfig: host,
        Mounts: (host.Mounts as Array<Record<string, unknown>>).map((m) => ({
          Type: m.Type,
          Source: m.Source,
          Destination: m.Target,
          RW: !m.ReadOnly,
        })),
        State: {
          Running: false,
          Status: 'created',
          Pid: 0,
          Paused: false,
          Restarting: false,
          Dead: false,
          ExitCode: 0,
        },
      };
      if (createLoss === 'after') throw Error('Unknown CREATE after effect');
      return cid;
    }),
    run: vi.fn(async (args) => {
      if (args[0] === 'image')
        return JSON.stringify([
          {
            Id: seed.target.workerImage.imageId,
            Config: {
              Env: imageEnvironment ?? [
                'PATH=/bin',
                'NODE_OPTIONS=DO_NOT_LOAD',
                'ANTHROPIC_API_KEY=DO_NOT_PROPAGATE',
                'LD_SHOW_AUXV=DO_NOT_PROPAGATE',
                'UNRELATED_IMAGE_FEATURE=DO_NOT_PROPAGATE',
                'ALREADY_UNSET',
              ],
              Volumes: null,
              Labels: {
                'org.reverie.worker-client.manifest': seed.target.workerImage.clientManifestDigest,
                'synthetic.inherited': 'kept',
              },
            },
          },
        ]);
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (args[2] === src.raw.Id) return JSON.stringify([src.raw]);
        if (args[2] === cid && helper) return JSON.stringify([helper]);
        throw Error('No actual container');
      }
      if (args[0] === 'container' && args[1] === 'ls') return helper ? cid + '\n' : '';
      if (args[0] === 'container' && args[1] === 'start') {
        effects.push({ kind: 'start', phase: state.sourceReader?.phase });
        if (startLoss === 'before') throw Error('Lost start before dispatch');
        if (!helper) throw Error('missing helper');
        helper.State = {
          Running: true,
          Status: 'running',
          Pid: 500,
          Paused: false,
          Restarting: false,
          Dead: false,
          ExitCode: 0,
        };
        if (startLoss === 'after') throw Error('Lost start after dispatch');
        return cid + '\n';
      }
      if (args[0] === 'container' && args[1] === 'stop') {
        effects.push({ kind: 'stop', phase: state.sourceReader?.phase });
        if (!helper) throw Error('missing helper');
        helper.State = {
          Running: false,
          Status: 'exited',
          Pid: 0,
          Paused: false,
          Restarting: false,
          Dead: false,
          ExitCode: 143,
        };
        if (stopLoss) throw Error('Lost stop response');
        return cid + '\n';
      }
      if (args.includes(DOCKER_PLAN_INIT_PROGRAM)) return JSON.stringify({ startTicks: ticks });
      if (args.includes(DOCKER_PLAN_SOURCE_READ_PROGRAM)) {
        const values = args.slice(args.lastIndexOf('--') + 1),
          mode = values[0]!;
        reads.push(mode);
        if (privateReply !== undefined) return privateReply;
        if (mode === 'home')
          return JSON.stringify({
            version: 1,
            purpose: 'reverie-plan-source-home-v1',
            homeDev: home.dev,
            homeIno: home.ino,
            uid: Number(home.user.split(':')[0]),
            gid: Number(home.user.split(':')[1]),
          });
        if (mode === 'context')
          return JSON.stringify({
            version: 1,
            purpose: 'reverie-plan-source-context-v1',
            provider: 'anthropic',
            context: {
              source:
                values[4] === 'account'
                  ? { kind: 'intake', dev: values[9], ino: values[10] }
                  : { kind: 'home', relative: ['.claude'], dev: '11', ino: '13' },
              roles: ['claude-projects'],
              conversation: {
                nativeId: values[8],
                relative: ['projects', 'synthetic', values[8] + '.jsonl'],
                sha256: 'b'.repeat(64),
              },
            },
          });
        if (mode === 'auth')
          return JSON.stringify({
            version: 1,
            purpose: 'reverie-plan-source-auth-v1',
            operationId: values[5],
            projectionDigest: values[6],
            accountId: values[7],
            provider: values[3],
            installedAuthDigest: sha('{"SDK":"installed"}'),
            observedAuthDigest: sha('{"SDK":"rotated"}'),
            auth: '{"SDK":"rotated"}',
          });
      }
      throw Error('Unexpected physical operation');
    }),
  };
  const reader = new DockerPlanSourceReader(
    command,
    'synthetic',
    '7'.repeat(64),
    'http://reverie:3000',
    src.view,
    src.qualifyImage
  );
  const holder = new DockerPlanSourceHolder(command, '7'.repeat(64), reader, async () => ({ ...home }));
  function retained() {
    const previous = structuredClone(f.work);
    previous.employeeId = record.employeeId;
    delete previous.owner;
    previous.original = {
      ...previous.original,
      employeeId: record.employeeId,
      home: { ...previous.original.home, source: home.source },
    };
    previous.destination = {
      ...previous.original,
      containerId: '8'.repeat(64),
      sessionId: previous.request.sessionId,
      imageId: previous.workerImage.imageId,
    };
    previous.phase = 'provider-issued';
    previous.pool = {
      containerId: '6'.repeat(64),
      cgroupParent: '/synthetic',
      policyDigest: 'a'.repeat(64),
      physicalDigest: 'b'.repeat(64),
    };
    const initial = {
      version: 1 as const,
      purpose: 'reverie-plan-installed-v1' as const,
      readMode: 'initial' as const,
      operationId: previous.request.operationId,
      sessionId: previous.request.sessionId,
      containerId: previous.destination.containerId,
      projectionDigest: previous.planReplacement.account.projectionDigest,
      accountId: previous.planReplacement.account.id,
      provider: 'anthropic' as const,
      contextInputDigest: previous.planReplacement.account.contextDigest,
      installedAuthDigest: sha('{"SDK":"installed"}'),
      observedAuthDigest: sha('{"SDK":"installed"}'),
      tokenDigest: '2'.repeat(64),
      contextDigest: '3'.repeat(64),
      observedContextDigest: '3'.repeat(64),
      homeDev: home.dev,
      homeIno: home.ino,
      configDev: home.dev,
      configIno: '13',
    };
    previous.tasks = [
      {
        role: 'storage-holder',
        name: 'reverie-boxed-storage-test',
        imageId: previous.workerImage.imageId,
        configurationDigest: '4'.repeat(64),
        phase: 'running',
        containerId: '5'.repeat(64),
        initPid: 50,
        initStartTicks: '100',
      },
      {
        role: 'leaf-helper',
        name: 'reverie-boxed-leaf-test',
        imageId: previous.workerImage.imageId,
        configurationDigest: '4'.repeat(64),
        phase: 'completed',
        containerId: '6'.repeat(64),
        resultDigest: '7'.repeat(64),
      },
      {
        role: 'identity-helper',
        name: 'reverie-boxed-identity-test',
        imageId: previous.workerImage.imageId,
        configurationDigest: '4'.repeat(64),
        phase: 'completed',
        containerId: '7'.repeat(64),
        resultDigest: digest(initial),
      },
    ];
    const row = DockerEmployeeContinuationRecord.parse(previous);
    if (row.version !== 3) throw Error('Fixture v3 required');
    state = DockerPlanMoveJournalState.parse({
      ...state,
      seed: {
        ...state.seed,
        target: {
          ...state.seed.target,
          accountSource: {
            kind: 'retained-generation',
            moveId: row.planReplacement.moveId,
            operationId: row.request.operationId,
            containerId: row.destination!.containerId,
            projectionDigest: row.planReplacement.account.projectionDigest,
            originalCanonicalSnapshotDigest: state.seed.target.accountSnapshotDigest,
          },
        },
      },
    });
    return { row, initial };
  }
  function projectAccount(account: PlanAccount) {
    home.user = process.getuid!() + ':' + process.getgid!();
    src.raw.Config.User = home.user;
    src.raw.Config.Env = [...src.raw.Config.Env!, 'CLAUDE_CONFIG_DIR=/provider-source'];
    src.raw.Mounts.push({
      Type: 'bind',
      Source: '/daemon-private/account-a',
      Destination: '/provider-source',
      RW: true,
      Propagation: 'rprivate',
    });
    const prior = state.seed.source.record,
      subject = {
        employeeId: prior.employeeId,
        sessionId: prior.request.sessionId,
        sessionGeneration: prior.request.sessionGeneration,
        owner: prior.owner,
        sourceDigest: prior.sourceDigest,
        providerSourceDigest: prior.version === 1 ? prior.sourceDigest : prior.providerSourceDigest,
        onVacation: false,
        desiredRunning: true,
      };
    const destination = boxedOriginal(src.raw, subject, 'synthetic', true);
    state = DockerPlanMoveJournalState.parse({
      ...state,
      seed: {
        ...state.seed,
        source: {
          ...state.seed.source,
          record: { ...prior, original: { ...prior.original, storageDigest: destination.storageDigest }, destination },
          binding: { ...state.seed.source.binding, originalDigest: digest(destination) },
        },
      },
      sourceStop: { ...state.sourceStop, sourceConfigurationDigest: destination.configurationDigest },
    });
    expect(account.id).toBe('account-a');
  }
  return {
    holder,
    reader,
    command,
    journal,
    record,
    src,
    home,
    effects,
    reads,
    retained,
    projectAccount,
    privateReply: (text: string) => {
      privateReply = text;
    },
    state: () => structuredClone(state),
    helper: () => helper!,
    config: () => config!,
    revoke: () => {
      active = false;
    },
    ticks: (v: string) => {
      ticks = v;
    },
    loseCreate: (v: typeof createLoss) => {
      createLoss = v;
    },
    loseStart: (v: typeof startLoss) => {
      startLoss = v;
    },
    loseStop: () => {
      stopLoss = true;
    },
    publishHook: (f: typeof afterPublish) => {
      afterPublish = f;
    },
    freshHolder: () => new DockerPlanSourceHolder(command, '7'.repeat(64), reader, async () => ({ ...home })),
  };
}
const selected = {
  kind: 'legacy' as const,
  provider: 'anthropic' as const,
  nativeId: '12345678-1234-4234-8234-123456789abc',
};
describe('same-journal readonly source holder', () => {
  it('reserves every effect before dispatch and closes only its own immutable helper', async () => {
    const f = fixture();
    await f.holder.open(f.record, f.journal);
    expect(f.effects).toEqual([
      { kind: 'create', phase: 'create-issued' },
      { kind: 'start', phase: 'start-issued' },
    ]);
    expect(f.state().sourceReader?.phase).toBe('running');
    const body = f.config(),
      host = body.HostConfig as Record<string, unknown>;
    expect(host).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      LogConfig: { Type: 'none', Config: {} },
      AutoRemove: false,
    });
    expect(host.Mounts).toEqual([
      {
        Type: 'bind',
        Source: f.home.source,
        Target: '/home/agent',
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true },
      },
    ]);
    expect(body.Env).toContain('NODE_OPTIONS');
    expect(JSON.stringify(body)).not.toContain('DO_NOT_PROPAGATE');
    expect(body.Labels).toMatchObject({ 'synthetic.inherited': 'kept' });
    const result = await f.holder.context(f.record, f.journal, selected);
    expect(result.context.conversation?.nativeId).toBe(selected.nativeId);
    expect(result).not.toHaveProperty('contextSource');
    await f.holder.close(f.record, f.journal);
    expect(f.effects.at(-1)).toEqual({ kind: 'stop', phase: 'close-issued' });
    expect(f.state().sourceReader?.phase).toBe('closed');
    expect(f.src.raw.State.Running).toBe(false);
    await expect(f.holder.context(f.record, f.journal, selected)).rejects.toThrow();
  });
  it('unsets image and loader keys while retaining fixed HOME/PATH for an actual JSON-only Node process', async () => {
    const f = fixture();
    await f.holder.open(f.record, f.journal);
    const entries = f.config().Env as string[];
    // Node's subprocess env omits undefined values, modeling Docker's independently
    // qualified bare-key unset encoding. This executes the actual test Node ELF;
    // it does not claim Docker/container or paid-provider qualification.
    const env = Object.fromEntries(
      entries.map((entry) => {
        const equals = entry.indexOf('=');
        return equals === -1 ? [entry, undefined] : [entry.slice(0, equals), entry.slice(equals + 1)];
      })
    );
    const result = spawnSync(
      process.execPath,
      [
        '--no-global-search-paths',
        '--no-addons',
        '--input-type=commonjs',
        '-e',
        'process.stdout.write(JSON.stringify({ok:true}));',
      ],
      {
        env,
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 65536,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout === '{"ok":true}', 'fixed helper must execute Node rather than loader diagnostics').toBe(true);
    expect(result.stderr).toBe('');
    for (const key of [
      'NODE_OPTIONS',
      'ANTHROPIC_API_KEY',
      'LD_SHOW_AUXV',
      'LD_TRACE_LOADED_OBJECTS',
      'LD_DEBUG',
      'LD_PROFILE',
      'UNRELATED_IMAGE_FEATURE',
      'ALREADY_UNSET',
    ]) {
      expect(entries).toContain(key);
      expect(entries.some((entry) => entry.startsWith(key + '='))).toBe(false);
    }
    expect(entries).toContain('HOME=/home/agent');
    expect(entries).toContain('PATH=/bin');
    expect(entries).toContain('TMUX_TMPDIR=/tmp');
    await f.holder.close(f.record, f.journal);
  });
  it.each([
    ['DUPLICATE', 'DUPLICATE=value'],
    ['DUPLICATE=one', 'DUPLICATE=two'],
    ['INVALID-KEY=value'],
    ['=missing-key'],
    [''],
  ])('refuses malformed or duplicate selected image Env before any helper effect: %j', async (...entries) => {
    const f = fixture(entries);
    await expect(f.holder.open(f.record, f.journal)).rejects.toThrow('HOLDER_UNCONFIRMED');
    expect(f.effects).toEqual([]);
    expect(f.state().sourceReader).toBeUndefined();
  });
  it.each(['before', 'after'] as const)('never replays CREATE after an unknown %s reply', async (loss) => {
    const f = fixture();
    f.loseCreate(loss);
    await expect(f.holder.open(f.record, f.journal)).rejects.toThrow();
    expect(f.state().sourceReader?.phase).toBe('create-issued');
    f.loseCreate('none');
    const next = f.freshHolder();
    if (loss === 'after') {
      await next.open(f.record, f.journal);
      expect(f.state().sourceReader?.phase).toBe('running');
    } else await expect(next.open(f.record, f.journal)).rejects.toThrow();
    expect(f.effects.filter((e) => e.kind === 'create')).toHaveLength(1);
  });
  it.each(['before', 'after'] as const)('never replays START after an unknown %s reply', async (loss) => {
    const f = fixture();
    f.loseStart(loss);
    await expect(f.holder.open(f.record, f.journal)).rejects.toThrow();
    expect(f.state().sourceReader?.phase).toBe('start-issued');
    f.loseStart('none');
    const next = f.freshHolder();
    if (loss === 'after') {
      await next.open(f.record, f.journal);
      expect(f.state().sourceReader?.phase).toBe('running');
    } else await expect(next.open(f.record, f.journal)).rejects.toThrow();
    expect(f.effects.filter((e) => e.kind === 'start')).toHaveLength(1);
  });
  it('observes the exact terminal holder after an unknown close without repeating STOP', async () => {
    const f = fixture();
    await f.holder.open(f.record, f.journal);
    f.loseStop();
    await expect(f.holder.close(f.record, f.journal)).rejects.toThrow();
    expect(f.state().sourceReader?.phase).toBe('close-issued');
    await f.freshHolder().open(f.record, f.journal);
    expect(f.state().sourceReader?.phase).toBe('closed');
    expect(f.effects.filter((e) => e.kind === 'stop')).toHaveLength(1);
  });
  it('can freshly verify its immutable closed cursor after a lost final publication acknowledgement', async () => {
    const f = fixture();
    await f.holder.open(f.record, f.journal);
    f.publishHook((next) => {
      if (next.sourceReader?.phase === 'closed') throw Error('Lost final close reply');
    });
    await expect(f.holder.close(f.record, f.journal)).rejects.toThrow();
    expect(f.state().sourceReader?.phase).toBe('closed');
    f.publishHook(undefined);
    await f.freshHolder().open(f.record, f.journal);
    expect(f.effects.filter((e) => e.kind === 'stop')).toHaveLength(1);
  });
  it.each(['source-running', 'PID-birth', 'HOME', 'helper-user', 'helper-mount', 'helper-label'] as const)(
    'refuses changed %s before any private context read',
    async (change) => {
      const f = fixture();
      await f.holder.open(f.record, f.journal);
      f.reads.splice(0);
      if (change === 'source-running') {
        f.src.raw.State.Running = true;
        f.src.raw.State.Pid = 100;
        f.src.raw.State.Status = 'running';
      }
      if (change === 'PID-birth') f.ticks('6000');
      if (change === 'HOME') f.home.ino = 'other';
      if (change === 'helper-user') (f.helper().Config as Record<string, unknown>).User = '0:0';
      if (change === 'helper-mount')
        ((f.helper().HostConfig as Record<string, unknown>).Mounts as Array<Record<string, unknown>>)[0]!.ReadOnly =
          false;
      if (change === 'helper-label')
        ((f.helper().Config as Record<string, unknown>).Labels as Record<string, string>).foreign = 'new';
      await expect(f.holder.context(f.record, f.journal, selected)).rejects.toThrow();
      expect(f.reads).toEqual([]);
      expect(f.effects).toHaveLength(2);
    }
  );
  it('checks revocation after actual source reads and before issuing any helper effect', async () => {
    const f = fixture();
    f.src.qualifyImage.mockImplementation(async () => {
      f.revoke();
    });
    await expect(f.holder.open(f.record, f.journal)).rejects.toMatchObject({
      code: 'DOCKER_PLAN_SOURCE_HOLDER_UNCONFIRMED',
    });
    expect(f.effects).toEqual([]);
  });
  it('serializes two concurrent opens on one holder without two physical CREATEs', async () => {
    const f = fixture();
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    f.src.qualifyImage.mockImplementationOnce(async () => wait);
    const a = f.holder.open(f.record, f.journal);
    await expect(f.holder.open(f.record, f.journal)).rejects.toThrow();
    release();
    await a;
    expect(f.effects.filter((e) => e.kind === 'create')).toHaveLength(1);
  });
  it('keeps the original create cursor when publication loses acknowledgement and does not issue CREATE', async () => {
    const f = fixture();
    f.publishHook((next) => {
      if (next.sourceReader?.phase === 'create-issued') throw Error('Lost durable intent reply');
    });
    await expect(f.holder.open(f.record, f.journal)).rejects.toThrow();
    expect(f.state().sourceReader?.phase).toBe('create-issued');
    expect(f.effects).toEqual([]);
  });
  it('reads SDK-rotated retained auth only for the frozen target lineage and completed original helper ACK', async () => {
    const f = fixture(),
      selection = f.retained();
    await f.holder.open(f.record, f.journal);
    f.reads.splice(0);
    const observed = await f.holder.auth(f.record, f.journal, selection);
    expect(observed).toEqual({
      auth: '{"SDK":"rotated"}',
      installedAuthDigest: sha('{"SDK":"installed"}'),
      observedAuthDigest: sha('{"SDK":"rotated"}'),
    });
    expect(f.reads).toEqual(['auth']);
    f.reads.splice(0);
    await expect(
      f.holder.auth(f.record, f.journal, {
        ...selection,
        initial: { ...selection.initial, contextDigest: '0'.repeat(64), observedContextDigest: '0'.repeat(64) },
      })
    ).rejects.toThrow();
    expect(f.reads).toEqual([]);
    await expect(
      f.holder.auth(f.record, f.journal, { ...selection, row: { ...selection.row, owner: 'foreign' } })
    ).rejects.toThrow();
    expect(f.reads).toEqual([]);
  });
  it('correlates remapped daemon account mounts with actual selected account FD identity', async () => {
    const f = fixture(),
      root = fs.mkdtempSync(join(tmpdir(), 'holder-account-'));
    roots.push(root);
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(join(root, '.credentials.json'), '{"SDK":"source"}', { mode: 0o600 });
    const profile = {
      id: 'account-a',
      label: 'A',
      provider: 'anthropic' as const,
      configDir: root,
      openCodeDataDir: join(root, 'data'),
    };
    const account: PlanAccount = {
      id: 'account-a',
      label: 'A',
      provider: 'anthropic',
      configDir: root,
      realDir: root,
      profileId: 'account-a',
      isDefault: false,
      profile,
    };
    const snapshot = await DockerPlanAccountSnapshot.capture({ account: async () => account }, 'account-a', () => {});
    f.projectAccount(account);
    try {
      await f.holder.open(f.record, f.journal, { snapshot, account });
      const mounts = (f.config().HostConfig as Record<string, unknown>).Mounts;
      expect(mounts).toContainEqual({
        Type: 'bind',
        Source: '/daemon-private/account-a',
        Target: '/source-account',
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true },
      });
      const observed = await f.holder.context(f.record, f.journal, { ...selected, kind: 'account' });
      const stat = fs.statSync(root, { bigint: true });
      expect(observed.context.source).toEqual({ kind: 'intake', dev: String(stat.dev), ino: String(stat.ino) });
      expect(observed.contextSource).toBe('/daemon-private/account-a');
      fs.writeFileSync(join(root, '.credentials.json'), '{"SDK":"changed"}', { mode: 0o600 });
      f.reads.splice(0);
      await expect(f.holder.context(f.record, f.journal, { ...selected, kind: 'account' })).rejects.toThrow();
      expect(f.reads).toEqual([]);
    } finally {
      snapshot.close();
    }
  });
  it('scrubs malformed private stdout rather than putting SDK bytes in an exception', async () => {
    const f = fixture(),
      selection = f.retained();
    await f.holder.open(f.record, f.journal);
    f.privateReply('PRIVATE_SDK_SECRET-not-json');
    let error: unknown;
    try {
      await f.holder.auth(f.record, f.journal, selection);
    } catch (value) {
      error = value;
    }
    expect(error).toMatchObject({ code: 'DOCKER_PLAN_SOURCE_HOLDER_UNCONFIRMED' });
    expect(String(error)).not.toContain('PRIVATE_SDK_SECRET');
  });
});

describe('readonly original source-holder inspection', () => {
  it('does not create a reader when no original intent exists', async () => {
    const f = fixture();
    await expect(f.freshHolder().inspect(f.record, f.journal)).resolves.toBeUndefined();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.command.run).not.toHaveBeenCalled();
    expect(f.state().sourceReader).toBeUndefined();
  });
  it.each(['create-issued', 'created', 'start-issued', 'running', 'close-issued', 'closed'] as const)(
    'earns actual original %s metadata without effect or cursor publication',
    async (phase) => {
      const f = fixture();
      if (phase === 'create-issued') f.loseCreate('after');
      if (phase === 'created')
        f.publishHook((next) => {
          if (next.sourceReader?.phase === 'created') throw Error('Lost created publication acknowledgement');
        });
      if (phase === 'start-issued') f.loseStart('after');
      if (['create-issued', 'created', 'start-issued'].includes(phase))
        await expect(f.holder.open(f.record, f.journal)).rejects.toThrow();
      else await f.holder.open(f.record, f.journal);
      f.publishHook(undefined);
      if (phase === 'close-issued') {
        f.loseStop();
        await expect(f.holder.close(f.record, f.journal)).rejects.toThrow();
      } else if (phase === 'closed') await f.holder.close(f.record, f.journal);
      expect(f.state().sourceReader?.phase).toBe(phase);
      const before = f.state(),
        effects = [...f.effects],
        reads = [...f.reads];
      await expect(f.freshHolder().inspect(f.record, f.journal)).resolves.toBeUndefined();
      expect(f.state()).toEqual(before);
      expect(f.effects).toEqual(effects);
      expect(f.reads).toEqual(reads);
    }
  );
  it('holds an unknown CREATE with no actual original container rather than claiming absence closed it', async () => {
    const f = fixture();
    f.loseCreate('before');
    await expect(f.holder.open(f.record, f.journal)).rejects.toThrow();
    const before = f.state(),
      effects = [...f.effects];
    await expect(f.freshHolder().inspect(f.record, f.journal)).rejects.toThrow();
    expect(f.state()).toEqual(before);
    expect(f.effects).toEqual(effects);
  });
  it('holds a START intent whose actual container is still Created without dispatching it again', async () => {
    const f = fixture();
    f.loseStart('before');
    await expect(f.holder.open(f.record, f.journal)).rejects.toThrow();
    const before = f.state(),
      effects = [...f.effects];
    await expect(f.freshHolder().inspect(f.record, f.journal)).rejects.toThrow();
    expect(f.state()).toEqual(before);
    expect(f.effects).toEqual(effects);
  });
  it.each(['configuration', 'birth', 'source', 'revoked', 'terminal-digest'] as const)(
    'refuses changed %s evidence without new effects',
    async (kind) => {
      const f = fixture();
      await f.holder.open(f.record, f.journal);
      if (kind === 'terminal-digest') {
        await f.holder.close(f.record, f.journal);
        (f.helper().State as Record<string, unknown>).ExitCode = 9;
      }
      if (kind === 'configuration') (f.helper().Config as Record<string, unknown>).User = '0:0';
      if (kind === 'birth') f.ticks('5001');
      if (kind === 'source') f.src.raw.State.Pid = 1;
      if (kind === 'revoked') f.revoke();
      const before = f.state(),
        effects = [...f.effects];
      await expect(f.freshHolder().inspect(f.record, f.journal)).rejects.toThrow();
      expect(f.state()).toEqual(before);
      expect(f.effects).toEqual(effects);
    }
  );
  it('refuses a current cursor change across the image observation await', async () => {
    const f = fixture();
    await f.holder.open(f.record, f.journal);
    const original = vi.mocked(f.command.run).getMockImplementation()!;
    let changed = false;
    vi.mocked(f.command.run).mockImplementation(async (args) => {
      const value = await original(args);
      if (!changed && args[0] === 'image') {
        changed = true;
        const before = f.journal.read(),
          cursor = before.sourceReader!;
        await f.journal.publish(
          before,
          DockerPlanMoveJournalState.parse({ ...before, sourceReader: { ...cursor, phase: 'close-issued' } })
        );
      }
      return value;
    });
    const effects = [...f.effects];
    await expect(f.freshHolder().inspect(f.record, f.journal)).rejects.toThrow('CURSOR_CHANGED');
    expect(f.effects).toEqual(effects);
  });
});
