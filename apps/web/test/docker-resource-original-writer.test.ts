import { createHash } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import type { DockerContinuationTaskRole, DockerContinuationTask } from '../src/docker-continuation-task.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import { dockerResourceHelperConfiguration } from '../src/docker-resource-helper-inspection.js';
import {
  DockerOriginalResourceWriterReader,
  DockerOriginalResourceWriterProof,
  requireDockerOriginalResourceWriterProof,
  requireDockerOriginalResourcePrestartProof,
  type DockerOriginalResourceWriterKey,
} from '../src/docker-resource-original-writer.js';

const box = 'a'.repeat(64),
  image = 'sha256:' + 'b'.repeat(64),
  id = 'c'.repeat(64),
  worker = 'd'.repeat(64);
const key: DockerOriginalResourceWriterKey = {
  revision: '11111111-1111-4111-8111-111111111111',
  scopeDigest: 'e'.repeat(64),
  employeeId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  sessionGeneration: 2,
  operationId: '44444444-4444-4444-8444-444444444444',
  containerId: worker,
};
function fixture() {
  const name =
    'reverie-boxed-leaf-helper-' + dockerContinuationDigest([box, 'leaf-helper', key.operationId, key.revision]);
  const args = [
    'configure-memory-high',
    '--box-id',
    box,
    '--anchor-id',
    'f'.repeat(64),
    '--anchor-pid',
    '100',
    '--anchor-start',
    '200',
    '--worker-id',
    worker,
    '--worker-pid',
    '300',
    '--worker-start',
    '400',
    '--member',
    '1'.repeat(64) + ':500:600',
    '--leaf-dev',
    '10',
    '--leaf-ino',
    '20',
    '--memory-max',
    '268435456',
    '--swap-max',
    '0',
    '--pids-max',
    '32',
    '--memory-high',
    '67108864',
    '--cpu-weight',
    '100',
    '--cpuset-cpus',
    '0-1',
  ];
  const configuration = dockerResourceHelperConfiguration(
    box,
    'leaf-helper',
    name,
    args,
    {
      path: `/reverie.slice/reverie-box.slice/reverie-box-${box}.slice/docker-${worker}.scope`,
      target: '/run/reverie-worker-cgroup',
    },
    image
  );
  const task: DockerContinuationTask = {
    phase: 'start-issued',
    role: 'leaf-helper',
    name,
    imageId: image,
    configurationDigest: dockerContinuationDigest(configuration),
    containerId: id,
  };
  const actual: Record<string, unknown> = {
    Id: id,
    Name: '/' + name,
    Image: image,
    Config: { ...configuration, Env: null },
    HostConfig: structuredClone(configuration.HostConfig),
    Mounts: (configuration.HostConfig as { Binds: string[] }).Binds.map((bind) => {
      const [Source, Destination, mode] = bind.split(':');
      return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
    }),
    State: {
      Status: 'exited',
      Running: false,
      Pid: 0,
      Paused: false,
      Restarting: false,
      Dead: false,
      ExitCode: 1,
      StartedAt: '2026-11-15T00:00:00.000000001Z',
      FinishedAt: '2026-11-15T00:00:00.000000002Z',
    },
  };
  const capability = {
    Id: image,
    Config: {
      User: '0:0',
      Entrypoint: ['/bin/reverie-docker-resources'],
      Labels: { 'org.reverie.purpose': 'boxed-resource-helper-v1', 'org.reverie.resource.memory-high-only': 'v1' },
    },
  };
  const calls: string[][] = [];
  let inspect = 0,
    listing = id + '\n',
    valid = true;
  let before: ((args: readonly string[], index: number) => void | Promise<void>) | undefined;
  const command: DockerEngineCommand = {
    create: async () => {
      throw Error('No effect command allowed');
    },
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'container' && argv[1] === 'inspect') inspect++;
      await before?.(argv, inspect);
      if (argv[0] === 'image' && argv[1] === 'inspect' && argv[2] === image) return JSON.stringify([capability]);
      if (argv[0] === 'container' && argv[1] === 'inspect' && argv[2] === id) return JSON.stringify([actual]);
      if (argv[0] === 'container' && argv[1] === 'ls') return listing;
      throw Error('Unexpected Docker command: ' + argv.join(' '));
    },
  };
  const current = () => {
    if (!valid) throw Error('Original grant/key no longer current');
  };
  return {
    reader: new DockerOriginalResourceWriterReader(command),
    task,
    actual,
    capability,
    configuration,
    calls,
    current,
    setListing(value: string) {
      listing = value;
    },
    before(value: typeof before) {
      before = value;
    },
    revoke() {
      valid = false;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe('original-helper NoFutureWriter proof', () => {
  it('closes an actual terminal helper without reading the stopped/rebound/removed worker or current Box', async () => {
    const f = fixture();
    const proof = await f.reader.capture(key, f.task, f.current);
    const receipt = requireDockerOriginalResourceWriterProof(proof, key, f.task);
    expect(receipt).toMatchObject({
      originalKey: key,
      originalBoxId: box,
      containerId: id,
      imageId: image,
      configurationDigest: f.task.configurationDigest,
      exitCode: 1,
      originalOutcome: 'unknown',
    });
    expect(receipt).not.toHaveProperty('identity');
    expect(receipt).not.toHaveProperty('policy');
    expect(f.calls).toEqual([
      ['image', 'inspect', image],
      ['container', 'inspect', id],
      ['container', 'inspect', id],
    ]);
    receipt.originalKey.sessionGeneration++;
    expect(proof.require(key, f.task).originalKey.sessionGeneration).toBe(2);
  });
  it('keeps even zero exit/completed task execution outcome unknown without adopting ACK or policy', async () => {
    const f = fixture();
    (f.actual.State as Record<string, unknown>).ExitCode = 0;
    const task: DockerContinuationTask = { ...f.task, phase: 'completed', resultDigest: '9'.repeat(64) };
    expect((await f.reader.capture(key, task, f.current)).require(key, task).originalOutcome).toBe('unknown');
    expect(f.calls.every((args) => args[1] === 'inspect')).toBe(true);
  });
  it.each([
    [
      'image',
      (f: ReturnType<typeof fixture>) => {
        f.actual.Image = 'sha256:' + '0'.repeat(64);
      },
    ],
    [
      'box-label',
      (f: ReturnType<typeof fixture>) => {
        ((f.actual.Config as Record<string, unknown>).Labels as Record<string, string>)['reverie.box.resource.box'] =
          '0'.repeat(64);
      },
    ],
    [
      'role-label',
      (f: ReturnType<typeof fixture>) => {
        ((f.actual.Config as Record<string, unknown>).Labels as Record<string, string>)['reverie.box.resource.role'] =
          'pool-helper';
      },
    ],
    [
      'name',
      (f: ReturnType<typeof fixture>) => {
        f.actual.Name = '/wrong';
      },
    ],
    [
      'restart',
      (f: ReturnType<typeof fixture>) => {
        (f.actual.HostConfig as Record<string, unknown>).RestartPolicy = { Name: 'always', MaximumRetryCount: 0 };
      },
    ],
    [
      'restart-count',
      (f: ReturnType<typeof fixture>) => {
        (f.actual.HostConfig as Record<string, unknown>).RestartPolicy = { Name: 'no', MaximumRetryCount: 1 };
      },
    ],
    [
      'auto-remove',
      (f: ReturnType<typeof fixture>) => {
        (f.actual.HostConfig as Record<string, unknown>).AutoRemove = true;
      },
    ],
    [
      'writable-root',
      (f: ReturnType<typeof fixture>) => {
        (f.actual.HostConfig as Record<string, unknown>).ReadonlyRootfs = false;
      },
    ],
    [
      'extra-devices',
      (f: ReturnType<typeof fixture>) => {
        (f.actual.HostConfig as Record<string, unknown>).Devices = [{}];
      },
    ],
    [
      'extra-mount',
      (f: ReturnType<typeof fixture>) => {
        (f.actual.Mounts as unknown[]).push({ Type: 'bind', Source: '/elsewhere', Destination: '/x', RW: true });
      },
    ],
    [
      'changed-bind',
      (f: ReturnType<typeof fixture>) => {
        (f.actual.HostConfig as Record<string, unknown>).Binds = ['/elsewhere:/run/reverie-worker-cgroup:rw'];
      },
    ],
    [
      'capability',
      (f: ReturnType<typeof fixture>) => {
        f.capability.Config.Labels['org.reverie.resource.memory-high-only'] = '';
      },
    ],
    [
      'task-digest',
      (f: ReturnType<typeof fixture>) => {
        f.task.configurationDigest = '0'.repeat(64);
      },
    ],
    [
      'mode',
      (f: ReturnType<typeof fixture>) => {
        ((f.actual.Config as Record<string, unknown>).Cmd as string[])[0] = 'configure-high';
      },
    ],
  ] as const)('refuses %s independently of execution outcome', async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(f.reader.capture(key, f.task, f.current)).rejects.toThrow();
    expect(f.calls.every((args) => args[1] === 'inspect')).toBe(true);
  });
  it.each([
    { Running: true },
    { Pid: 123 },
    { Status: 'created' },
    { Paused: true },
    { Restarting: true },
    { Dead: true },
    { ExitCode: 256 },
    { ExitCode: null },
  ])('refuses nonterminal/ambiguous actual state %j', async (patch) => {
    const f = fixture();
    Object.assign(f.actual.State as object, patch);
    await expect(f.reader.capture(key, f.task, f.current)).rejects.toThrow();
  });
  it('does not turn actual absence or inspect transport failure into a closure proof', async () => {
    const f = fixture();
    f.before((args) => {
      if (args[0] === 'container') throw Error('No such container');
    });
    await expect(f.reader.capture(key, f.task, f.current)).rejects.toThrow('No such container');
  });
  it.each(['state', 'config', 'revoked'] as const)(
    'refuses %s changing across the two observations',
    async (change) => {
      const f = fixture();
      f.before((args, index) => {
        if (args[0] !== 'container' || index !== 2) return;
        if (change === 'state') (f.actual.State as Record<string, unknown>).FinishedAt = 'later';
        if (change === 'config') (f.actual.HostConfig as Record<string, unknown>).AutoRemove = true;
        if (change === 'revoked') f.revoke();
      });
      await expect(f.reader.capture(key, f.task, f.current)).rejects.toThrow();
    }
  );
  it('requires the exact retained key/task and a current genuine process-local proof', async () => {
    const f = fixture(),
      proof = await f.reader.capture(key, f.task, f.current);
    for (const field of [
      'employeeId',
      'sessionId',
      'operationId',
      'revision',
      'containerId',
      'scopeDigest',
      'sessionGeneration',
    ] as const) {
      const changed = structuredClone(key);
      Object.assign(changed, { [field]: field === 'sessionGeneration' ? 3 : 'different' });
      const separate = await f.reader.capture(key, f.task, f.current);
      expect(() => requireDockerOriginalResourceWriterProof(separate, changed, f.task)).toThrow();
    }
    expect(() => requireDockerOriginalResourceWriterProof({}, key, f.task)).toThrow();
    expect(() => requireDockerOriginalResourceWriterProof({ require: () => ({}) }, key, f.task)).toThrow();
    expect(
      () =>
        new DockerOriginalResourceWriterProof(
          Symbol(),
          key,
          f.task,
          proof.require(key, f.task),
          performance.now(),
          f.current
        )
    ).toThrow();
    f.revoke();
    expect(() => proof.require(key, f.task)).toThrow();
  });
  it('expires a retained proof rather than publishing stale observations', async () => {
    const f = fixture(),
      proof = await f.reader.capture(key, f.task, f.current);
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 5001);
    expect(() => proof.require(key, f.task)).toThrow();
  });
  it.each(['operationId', 'revision', 'containerId'] as const)(
    'binds actual original configuration to key %s',
    async (field) => {
      const f = fixture();
      const wrong = {
        ...key,
        [field]: field === 'containerId' ? '0'.repeat(64) : '55555555-5555-4555-8555-555555555555',
      };
      await expect(f.reader.capture(wrong, f.task, f.current)).rejects.toThrow();
    }
  );
});
describe('preSTART retirement observation is separate from NoFutureWriter', () => {
  it('observes bounded double absence without granting writer closure or replay authority', async () => {
    const f = fixture();
    f.setListing('');
    const { containerId: _id, ...base } = f.task as DockerContinuationTask & { containerId: string };
    const task: DockerContinuationTask = { ...base, phase: 'create-issued' };
    const proof = await f.reader.inspectUnstarted(key, task, f.current);
    expect(requireDockerOriginalResourcePrestartProof(proof, key, task)).toMatchObject({
      observed: null,
      authority: 'canonical-retirement-cas-required-v1',
      originalOutcome: 'unknown',
    });
    expect(() => requireDockerOriginalResourceWriterProof(proof, key, task)).toThrow();
    expect(f.calls.filter((args) => args[1] === 'ls')).toHaveLength(2);
    expect(f.calls.every((args) => args[1] === 'inspect' || args[1] === 'ls')).toBe(true);
  });
  it('validates actual CREATED/PID0 original config before canonical retirement CAS', async () => {
    const f = fixture();
    (f.actual.State as Record<string, unknown>).Status = 'created';
    const task: DockerContinuationTask = { ...f.task, phase: 'created' };
    const proof = await f.reader.inspectUnstarted(key, task, f.current);
    expect(proof.require(key, task).observed).toMatchObject({ containerId: id, originalBoxId: box });
    expect(f.calls.filter((args) => args[1] === 'ls')).toHaveLength(0);
    await expect(f.reader.capture(key, task, f.current)).rejects.toThrow();
  });
  it.each(['duplicate', 'appeared', 'running'] as const)('holds ambiguous preSTART %s', async (change) => {
    const f = fixture();
    const { containerId: _id, ...base } = f.task as DockerContinuationTask & { containerId: string };
    const task: DockerContinuationTask = { ...base, phase: 'create-issued' };
    if (change === 'duplicate') f.setListing(id + '\n' + '0'.repeat(64) + '\n');
    if (change === 'appeared') {
      let lists = 0;
      f.setListing('');
      f.before((args) => {
        if (args[1] === 'ls' && ++lists === 2) f.setListing(id + '\n');
      });
    }
    if (change !== 'running') (f.actual.State as Record<string, unknown>).Status = 'created';
    await expect(f.reader.inspectUnstarted(key, task, f.current)).rejects.toThrow();
  });
});

