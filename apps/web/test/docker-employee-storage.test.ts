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
    phase: 'ready',
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
  const existingDestination = DockerEmployeeInspect.parse({
    ...source,
    Id: dest,
    State: { ...source.State, Running: true },
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
    create: vi.fn(async (name, config, current) => {
      current();
      const host = config.HostConfig as Record<string, unknown>;
      raw = {
        Id: cid,
        Name: '/' + name,
        Image: image,
        Config: { User: config.User, Entrypoint: config.Entrypoint, Cmd: config.Cmd, Labels: config.Labels },
        HostConfig: structuredClone(host),
        Mounts: (host.Mounts as Array<{ Source: string; Target: string }>).map((m) => ({
          Type: 'bind',
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
    destination,
    existingDestination,
    exitHolder() {
      raw!.State = {
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        Status: 'exited',
        Pid: 0,
        FinishedAt: '2026-01-01T00:00:00.000000000Z',
      };
    },
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
    const verify = vi.fn();
    await expect(
      f.service.readExistingReference(f.row, f.existingDestination, verify, () => {})
    ).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
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

describe('existing destination storage across an original holder exit', () => {
  const current = () => {};
  it('rechecks both protected directories after the source stops', async () => {
    const f = fixture();
    await f.service.prepare(f.row, current);
    f.exitHolder();
    const stopped = { ...f.existingDestination, State: { ...f.existingDestination.State, Running: false, Pid: 0 } };
    const observed = structuredClone(f.destination);
    observed.home.dev = '18';
    observed.nix.dev = '19';
    const verify = vi.fn(async (_destination, seen) => ({
      ...seen,
      purpose: 'reverie-boxed-storage-reference-v1',
    }));
    vi.mocked(f.command.run).mockClear();
    await expect(f.service.readExistingReference(f.row, stopped, verify, current, observed)).resolves.toMatchObject({
      dev: '18', ino: observed.home.ino,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.command.run).mock.calls.some(([args]) => args.includes('probe-storage'))).toBe(false);
    verify.mockImplementationOnce(async (_destination, seen) => ({
      ...seen,
      purpose: 'reverie-boxed-storage-reference-v1',
      nix: { ...seen.nix, ino: '29' },
    }));
    await expect(f.service.readExistingReference(f.row, stopped, verify, current, observed)).rejects.toMatchObject({
      code: 'DOCKER_STORAGE_DESTINATION_REPLACED',
    });
  });
  it('can recheck a cold placement from the original holder header alone', async () => {
    const f = fixture();
    await f.service.prepare(f.row, current);
    f.exitHolder();
    const stopped = { ...f.existingDestination, State: { ...f.existingDestination.State, Running: false, Pid: 0 } };
    const readReference = () => ({ ...f.destination, purpose: 'reverie-boxed-storage-reference-v1' });
    const verify = vi.fn(async () => readReference());
    const recover = () => f.service.readExistingReference(f.row, stopped, verify, current, 'original-reference');
    vi.mocked(f.command.run).mockClear();
    await expect(recover()).resolves.toMatchObject({ ino: f.destination.home.ino, dev: f.destination.home.dev });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.command.run).mock.calls.some(([args]) => args.includes('probe-storage'))).toBe(false);
    f.destination.home.dev = '18';
    await expect(recover()).rejects.toMatchObject({ code: 'DOCKER_STORAGE_DESTINATION_REPLACED' });
  });
  it('keeps live holder reads on the original path', async () => {
    const f = fixture(),
      verify = vi.fn();
    await f.service.prepare(f.row, current);
    await expect(
      f.service.readExistingReference(f.row, f.existingDestination, verify, current)
    ).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts a fresh device number only with a matching native reference and no old task mutation', async () => {
    const f = fixture();
    await f.service.prepare(f.row, current);
    const task = structuredClone(f.task);
    f.exitHolder();
    f.destination.home.dev = '18';
    f.destination.nix.dev = '19';
    vi.mocked(f.command.run).mockClear();
    const verify = vi.fn(async (_source, observed) => ({
      ...observed,
      purpose: 'reverie-boxed-storage-reference-v1',
    }));
    await expect(f.service.readExistingReference(f.row, f.existingDestination, verify, current)).resolves.toEqual({
      source: '/fixture/home',
      user: '1000:100',
      dev: '18',
      ino: '5',
      originalHomeDev: '4',
    });
    expect(verify).toHaveBeenCalledWith(f.existingDestination, f.destination);
    expect(f.task).toEqual(task);
    expect(f.command.create).toHaveBeenCalledOnce();
    expect(vi.mocked(f.command.run).mock.calls.map(([args]) => args)).toEqual([
      ['container', 'inspect', cid],
      ['logs', cid],
      ['exec', dest, '/opt/reverie-worker-tools/reverie-docker-resources', 'probe-storage'],
      ['container', 'inspect', cid],
      ['logs', cid],
      ['exec', dest, '/opt/reverie-worker-tools/reverie-docker-resources', 'probe-storage'],
    ]);
  });

  it.each(['birth', 'duplicate log', 'inode', 'ownership', 'mode', 'bind'])(
    'refuses changed %s evidence before invoking the independent reference',
    async (changed) => {
      const f = fixture(),
        verify = vi.fn(),
        base = vi.mocked(f.command.run).getMockImplementation()!;
      await f.service.prepare(f.row, current);
      f.exitHolder();
      if (changed === 'birth') f.value.holderStartTicks = '456';
      if (changed === 'duplicate log')
        vi.mocked(f.command.run).mockImplementation(async (a, b) => {
          const out = await base(a, b);
          return a[0] === 'logs' ? out + out : out;
        });
      if (changed === 'inode') f.destination.nix.ino = '99';
      if (changed === 'ownership') f.destination.home.uid = 999;
      if (changed === 'mode') f.destination.home.mode = 16877;
      if (changed === 'bind') f.existingDestination.Mounts[0]!.Source = '/fixture/replacement';
      await expect(f.service.readExistingReference(f.row, f.existingDestination, verify, current)).rejects.toThrow();
      expect(verify).not.toHaveBeenCalled();
    }
  );

  it.each(['purpose', 'metadata', 'holder reappears', 'destination changes'])(
    'refuses %s across the independent reference',
    async (changed) => {
      const f = fixture();
      await f.service.prepare(f.row, current);
      f.exitHolder();
      const verify = vi.fn(async (_source, observed) => {
        if (changed === 'purpose') return observed;
        if (changed === 'holder reappears') f.raw!.State = { Running: true, Status: 'running', Pid: 988 };
        if (changed === 'destination changes') f.destination.home.dev = '20';
        return {
          ...observed,
          ...(changed === 'metadata' ? { nix: { ...observed.nix, dev: '99' } } : {}),
          purpose: 'reverie-boxed-storage-reference-v1',
        };
      });
      await expect(f.service.readExistingReference(f.row, f.existingDestination, verify, current)).rejects.toThrow();
      expect(verify).toHaveBeenCalledOnce();
    }
  );
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
