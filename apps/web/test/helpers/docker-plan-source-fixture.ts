import { vi } from 'vitest';
import { DockerPlanSourceReader, DOCKER_PLAN_INIT_PROGRAM } from '../../src/docker-plan-source.js';
import {
  DockerEmployeeBinding,
  DockerEmployeeContinuationRecord,
} from '../../src/docker-employee-continuation-data.js';
import { DockerEmployeeInspect, boxedOriginal } from '../../src/docker-employee-engine-data.js';
import { dockerContinuationDigest as digest } from '../../src/docker-employee-continuation.js';
import type { DockerEngineCommand } from '../../src/docker-engine-command.js';
const hex = (c: string) => c.repeat(64),
  uuid = (n: number) => n.toString().padStart(8, '0') + '-0000-4000-8000-000000000001';
export function dockerPlanSourceFixture(running = true) {
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
      StartedAt: '2026-11-16T00:00:00.000000000Z',
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
        'reverie.boxed.source': hex('c'),
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
