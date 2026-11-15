import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { DockerPlanSourceReader, DOCKER_PLAN_INIT_PROGRAM } from '../src/docker-plan-source.js';
import { DockerEmployeeBinding, DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { DockerEmployeeInspect, boxedOriginal } from '../src/docker-employee-engine-data.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
const hex = (c: string) => c.repeat(64),
  uuid = (n: number) => n.toString().padStart(8, '0') + '-0000-4000-8000-000000000001';
function fixture(running = true) {
  const box = hex('7'),
    image = 'sha256:' + hex('e'),
    subject = {
      employeeId: uuid(1),
      sessionId: uuid(2),
      sessionGeneration: 1,
      owner: undefined,
      sourceDigest: hex('b'),
      providerSourceDigest: hex('b'),
      onVacation: false,
      desiredRunning: true,
    };
  const raw = DockerEmployeeInspect.parse({
    Id: hex('a'),
    Image: image,
    State: {
      Running: running,
      Pid: running ? 100 : 0,
      Status: running ? 'running' : 'exited',
      Paused: false,
      Restarting: false,
      Dead: false,
      ExitCode: 0,
    },
    Config: {
      User: '1000:100',
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: null,
      Env: ['HOME=/home/agent', 'PATH=/bin'],
      Labels: {
        'reverie.boxed.instance': 'synthetic',
        'reverie.boxed.employee': uuid(1),
        'reverie.boxed.session': uuid(2),
        'reverie.boxed.box': box,
        'reverie.boxed.operation': uuid(3),
        'reverie.boxed.generation': '1',
        'org.reverie.worker-client.manifest': hex('b'),
      },
    },
    Mounts: [
      { Type: 'bind', Source: '/synthetic/home', Destination: '/home/agent', RW: true, Propagation: 'rprivate' },
    ],
    HostConfig: {
      Privileged: false,
      OomKillDisable: null,
      AutoRemove: false,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      Mounts: [],
    },
  });
  const destination = boxedOriginal(raw, subject, 'synthetic', true),
    poolPolicy = {
      memoryMaxBytes: 48 * 1024 ** 3,
      swapMaxBytes: 0,
      pidsMax: 8192,
      cpuWeight: 100,
      allowedCpus: [0, 1],
    };
  const row = DockerEmployeeContinuationRecord.parse({
    version: 2,
    purpose: 'docker-employee-continuation-v2',
    employeeId: uuid(1),
    request: {
      operationId: uuid(3),
      sessionId: uuid(2),
      sessionGeneration: 1,
      containerId: hex('c'),
      imageId: image,
      expectedPolicyDigest: hex('b'),
      expectedDestinationImageId: image,
      enterOffice: false,
    },
    sourceDigest: hex('b'),
    providerSourceDigest: hex('b'),
    original: { ...destination, containerId: hex('c') },
    workerImage: { imageId: image, sourceImageId: image, clientManifestDigest: hex('b') },
    policy: { ...poolPolicy, pidsMax: 512, memoryHighBytes: 24 * 1024 ** 3, pool: poolPolicy },
    credentialId: uuid(4),
    phase: 'ready',
    destination,
  });
  const binding = DockerEmployeeBinding.parse({
    version: 1,
    operationId: uuid(3),
    credentialId: uuid(4),
    sessionId: uuid(2),
    sessionGeneration: 1,
    containerId: raw.Id,
    imageId: image,
    originalDigest: digest(destination),
    policyDigest: digest(row.policy),
  });
  let ticks = '123',
    afterInit: undefined | (() => void);
  const view = vi.fn(async () => {
      throw Error('viewer absent');
    }),
    qualifyImage = vi.fn(async () => {});
  const command: DockerEngineCommand = {
    create: vi.fn(async () => {
      throw Error('CREATE forbidden');
    }),
    run: vi.fn(async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify([raw]);
      if (args.includes(DOCKER_PLAN_INIT_PROGRAM)) {
        const v = JSON.stringify({ startTicks: ticks });
        afterInit?.();
        return v;
      }
      if (args.includes('status'))
        return JSON.stringify({
          version: 1,
          purpose: 'reverie-worker-client-readback-v1',
          manifestDigest: hex('b'),
          entrySha256: hex('c'),
          filesChecked: 4,
          nodeMajor: 22,
          ownerUid: 0,
        });
      throw Error('unexpected command');
    }),
  };
  const reader = new DockerPlanSourceReader(command, 'synthetic', box, 'http://reverie:3000', view, qualifyImage);
  return {
    raw,
    row,
    binding,
    reader,
    command,
    view,
    qualifyImage,
    ticks: (value: string) => {
      ticks = value;
    },
    afterInit: (fn: () => void) => {
      afterInit = fn;
    },
  };
}
describe('native plan source observation independent of disposable viewer', () => {
  it('permits explicit force when actual bound init is healthy and viewer is absent', async () => {
    const f = fixture();
    const proof = await f.reader.capture(f.row, f.binding, () => {}, true);
    expect(proof.observation(f.row, f.binding)).toEqual({
      kind: 'running',
      init: { pid: 100, startTicks: '123' },
      provider: { kind: 'unobserved' },
    });
    expect(f.qualifyImage).toHaveBeenCalledOnce();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(f.command.run)
        .mock.calls.every(([a]) => ['exec', 'container'].includes(a[0]!) && a[1] !== 'start' && a[1] !== 'stop')
    ).toBe(true);
  });
  it('accepts a genuinely stopped CID for force without inventing a birth or viewer', async () => {
    const f = fixture(false),
      proof = await f.reader.capture(f.row, f.binding, () => {}, true);
    expect(proof.observation(f.row, f.binding)).toMatchObject({
      kind: 'stopped',
      terminalStateDigest: expect.any(String),
    });
    expect(f.view).not.toHaveBeenCalled();
    expect(vi.mocked(f.command.run).mock.calls.every(([a]) => a[0] === 'container' && a[1] === 'inspect')).toBe(true);
  });
  it.each([true, false])(
    'refuses cooperative move when source has no genuine busy/idle provider proof (running=%s)',
    async (running) => {
      const f = fixture(running);
      await expect(f.reader.capture(f.row, f.binding, () => {}, false)).rejects.toThrow();
    }
  );
  it.each([
    'CID',
    'operation',
    'generation',
    'image',
    'home',
    'restart',
    'manifest',
    'malformed',
    'init-change',
  ] as const)('refuses changed actual %s without effects', async (change) => {
    const f = fixture();
    if (change === 'CID') f.raw.Id = hex('0');
    if (change === 'operation') f.raw.Config.Labels!['reverie.boxed.operation'] = uuid(7);
    if (change === 'generation') f.raw.Config.Labels!['reverie.boxed.generation'] = '2';
    if (change === 'image') f.raw.Image = 'sha256:' + hex('0');
    if (change === 'home') f.raw.Mounts[0]!.Source = '/foreign';
    if (change === 'restart') f.raw.HostConfig.RestartPolicy = { Name: 'always' };
    if (change === 'manifest') f.raw.Config.Labels!['org.reverie.worker-client.manifest'] = hex('0');
    if (change === 'malformed') f.raw.State.Pid = 'unknown';
    if (change === 'init-change') f.afterInit(() => f.ticks('456'));
    await expect(f.reader.capture(f.row, f.binding, () => {}, true)).rejects.toThrow();
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('cannot downgrade a revocation during failed view capture to force authority', async () => {
    const f = fixture();
    let current = true;
    f.view.mockImplementation(async () => {
      current = false;
      throw Error('viewer absent');
    });
    await expect(
      f.reader.capture(
        f.row,
        f.binding,
        () => {
          if (!current) throw Error('revoked');
        },
        true
      )
    ).rejects.toThrow('revoked');
  });
  it('uses actual bound source image and revokes a retained proof when canonical scope changes', async () => {
    const f = fixture();
    let current = true;
    const proof = await f.reader.capture(
      f.row,
      f.binding,
      () => {
        if (!current) throw Error('changed');
      },
      true
    );
    current = false;
    expect(() => proof.require(f.row, f.binding)).toThrow('changed');
    current = true;
    expect(() => proof.require(f.row, f.binding)).toThrow();
  });
});
describe('fixed init read program', () => {
  function run(change?: string) {
    let reads = 0,
      output = '';
    const fs = {
      statfsSync: () => ({ type: change === 'proc' ? 0 : 0x9fa0 }),
      lstatSync: (path: string) => ({
        uid: 0,
        mode: path.endsWith('/node') ? 0o555 : 0o755,
        isDirectory: () => !path.endsWith('/node'),
        isFile: () => path.endsWith('/node'),
      }),
      readFileSync: (path: string) => {
        if (path.endsWith('/status'))
          return (
            'NoNewPrivs:\t' +
            (change === 'nnp' ? '0' : '1') +
            '\n' +
            ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']
              .map((k) => k + ':\t' + (change === 'caps' ? '1' : '0000000000000000'))
              .join('\n')
          );
        reads++;
        return (
          '1 (init) ' + ['S', ...Array<string>(18).fill('0'), change === 'birth' && reads > 1 ? '456' : '123'].join(' ')
        );
      },
    };
    vm.runInNewContext(DOCKER_PLAN_INIT_PROGRAM, {
      require: (name: string) => {
        if (name !== 'node:fs') throw Error('unexpected import');
        return fs;
      },
      process: {
        stdout: {
          write: (s: string) => {
            output += s;
          },
        },
      },
    });
    return output;
  }
  it('reads exact procfs init birth twice without writes, tmux or provider dispatch', () => {
    expect(run()).toBe('{"startTicks":"123"}\n');
  });
  it.each(['proc', 'nnp', 'caps', 'birth'])('refuses %s mismatch with no receipt', (change) => {
    expect(() => run(change)).toThrow();
  });
});