// Byte-for-byte JSON hashes from the unmodified 1bbb private factory (all roles/modes).
describe('shared helper configuration preserves issued bytes', () => {
  it.each([
    {
      role: 'anchor',
      args: ['anchor'],
      writable: null,
      name: 'reverie-boxed-anchor-cccccccccccccccccccccccccccccccc',
      sha256: '7604207482162b07f7b1cfc255421240be7191727f7d38a6522d24f1d3cd9585',
    },
    {
      role: 'pool-helper',
      args: ['configure-pool'],
      writable: { path: '/one', target: '/run/reverie-box-pool' },
      name: 'reverie-boxed-pool-helper-cccccccccccccccccccccccccccccccc',
      sha256: 'f1f572587407f05489d5cbf6d50242d7962b6c71b24b00eea779f7ccf6187dd6',
    },
    {
      role: 'leaf-helper',
      args: ['configure-high'],
      writable: { path: '/two', target: '/run/reverie-worker-cgroup' },
      name: 'reverie-boxed-leaf-helper-cccccccccccccccccccccccccccccccc',
      sha256: '74b423eaf815869fbfff1379a328531389b92f8bf378bb86e43d772d28bc7769',
    },
    {
      role: 'leaf-helper',
      args: ['configure-memory-high'],
      writable: { path: '/two', target: '/run/reverie-worker-cgroup' },
      name: 'reverie-boxed-leaf-helper-cccccccccccccccccccccccccccccccc',
      sha256: 'f02ee305f64f604a7508835f4b3fdfa348f685990980a47b92079dd01d8b0646',
    },
    {
      role: 'storage-holder',
      args: ['storage-status'],
      writable: null,
      name: 'reverie-boxed-storage-holder-cccccccccccccccccccccccccccccccc',
      sha256: '39c92e2dafdcf22d5296f8f9c26896a7c9e3b6ff29dd40d6ec83bc41f07dd08b',
    },
    {
      role: 'identity-helper',
      args: ['probe-storage'],
      writable: null,
      name: 'reverie-boxed-identity-helper-cccccccccccccccccccccccccccccccc',
      sha256: 'd74c7b4a66c9961b6a4e0b78307182d01a614e9473e063c7100e061ae1ce4b37',
    },
  ])('preserves $role/$args', (v) => {
    const actual = dockerResourceHelperConfiguration(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      v.role as DockerContinuationTaskRole,
      v.name,
      v.args,
      v.writable ?? undefined,
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );
    expect(createHash('sha256').update(JSON.stringify(actual)).digest('hex')).toBe(v.sha256);
  });
});

