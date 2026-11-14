import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DockerEmployeeCredentialInstaller } from '../src/docker-employee-credential-installer.js';
import {
  allowedDockerTaskTransition,
  type DockerContinuationTask,
  type DockerContinuationTaskJournal,
} from '../src/docker-continuation-task.js';
import type { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
const oid = '10000000-0000-4000-8000-000000000001',
  sid = '20000000-0000-4000-8000-000000000002',
  cid = 'a'.repeat(64),
  image = 'sha256:' + 'b'.repeat(64),
  digest = 'c'.repeat(64),
  token = 'synthetic.bound.credential',
  hash = createHash('sha256').update(token).digest('hex');
const imageEnvironment = ['PATH=/opt/reverie-worker-client/bin:/bin', 'HOME=/base', 'REVERIE_CONTAINER=1'];
function fixture() {
  let task: DockerContinuationTask | undefined, raw: Record<string, unknown> | undefined;
  const home = { source: '/synthetic/home', user: '1000:100', dev: '11', ino: '12' },
    row = {
      employeeId: oid,
      request: { operationId: oid, sessionId: sid },
      workerImage: { imageId: image, clientManifestDigest: digest },
    } as DockerEmployeeContinuationRecord;
  const ack = {
    version: 1,
    purpose: 'reverie-worker-credential-installed-v1',
    manifestDigest: digest,
    sessionId: sid,
    tokenDigest: hash,
    homeDev: '11',
    homeIno: '12',
  };
  const journal: DockerContinuationTaskJournal = {
    read: () => task,
    publish: async (_row, before, next, current) => {
      current();
      expect(task).toEqual(before);
      expect(allowedDockerTaskTransition(before, next)).toBe(true);
      task = structuredClone(next);
      return row;
    },
  };
  const command: DockerEngineCommand = {
    create: vi.fn(async (_name, config, current) => {
      current();
      const h = config.HostConfig as Record<string, unknown>;
      const supplied = config.Env as string[],
        keys = new Set(supplied.map((v) => v.split('=')[0]));
      const environment = [
        ...imageEnvironment.map((v) => supplied.find((s) => s.split('=')[0] === v.split('=')[0]) ?? v),
        ...supplied.filter((v) => !imageEnvironment.some((s) => s.split('=')[0] === v.split('=')[0])),
      ];
      expect(keys.size).toBe(supplied.length);
      raw = {
        Id: cid,
        Image: image,
        Config: {
          ...structuredClone(Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'HostConfig'))),
          Env: environment,
        },
        HostConfig: structuredClone(h),
        Mounts: [{ Type: 'bind', Source: home.source, Destination: '/home/agent', RW: true }],
        State: { Status: 'created', Running: false, ExitCode: 0, OOMKilled: false, Dead: false, Restarting: false },
      };
      return cid;
    }),
    run: vi.fn(async (args, input) => {
      if (args[0] === 'image') return JSON.stringify([{ Id: image, Config: { Env: imageEnvironment, Volumes: null } }]);
      if (args[0] === 'container' && args[1] === 'ls') return raw ? cid : '';
      if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify([raw]);
      if (args[0] === 'container' && args[1] === 'start') {
        expect(task?.phase).toBe('start-issued');
        expect(input).toBe(token);
        expect(args.join(' ')).not.toContain(token);
        raw!.State = {
          Status: 'exited',
          Running: false,
          ExitCode: 0,
          OOMKilled: false,
          Dead: false,
          Restarting: false,
        };
        return JSON.stringify(ack);
      }
      if (args[0] === 'logs') return JSON.stringify(ack) + '\n';
      throw Error('Unexpected command');
    }),
  };
  const installer = new DockerEmployeeCredentialInstaller(command, journal, async () => ({ ...home }));
  return {
    installer,
    row,
    command,
    home,
    ack,
    get task() {
      return task;
    },
    get raw() {
      return raw;
    },
  };
}
describe('original contained credential installer', () => {
  it('records originalCID and START before stdin, then requires actual successful ACK and records completion', async () => {
    const f = fixture();
    await f.installer.provision(f.row, token, () => {});
    expect(f.task).toMatchObject({ phase: 'completed', containerId: cid });
    expect(await f.installer.observe(f.row)).toBe(hash);
    expect(f.command.create).toHaveBeenCalledOnce();
    const config = vi.mocked(f.command.create).mock.calls[0]![1];
    expect(config).toMatchObject({
      Image: image,
      User: '1000:100',
      HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], NetworkMode: 'none' },
    });
    expect(JSON.stringify(config)).not.toContain(token);
  });
  it('Observe before original issuance cannot create/start/write anything', async () => {
    const f = fixture();
    expect(await f.installer.observe(f.row)).toBeNull();
    expect(f.command.run).not.toHaveBeenCalled();
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('unknown START reply is recovered only from same actual helper Exit0/logACK, never retransmitted', async () => {
    const f = fixture(),
      native = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (a, b) => {
      const result = await native(a, b);
      if (a[1] === 'start') throw Error('lost reply');
      return result;
    });
    await expect(f.installer.provision(f.row, token, () => {})).rejects.toThrow('lost reply');
    expect(await f.installer.observe(f.row)).toBe(hash);
    await expect(f.installer.provision(f.row, token, () => {})).rejects.toThrow();
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(1);
  });
  it('real failed consuming close remains Held despite matching token/ACK bytes', async () => {
    const f = fixture();
    await f.installer.provision(f.row, token, () => {});
    (f.raw!.State as { ExitCode: number }).ExitCode = 1;
    await expect(f.installer.observe(f.row)).rejects.toMatchObject({ code: 'DOCKER_IDENTITY_INSTALL_UNACKNOWLEDGED' });
    await expect(f.installer.provision(f.row, token, () => {})).rejects.toThrow();
    expect(f.command.create).toHaveBeenCalledOnce();
  });
  it('changed physical HOME prevents any helper START', async () => {
    const f = fixture(),
      native = vi.mocked(f.command.create).getMockImplementation()!;
    vi.mocked(f.command.create).mockImplementation(async (...args) => {
      const id = await native(...args);
      f.home.ino = '99';
      return id;
    });
    await expect(f.installer.provision(f.row, token, () => {})).rejects.toMatchObject({
      code: 'DOCKER_IDENTITY_ORIGINAL_HOME_CHANGED',
    });
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(0);
  });
  it('malformed/partial ACK refuses and cannot become success from a file digest', async () => {
    const f = fixture(),
      native = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation((a, b) => (a[0] === 'logs' ? Promise.resolve('{') : native(a, b)));
    await expect(f.installer.provision(f.row, token, () => {})).rejects.toThrow();
    expect(f.task?.phase).toBe('start-issued');
    await expect(f.installer.observe(f.row)).rejects.toThrow();
  });
  it('unknown CREATE without actual original never allocates a second helper', async () => {
    const f = fixture();
    vi.mocked(f.command.create).mockRejectedValue(Error('unknown create'));
    await expect(f.installer.provision(f.row, token, () => {})).rejects.toThrow();
    expect(await f.installer.observe(f.row)).toBeNull();
    await expect(f.installer.provision(f.row, token, () => {})).rejects.toThrow();
    expect(f.command.create).toHaveBeenCalledOnce();
  });
});
