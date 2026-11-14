import { describe, it, expect, vi } from 'vitest';
import { DockerEmployeeStorage } from '../src/docker-employee-storage.js';
import {
  allowedDockerTaskTransition,
  type DockerContinuationTask,
  type DockerContinuationTaskJournal,
} from '../src/docker-continuation-task.js';
import type { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import { DockerEmployeeInspect } from '../src/docker-employee-engine-data.js';
const cid = 'a'.repeat(64),
  dest = 'b'.repeat(64),
  image = 'sha256:' + 'f'.repeat(64),
  oid = '10000000-0000-4000-8000-000000000001';
function fixture(boxId = '7'.repeat(64)) {
  let task: DockerContinuationTask | undefined, raw: Record<string, unknown> | undefined;
  const row = {
    employeeId: oid,
    request: { operationId: oid },
    destination: { containerId: dest },
  } as DockerEmployeeContinuationRecord;
  const value = {
    version: 1,
    purpose: 'reverie-boxed-storage-observation-v1',
    holderStartTicks: '123',
    home: { dev: '4', ino: '5', uid: 1000, gid: 100, mode: 16832 },
    nix: { dev: '4', ino: '6', uid: 1000, gid: 100, mode: 16832 },
  };
  const destination = structuredClone({ ...value, holderStartTicks: null as string | null });
  const source = DockerEmployeeInspect.parse({
    Id: 'c'.repeat(64),
    Image: 'sha256:' + 'd'.repeat(64),
    State: { Running: false, Paused: false, Restarting: false, Dead: false },
    Config: { User: '1000:100', Entrypoint: null, Cmd: null, Env: ['HOME=/home/agent'], Labels: {} },
    HostConfig: { Privileged: false },
    Mounts: [
      { Type: 'bind', Source: '/fixture/home', Destination: '/home/agent', RW: true },
      { Type: 'bind', Source: '/fixture/nix', Destination: '/nix', RW: true },
    ],
  });
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
      const host = config.HostConfig as Record<string, unknown>;
      raw = {
        Id: cid,
        Image: image,
        Config: { User: config.User, Entrypoint: config.Entrypoint, Cmd: config.Cmd, Labels: config.Labels },
        HostConfig: structuredClone(host),
        Mounts: (host.Mounts as Array<{ Source: string; Target: string }>).map((m) => ({
          Source: m.Source,
          Destination: m.Target,
          RW: false,
        })),
        State: { Running: false, Status: 'created', Pid: 0 },
      };
      return cid;
    }),
    run: vi.fn(async (args) => {
      if (args[0] === 'container' && args[1] === 'ls') return raw ? cid : '';
      if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify([raw]);
      if (args[0] === 'container' && args[1] === 'start') {
        raw!.State = { Running: true, Status: 'running', Pid: 987 };
        return cid;
      }
      if (args[0] === 'logs') return JSON.stringify(value) + '\n';
      if (args[0] === 'exec') return JSON.stringify(args[1] === dest ? destination : value);
      throw Error('Unexpected command');
    }),
  };
  const service = new DockerEmployeeStorage(command, journal, image, async () => source, boxId);
  return {
    service,
    row,
    command,
    get task() {
      return task;
    },
    get raw() {
      return raw;
    },
    value,
    replaceDestination() {
      destination.home.ino = '99';
    },
    dropTask() {
      task = undefined;
    },
  };
}
describe('actual original read-only storage holder cursor', () => {
  it('records helper create before start, holds exact original metadata and compares destination', async () => {
    const f = fixture();
    await f.service.prepare(f.row, () => {});
    expect(f.task).toMatchObject({ phase: 'running', containerId: cid, initPid: 987, initStartTicks: '123' });
    await expect(f.service.observe(f.row)).resolves.toBe('ready');
    await f.service.verifyDestination(f.row);
    expect(f.command.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(1);
  });
  it('Observe before ownership emits no create/start or journal mutation', async () => {
    const f = fixture();
    expect(await f.service.observe(f.row)).toBe('unissued');
    expect(f.task).toBeUndefined();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.command.run).not.toHaveBeenCalled();
  });
  it('lost start reply joins original running holder without retransmission', async () => {
    const f = fixture(),
      base = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (a, b) => {
      const out = await base(a, b);
      if (a[1] === 'start') throw Error('lost reply');
      return out;
    });
    await expect(f.service.prepare(f.row, () => {})).rejects.toThrow('lost reply');
    expect(f.task?.phase).toBe('start-issued');
    expect(await f.service.observe(f.row)).toBe('ready');
    await f.service.prepare(f.row, () => {});
    expect(f.task?.phase).toBe('running');
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(1);
  });
  it('lost create with no actual original stays held and never creates another holder', async () => {
    const f = fixture();
    vi.mocked(f.command.create).mockRejectedValue(Error('unknown create'));
    await expect(f.service.prepare(f.row, () => {})).rejects.toThrow();
    expect(f.task?.phase).toBe('create-issued');
    expect(await f.service.observe(f.row)).toBe('unknown');
    await expect(f.service.prepare(f.row, () => {})).rejects.toThrow();
    expect(f.command.create).toHaveBeenCalledOnce();
  });
  it('same named destination with replaced inode cannot replace the retained original directory', async () => {
    const f = fixture();
    await f.service.prepare(f.row, () => {});
    f.replaceDestination();
    await expect(f.service.verifyDestination(f.row)).rejects.toMatchObject({
      code: 'DOCKER_STORAGE_DESTINATION_REPLACED',
    });
    expect(await f.service.observe(f.row)).toBe('ready');
    expect(f.command.create).toHaveBeenCalledOnce();
  });
  it('restarted holder PID cannot reuse original FD custody', async () => {
    const f = fixture();
    await f.service.prepare(f.row, () => {});
    (f.raw!.State as { Pid: number }).Pid = 988;
    await expect(f.service.observe(f.row)).rejects.toMatchObject({ code: 'DOCKER_STORAGE_HOLDER_REPLACED' });
  });
  it('actual holder security drift cannot be excused by matching directory DTOs', async () => {
    const f = fixture();
    await f.service.prepare(f.row, () => {});
    (f.raw!.HostConfig as Record<string, unknown>).CapAdd = ['SYS_ADMIN'];
    await expect(f.service.observe(f.row)).rejects.toThrow();
  });
  it('malformed/partial original header never yields storage readiness', async () => {
    const f = fixture(),
      base = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation((a, b) => (a[0] === 'logs' ? Promise.resolve('{') : base(a, b)));
    await expect(f.service.prepare(f.row, () => {})).rejects.toThrow();
    expect(f.task?.phase).toBe('start-issued');
    await expect(f.service.observe(f.row)).rejects.toThrow();
    expect(f.command.create).toHaveBeenCalledOnce();
  });
});

describe('read-only recovery of a fragmented CREATE reply', () => {
  it('finds the actual same never-started holder without retransmission, then a fresh effect starts it once', async () => {
    const f = fixture(),
      create = vi.mocked(f.command.create).getMockImplementation()!;
    vi.mocked(f.command.create).mockImplementationOnce(async (...args) => {
      await create(...args);
      throw Error('lost original create reply');
    });
    await expect(f.service.prepare(f.row, () => {})).rejects.toThrow('lost original');
    expect(f.task?.phase).toBe('create-issued');
    expect(await f.service.observe(f.row)).toBe('unissued');
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(0);
    await f.service.prepare(f.row, () => {});
    expect(f.task?.phase).toBe('running');
    expect(f.command.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.command.run).mock.calls.filter(([a]) => a[1] === 'start')).toHaveLength(1);
  });
});

it('private Box identity scopes the held storage name independently of client operation UUID', async () => {
  const a = fixture('7'.repeat(64)),
    b = fixture('8'.repeat(64));
  await a.service.prepare(a.row, () => {});
  await b.service.prepare(b.row, () => {});
  expect(vi.mocked(a.command.create).mock.calls[0]![0]).not.toBe(vi.mocked(b.command.create).mock.calls[0]![0]);
});