describe('unexpected native execution preserves the original admission phase', () => {
  it.each(['created', 'create-issued'] as const)(
    'can close exact terminal helper from original %s task without inventing START',
    async (phase) => {
      const f = fixture();
      const task: DockerContinuationTask =
        phase === 'created'
          ? { ...f.task, phase }
          : {
              phase,
              role: f.task.role,
              name: f.task.name,
              imageId: f.task.imageId,
              configurationDigest: f.task.configurationDigest,
            };
      const proof = await f.reader.capture(key, task, f.current);
      expect(proof.require(key, task).taskDigest).toBe(dockerContinuationDigest(task));
      expect(proof.require(key, task).originalOutcome).toBe('unknown');
      expect(task.phase).toBe(phase);
    }
  );
  it('holds absent/ambiguous changed noCID terminal census', async () => {
    const f = fixture();
    f.setListing('');
    const task: DockerContinuationTask = {
      phase: 'create-issued',
      role: f.task.role,
      name: f.task.name,
      imageId: f.task.imageId,
      configurationDigest: f.task.configurationDigest,
    };
    await expect(f.reader.capture(key, task, f.current)).rejects.toThrow();
  });
});

describe('native metadata errors remain service outcomes', () => {
  it('maps malformed Engine state to original-writer unconfirmed rather than invalid HTTP input', async () => {
    const f = fixture();
    f.actual.State = null;
    await expect(f.reader.capture(key, f.task, f.current)).rejects.toMatchObject({
      code: 'DOCKER_RESOURCE_ORIGINAL_WRITER_UNCONFIRMED',
    });
  });
  it('preserves current-grant authorization errors across the native boundary', async () => {
    const f = fixture();
    const authorization = Object.assign(Error('Denied'), { code: 'FORBIDDEN', statusCode: 403 });
    await expect(
      f.reader.capture(key, f.task, () => {
        throw authorization;
      })
    ).rejects.toBe(authorization);
    expect(f.calls).toEqual([]);
  });
});

describe('read-only port encapsulation', () => {
  it('exposes no raw Engine command property from the supported reader', () => {
    const f = fixture();
    expect('command' in f.reader).toBe(false);
    expect(Object.keys(f.reader)).toEqual([]);
  });
});
