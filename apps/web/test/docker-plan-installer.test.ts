import { describe, expect, it, vi } from 'vitest';
import { DockerPlanInstaller } from '../src/docker-plan-installer.js';
import { identityHelperConfiguration } from '../src/docker-identity-helper.js';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import type { DockerContinuationTaskJournal } from '../src/docker-continuation-task.js';
const uuid = (n: number) => n.toString().padStart(8, '0') + '-0000-4000-8000-000000000001',
  hex = (s: string) => s.repeat(64),
  image = 'sha256:' + hex('e');
async function fixture() {
  const box = hex('7'),
    home = { source: '/synthetic/home', user: '1000:100', dev: '11', ino: '12' };
  const poolPolicy = {
    memoryMaxBytes: 48 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 8192,
    cpuWeight: 100,
    allowedCpus: [0, 1],
  };
  const original = {
    containerId: hex('a'),
    imageId: image,
    deployment: 'synthetic',
    employeeId: uuid(1),
    sessionId: uuid(2),
    home: { type: 'bind', source: home.source, destination: '/home/agent', readWrite: true },
    mountDigest: hex('b'),
    storageDigest: hex('b'),
    configurationDigest: hex('b'),
  };
  const initial = {
    version: 1,
    purpose: 'reverie-plan-installed-v1',
    readMode: 'initial',
    operationId: uuid(5),
    sessionId: uuid(4),
    containerId: hex('c'),
    projectionDigest: hex('b'),
    accountId: 'account-b',
    provider: 'anthropic',
    contextInputDigest: hex('d'),
    installedAuthDigest: hex('1'),
    observedAuthDigest: hex('1'),
    tokenDigest: hex('2'),
    contextDigest: hex('3'),
    observedContextDigest: hex('3'),
    homeDev: home.dev,
    homeIno: home.ino,
    configDev: '11',
    configIno: '13',
  };
  const live = {
    ...initial,
    purpose: 'reverie-plan-live-observation-v1',
    readMode: 'live',
    observedAuthDigest: hex('4'),
    observedContextDigest: hex('5'),
  };
  const row = DockerEmployeeContinuationRecord.parse({
    version: 3,
    purpose: 'docker-employee-plan-replacement-v3',
    employeeId: uuid(1),
    owner: 'synthetic-owner',
    request: {
      operationId: uuid(5),
      sessionId: uuid(4),
      sessionGeneration: 2,
      containerId: original.containerId,
      imageId: image,
      expectedPolicyDigest: hex('b'),
      expectedDestinationImageId: image,
      enterOffice: false,
    },
    sourceDigest: hex('b'),
    providerSourceDigest: hex('b'),
    original,
    workerImage: { imageId: image, sourceImageId: image, clientManifestDigest: hex('b') },
    policy: { ...poolPolicy, pidsMax: 512, memoryHighBytes: 24 * 1024 ** 3, pool: poolPolicy },
    credentialId: uuid(6),
    phase: 'provider-issued',
    pool: { containerId: hex('6'), cgroupParent: '/synthetic', policyDigest: hex('b'), physicalDigest: hex('b') },
    destination: { ...original, containerId: hex('c'), sessionId: uuid(4) },
    planReplacement: {
      version: 1,
      purpose: 'docker-plan-replacement-provenance-v1',
      moveId: 'synthetic-move',
      source: {
        binding: {
          version: 1,
          operationId: uuid(3),
          credentialId: uuid(7),
          sessionId: uuid(2),
          sessionGeneration: 1,
          containerId: original.containerId,
          imageId: image,
          originalDigest: hex('b'),
          policyDigest: hex('b'),
        },
        continuationDigest: hex('b'),
        providerSourceDigest: hex('b'),
      },
      account: { id: 'account-b', provider: 'anthropic', projectionDigest: hex('b'), contextDigest: hex('d') },
    },
    tasks: [
      {
        role: 'storage-holder',
        name: 'reverie-boxed-storage-synthetic',
        imageId: image,
        configurationDigest: hex('b'),
        phase: 'running',
        containerId: hex('7'),
        initPid: 100,
        initStartTicks: '10',
      },
      {
        role: 'leaf-helper',
        name: 'reverie-boxed-leaf-synthetic',
        imageId: image,
        configurationDigest: hex('b'),
        phase: 'completed',
        containerId: hex('8'),
        resultDigest: hex('b'),
      },
      {
        role: 'identity-helper',
        name: 'reverie-boxed-identity-' + digest([box, 'identity-helper', uuid(5)]),
        imageId: image,
        configurationDigest: hex('b'),
        phase: 'completed',
        containerId: hex('9'),
        resultDigest: digest(initial),
      },
    ],
  });
  if (row.version !== 3) throw Error('Expected v3 fixture');
  const command: DockerEngineCommand = {
    create: vi.fn(async () => {
      throw Error('CREATE forbidden');
    }),
    run: vi.fn(async (args) => {
      if (args[0] === 'image') return JSON.stringify([{ Id: image, Config: { Env: ['PATH=/bin'], Volumes: null } }]);
      throw Error('unexpected');
    }),
  };
  const config = await identityHelperConfiguration(command, row, home, box, {
    projectionDigest: hex('b'),
    payloadDigest: hex('a'),
    attempt: uuid(5),
  });
  const task = row.tasks!.find((t) => t.role === 'identity-helper')!;
  task.configurationDigest = digest(config);
  const terminal = {
    Status: 'exited',
    Running: false,
    Pid: 0,
    ExitCode: 0,
    OOMKilled: false,
    Dead: false,
    Restarting: false,
    Paused: false,
    StartedAt: 'synthetic',
    FinishedAt: 'synthetic',
  };
  const raw: Record<string, unknown> = {
    Id: hex('9'),
    Image: image,
    Config: Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'HostConfig')),
    HostConfig: structuredClone(config.HostConfig),
    Mounts: [{ Type: 'bind', Source: home.source, Destination: '/home/agent', RW: true }],
    State: terminal,
  };
  let nativeRead = false,
    mutate: undefined | (() => void);
  vi.mocked(command.run).mockImplementation(async (args) => {
    if (args[0] === 'image') return JSON.stringify([{ Id: image, Config: { Env: ['PATH=/bin'], Volumes: null } }]);
    if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify([raw]);
    if (args[0] === 'logs') return JSON.stringify(initial) + '\n';
    if (args[0] === 'exec') {
      nativeRead = true;
      mutate?.();
      return JSON.stringify(live) + '\n';
    }
    throw Error('unexpected ' + args[0]);
  });
  const journal: DockerContinuationTaskJournal = {
    read: () => task,
    publish: vi.fn(async () => {
      throw Error('publish forbidden');
    }),
  };
  const installer = new DockerPlanInstaller(command, journal, async () => ({ ...home }), box);
  return {
    installer,
    row,
    raw,
    home,
    initial,
    live,
    task,
    command,
    journal,
    config,
    mutateOnGuest: (fn: () => void) => {
      mutate = fn;
    },
    nativeRead: () => nativeRead,
  };
}
describe('real contained plan installer observation', () => {
  it('reads the historical completed ACK without executing a stopped guest or earning live evidence', async () => {
    const f = await fixture();
    const result = await f.installer.original(f.row, () => {});
    expect(result).toEqual(f.initial);
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.nativeRead()).toBe(false);
    expect(vi.mocked(f.command.run).mock.calls.every(([args]) => args[0] !== 'exec' && args[1] !== 'start')).toBe(true);
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.journal.publish).not.toHaveBeenCalled();
  });
  it.each(['ack', 'terminal', 'home'] as const)(
    'rejects changed historical %s evidence without guest execution',
    async (change) => {
      const f = await fixture();
      if (change === 'ack') f.initial.tokenDigest = hex('0');
      if (change === 'terminal') (f.raw.State as Record<string, unknown>).ExitCode = 1;
      if (change === 'home') f.home.ino = '99';
      await expect(f.installer.original(f.row, () => {})).rejects.toMatchObject({
        code: expect.stringMatching(/^DOCKER_/),
      });
      expect(f.nativeRead()).toBe(false);
    }
  );
  it('joins original terminal ACK to fresh guest read while distinguishing initial and refreshed observations', async () => {
    const f = await fixture();
    const result = await f.installer.observe(f.row, () => {});
    expect(result.initial).toEqual(f.initial);
    expect(result.live).toEqual(f.live);
    expect(result.live.observedAuthDigest).not.toBe(result.initial.installedAuthDigest);
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.journal.publish).not.toHaveBeenCalled();
    expect(vi.mocked(f.command.run).mock.calls.every(([a]) => a[1] !== 'start')).toBe(true);
    expect(vi.mocked(f.command.run).mock.calls.find(([a]) => a[0] === 'exec')![0]).toContain('live');
  });
  it.each([
    'image',
    'label',
    'restart',
    'running',
    'mount',
    'propagation',
    'task',
    'ack',
    'guest',
    'context',
    'home',
    'malformed',
  ] as const)('refuses changed %s without CREATE/START', async (change) => {
    const f = await fixture();
    const config = f.raw.Config as Record<string, unknown>,
      host = f.raw.HostConfig as Record<string, unknown>;
    if (change === 'image') f.raw.Image = 'sha256:' + hex('0');
    if (change === 'label') (config.Labels as Record<string, string>)['reverie.box.identity.box'] = hex('0');
    if (change === 'restart') host.RestartPolicy = { Name: 'always' };
    if (change === 'running') f.raw.State = { ...(f.raw.State as object), Running: true, Status: 'running', Pid: 42 };
    if (change === 'mount') (f.raw.Mounts as Array<Record<string, unknown>>)[0]!.Source = '/foreign';
    if (change === 'propagation')
      ((host.Mounts as Array<Record<string, unknown>>)[0]!.BindOptions as Record<string, unknown>).Propagation =
        'shared';
    if (change === 'task') f.task.configurationDigest = hex('0');
    if (change === 'ack') f.initial.tokenDigest = hex('0');
    if (change === 'guest') f.live.tokenDigest = hex('0');
    if (change === 'context') f.live.contextInputDigest = hex('0');
    if (change === 'home') f.home.ino = '99';
    if (change === 'malformed') f.raw.Config = null;
    await expect(f.installer.observe(f.row, () => {})).rejects.toMatchObject({
      code: expect.stringMatching(/^DOCKER_/),
    });
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.journal.publish).not.toHaveBeenCalled();
    expect(vi.mocked(f.command.run).mock.calls.every(([a]) => a[1] !== 'start')).toBe(true);
  });
  it('revalidates original helper after awaited live read and current authority after each await', async () => {
    const f = await fixture();
    f.mutateOnGuest(() => {
      (f.raw.State as Record<string, unknown>).ExitCode = 1;
    });
    await expect(f.installer.observe(f.row, () => {})).rejects.toMatchObject({
      code: 'DOCKER_PLAN_INSTALL_UNCONFIRMED',
    });
    const g = await fixture();
    let revoked = false;
    g.mutateOnGuest(() => {
      revoked = true;
    });
    await expect(
      g.installer.observe(g.row, () => {
        if (revoked) throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
  });
  it('does not use a matching installed receipt when a guest cannot establish the private token custody', async () => {
    const f = await fixture(),
      original = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation((a, b) =>
      a[0] === 'exec' ? Promise.reject(Error('private file refused')) : original(a, b)
    );
    await expect(f.installer.observe(f.row, () => {})).rejects.toThrow('private file refused');
    expect(f.command.create).not.toHaveBeenCalled();
  });
});

async function installFixture() {
  const f = await fixture();
  let task: import('../src/docker-continuation-task.js').DockerContinuationTask | undefined;
  const row = {
    ...f.row,
    phase: 'identity-issued' as const,
    tasks: f.row.tasks!.filter((t) => t.role !== 'identity-helper'),
  };
  f.journal.read = () => task;
  f.journal.publish = vi.fn(
    async (...[r, before, next, current]: Parameters<DockerContinuationTaskJournal['publish']>) => {
      current();
      expect(task).toEqual(before);
      task = structuredClone(next);
      return { ...r, tasks: [...r.tasks!.filter((t) => t.role !== 'identity-helper'), task] };
    }
  );
  const original = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.create).mockImplementation(async (_name, config, current) => {
    current();
    expect(task?.phase).toBe('create-issued');
    Object.assign(f.raw, {
      Config: Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'HostConfig')),
      HostConfig: structuredClone(config.HostConfig),
      State: {
        Status: 'created',
        Running: false,
        Pid: 0,
        ExitCode: 0,
        OOMKilled: false,
        Dead: false,
        Restarting: false,
        Paused: false,
      },
    });
    return '9'.repeat(64);
  });
  vi.mocked(f.command.run).mockImplementation(async (a, b) => {
    if (a[0] === 'container' && a[1] === 'ls')
      return task?.phase === 'create-issued' && !('containerId' in task) ? '' : '9'.repeat(64);
    if (a[0] === 'container' && a[1] === 'start') {
      expect(task?.phase).toBe('start-issued');
      expect(b).toBe('synthetic-private-payload');
      expect(a).not.toContain(b);
      f.raw.State = {
        Status: 'exited',
        Running: false,
        Pid: 0,
        ExitCode: 0,
        OOMKilled: false,
        Dead: false,
        Restarting: false,
        Paused: false,
      };
      return JSON.stringify(f.initial) + '\n';
    }
    if (a[0] === 'exec') return JSON.stringify(f.initial) + '\n';
    return original(a, b);
  });
  return { ...f, row, getTask: () => task };
}
describe('same-journal contained plan install dispatch', () => {
  it('persists CREATE and START before each original effect, then requires original and guest initial receipts', async () => {
    const f = await installFixture();
    expect(await f.installer.provision(f.row, 'synthetic-private-payload', undefined, () => {})).toEqual(f.initial);
    expect(f.getTask()?.phase).toBe('completed');
    expect(f.command.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(1);
    expect(JSON.stringify(f.getTask())).not.toContain('synthetic-private-payload');
  });
  it('settles an unknown START from original terminal ACK and guest custody without retransmitting', async () => {
    const f = await installFixture(),
      native = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (a, b) => {
      const v = await native(a, b);
      if (a[1] === 'start') throw Error('lost START reply');
      return v;
    });
    await expect(f.installer.provision(f.row, 'synthetic-private-payload', undefined, () => {})).rejects.toThrow(
      'lost START reply'
    );
    expect(f.getTask()?.phase).toBe('start-issued');
    expect(await f.installer.provision(f.row, 'synthetic-private-payload', undefined, () => {})).toEqual(f.initial);
    expect(f.getTask()?.phase).toBe('completed');
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(1);
    expect(f.command.create).toHaveBeenCalledOnce();
  });
  it('retains uncertain CREATE and refuses another allocation after a proven empty census', async () => {
    const f = await installFixture();
    vi.mocked(f.command.create).mockRejectedValue(Error('unknown CREATE'));
    await expect(f.installer.provision(f.row, 'synthetic-private-payload', undefined, () => {})).rejects.toThrow(
      'unknown CREATE'
    );
    await expect(f.installer.provision(f.row, 'synthetic-private-payload', undefined, () => {})).rejects.toMatchObject({
      code: 'DOCKER_PLAN_INSTALL_CREATE_UNCONFIRMED',
    });
    expect(f.command.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(0);
  });
  it('holds changed private material after original issuance without rewriting its task or issuing another effect', async () => {
    const f = await installFixture();
    await f.installer.provision(f.row, 'synthetic-private-payload', undefined, () => {});
    const before = structuredClone(f.getTask());
    await expect(f.installer.provision(f.row, 'changed-payload', undefined, () => {})).rejects.toMatchObject({
      code: 'DOCKER_PLAN_INSTALL_TASK_CHANGED',
    });
    expect(f.getTask()).toEqual(before);
    expect(f.command.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(1);
  });
});

describe('ordinary canonical account completion', () => {
  it('accepts only fresh installed and observed auth matching the held canonical digest', async () => {
    const f = await fixture();
    f.live.observedAuthDigest = f.initial.installedAuthDigest;
    const result = await f.installer.observe(f.row, () => {}, f.initial.installedAuthDigest);
    expect(result.live.observedAuthDigest).toBe(f.initial.installedAuthDigest);
    expect(f.nativeRead()).toBe(true);
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.journal.publish).not.toHaveBeenCalled();
  });
  it('retains truthful changed-auth observations for generic readonly views without granting ordinary completion', async () => {
    const f = await fixture();
    const observed = await f.installer.observe(f.row, () => {});
    expect(observed.live.observedAuthDigest).not.toBe(observed.initial.installedAuthDigest);
    await expect(f.installer.observe(f.row, () => {}, f.initial.installedAuthDigest)).rejects.toMatchObject({
      code: 'DOCKER_PLAN_ACCOUNT_AUTH_CHANGED',
    });
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.journal.publish).not.toHaveBeenCalled();
  });
  it('refuses an installed receipt different from the held canonical account digest', async () => {
    const f = await fixture();
    f.live.observedAuthDigest = f.initial.installedAuthDigest;
    await expect(f.installer.observe(f.row, () => {}, 'a'.repeat(64))).rejects.toMatchObject({
      code: 'DOCKER_PLAN_ACCOUNT_AUTH_CHANGED',
    });
  });
  it('refuses auth changed during the awaited actual guest read before any completion credit', async () => {
    const f = await fixture();
    f.live.observedAuthDigest = f.initial.installedAuthDigest;
    f.mutateOnGuest(() => {
      f.live.observedAuthDigest = 'f'.repeat(64);
    });
    await expect(f.installer.observe(f.row, () => {}, f.initial.installedAuthDigest)).rejects.toMatchObject({
      code: 'DOCKER_PLAN_ACCOUNT_AUTH_CHANGED',
    });
    expect(f.nativeRead()).toBe(true);
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.journal.publish).not.toHaveBeenCalled();
  });
});
