/** Explicit real-Engine fixture. Requires qualified image IDs and an owned
 * evidence directory. All created containers use a fresh random Box; no company
 * mounts, credentials, providers, or existing containers are selected. */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DockerContainedResources } from '../../src/docker-contained-resource-controller.js';
import {
  allowedDockerTaskTransition,
  type DockerContinuationTask,
  type DockerContinuationTaskRole,
} from '../../src/docker-continuation-task.js';
import type { DockerEmployeeContinuationRecord } from '../../src/docker-employee-continuation-data.js';
import type { DockerEngineCommand } from '../../src/docker-engine-command.js';

const [helperImage, workerImage, evidence] = process.argv.slice(2);
if (
  !helperImage ||
  !workerImage ||
  !evidence ||
  !/^sha256:[a-f0-9]{64}$/.test(helperImage) ||
  !/^sha256:[a-f0-9]{64}$/.test(workerImage) ||
  !evidence.startsWith('/home/')
)
  throw Error('Qualified helper/worker IDs and owned durable evidence directory required');
await fs.mkdir(evidence, { mode: 0o700, recursive: false });
const boxId = randomBytes(32).toString('hex'),
  deployment = 'resource-canary-' + boxId.slice(0, 16);
const execute = promisify(execFile);
const events: unknown[] = [],
  owned: string[] = [];
const save = () =>
  fs.writeFile(
    join(evidence, 'events.json'),
    JSON.stringify({ boxId, deployment, helperImage, workerImage, owned, events }, null, 2) + '\n',
    { mode: 0o600 }
  );
await save();
const command: DockerEngineCommand = {
  async run(args) {
    return (await execute('docker', [...args], { timeout: 40000, maxBuffer: 1024 * 1024 })).stdout;
  },
  async create(name, configuration, current) {
    current();
    events.push({ type: 'create-issued', name, configuration });
    await save();
    current();
    const body = Buffer.from(JSON.stringify(configuration));
    const id = await new Promise<string>((resolve, reject) => {
      const call = request(
        {
          socketPath: '/var/run/docker.sock',
          method: 'POST',
          path: '/v1.45/containers/create?name=' + encodeURIComponent(name),
          headers: { 'content-type': 'application/json', 'content-length': body.length },
        },
        (response) => {
          let output = '';
          response.on('data', (chunk) => {
            output += String(chunk);
            if (output.length > 65536) call.destroy(Error('create reply bound'));
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const value = JSON.parse(output);
              if (response.statusCode !== 201 || !/^[a-f0-9]{64}$/.test(value.Id)) throw Error('create unconfirmed');
              resolve(value.Id);
            } catch (cause) {
              reject(cause);
            }
          });
        }
      );
      call.once('error', reject);
      call.setTimeout(30000, () => call.destroy(Error('create deadline')));
      call.end(body);
    });
    owned.push(id);
    events.push({ type: 'created', name, id });
    await save();
    return id;
  },
};
const tasks = new Map<DockerContinuationTaskRole, DockerContinuationTask>();
let row = {
  employeeId: '11111111-1111-4111-8111-111111111111',
  request: {
    operationId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    sessionGeneration: 1,
  },
  policy: {
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 512,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  },
  workerImage: { imageId: workerImage },
} as unknown as DockerEmployeeContinuationRecord;
const controller = new DockerContainedResources(
  command,
  {
    read: (_row, role) => tasks.get(role),
    async publish(_row, before, next, current) {
      current();
      assert(isDeepStrictEqual(tasks.get(next.role), before));
      assert(allowedDockerTaskTransition(before, next));
      tasks.set(next.role, structuredClone(next));
      events.push({ type: 'cursor', task: next });
      await save();
      return row;
    },
  },
  {
    boxId,
    deployment,
    helperImageId: helperImage,
    selectedWorkerContainerIds: () => (row.destination ? [row.destination.containerId] : []),
  }
);
let terminal = 1;
try {
  await controller.preparePool(row, () => {});
  const pool = await controller.observePool(row);
  assert(pool);
  row = { ...row, pool };
  const worker = await command.create(
    'reverie-boxed-fixture-' + boxId.slice(0, 24),
    {
      Image: workerImage,
      User: '1000:100',
      Entrypoint: ['/bin/tini', '-g', '-s', '--', '/bin/sleep'],
      Cmd: ['86400'],
      WorkingDir: '/',
      Env: [],
      Labels: {
        'reverie.boxed.instance': deployment,
        'reverie.boxed.employee': row.employeeId,
        'reverie.boxed.session': row.request.sessionId,
        'reverie.boxed.generation': '1',
        'reverie.boxed.operation': row.request.operationId,
      },
      HostConfig: {
        CgroupParent: pool.cgroupParent,
        Memory: row.policy.memoryMaxBytes,
        MemorySwap: row.policy.memoryMaxBytes,
        PidsLimit: 512,
        CpusetCpus: '0,1',
        CapDrop: ['ALL'],
        Privileged: false,
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        SecurityOpt: ['no-new-privileges:true'],
      },
    },
    () => {}
  );
  events.push({ type: 'fixture-worker-start-issued', id: worker });
  await save();
  await command.run(['container', 'start', worker]);
  row = { ...row, destination: { containerId: worker } } as DockerEmployeeContinuationRecord;
  assert.equal(await controller.read(row), null, 'inert worker must be observable before soft policy is configured');
  await controller.configure(row, () => {});
  assert.deepEqual(await controller.read(row), row.policy);
  await fs.writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        actualResourceController: true,
        boxId,
        pool,
        policy: row.policy,
        worker,
        tasks: [...tasks.values()],
        noCompanyData: true,
        noProvider: true,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  terminal = 0;
} catch (cause) {
  await fs.writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ message: (cause as Error).message, stack: (cause as Error).stack }, null, 2) + '\n',
    { mode: 0o600 }
  );
  throw cause;
} finally {
  for (const id of [...owned].reverse()) {
    try {
      await command.run(['container', 'stop', '--timeout', '3', id]);
      events.push({ type: 'fixture-stop', id });
    } catch {
      events.push({ type: 'fixture-stop-unconfirmed', id });
      terminal = 1;
    }
  }
  await save();
  await fs.writeFile(
    join(evidence, 'terminal.json'),
    JSON.stringify({ exit: terminal, retainedOwnedContainers: owned }) + '\n',
    { mode: 0o600 }
  );
  process.exitCode = terminal;
}
