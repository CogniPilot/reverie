/** Actual execFile child completion earns the private read-race receipt. The
 * Docker executable boundary is redirected to an inert real child; controller
 * decisions use the existing controlled native ports, never a daemon. */
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { physical } = vi.hoisted(() => ({ physical: { program: '', timeouts: [] as number[] } }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
    ) => {
      expect(file).toBe('/bin/docker');
      expect(args.slice(0, 2)).toEqual(['--host', 'unix:///run/reverie-engine/docker.sock']);
      physical.timeouts.push(Number(options.timeout));
      return actual.execFile(process.execPath, ['-e', physical.program], options, callback);
    },
  };
});
import { PackagedDockerEngineCommand, dockerResourceProbeReadRace } from '../src/docker-engine-command.js';
import { fixture, policy, helper, deployment } from './helpers/docker-resource-physical.js';
import { DockerContainedResources } from '../src/docker-contained-resource-controller.js';
const marker = 'BOXED_RESOURCE_IO: No such process (os error 3); effectIssued=false\n';
const anchor = 'a'.repeat(64),
  box = 'b'.repeat(64);
const argv = [
  'exec',
  anchor,
  '/bin/reverie-docker-resources',
  'probe-pool',
  '--box-id',
  box,
  '--anchor-id',
  anchor,
  '--anchor-pid',
  '100',
];
function child(stderr = marker, stdout = '', exit = 1) {
  physical.program = `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${exit};`;
}
async function actualRace(args: readonly string[] = argv, timeoutMs = 30000) {
  child();
  return new PackagedDockerEngineCommand().run(args, undefined, timeoutMs).catch((error: unknown) => error);
}
afterEach(() => {
  physical.timeouts.length = 0;
  vi.restoreAllMocks();
});
describe('complete actual subprocess read-race classification', () => {
  it('binds only the exact completed native ESRCH read argv and keeps output closed', async () => {
    const receipt = await actualRace();
    expect(dockerResourceProbeReadRace(receipt, argv)).toBe(true);
    expect(dockerResourceProbeReadRace(receipt, [...argv, '--member', 'c'.repeat(64) + ':2:3'])).toBe(false);
    expect(dockerResourceProbeReadRace({ code: 'ESRCH', effectIssued: false }, argv)).toBe(false);
    const fake = Object.create(Object.getPrototypeOf(receipt), { matches: { value: () => true } });
    expect(dockerResourceProbeReadRace(fake, argv)).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('BOXED_RESOURCE_IO');
  });
  it.each([
    [marker, '', 2],
    [marker.replace('false', 'true'), '', 1],
    [marker.replace('3', '2'), '', 1],
    [marker + 'extra\n', '', 1],
    [marker, 'partial', 1],
    ['unknown', '', 1],
  ])('refuses incomplete, foreign or ambiguous child result %s/%s/%s', async (stderr, stdout, exit) => {
    child(stderr, stdout, exit);
    const error = await new PackagedDockerEngineCommand().run(argv).catch((value: unknown) => value);
    expect(dockerResourceProbeReadRace(error, argv)).toBe(false);
  });
  it.each(['configure-pool', 'configure-high', 'configure-memory-high', 'restore-pool', 'anchor'])(
    'never classifies the write role %s as a read retry',
    async (role) => {
      const args = [...argv];
      args[3] = role;
      const error = await actualRace(args);
      expect(dockerResourceProbeReadRace(error, args)).toBe(false);
    }
  );
  it('does not classify timeout or a partial native line as a retryable read', async () => {
    physical.program = `process.stderr.write(${JSON.stringify(marker)});setInterval(()=>{},1000);`;
    const error = await new PackagedDockerEngineCommand().run(argv, undefined, 10).catch((value: unknown) => value);
    expect(dockerResourceProbeReadRace(error, argv)).toBe(false);
  });
  it('never classifies a command carrying stdin as a read retry', async () => {
    child();
    const error = await new PackagedDockerEngineCommand().run(argv, 'payload').catch((value: unknown) => value);
    expect(dockerResourceProbeReadRace(error, argv)).toBe(false);
  });
});
async function prepared() {
  const f = fixture();
  await f.controller.preparePool(f.row(), f.current);
  await f.setPool();
  f.makeWorker();
  await f.controller.configure(f.row(), f.current);
  const controller = new DockerContainedResources(f.command, f.journal, {
    boxId: box,
    deployment,
    helperImageId: helper,
    selectedWorkerContainerIds: () => ['d'.repeat(64)],
    retainedPoolConfigurationTasks: () => [],
  });
  return { ...f, controller };
}
describe('bounded whole resource probe retries', () => {
  it.each(['probe-pool', 'probe-worker'] as const)(
    'recollects fresh unchanged %s scope after two actual child ESRCH exits, without new effects',
    async (role) => {
      const f = await prepared(),
        before = { creates: [...f.creates], starts: [...f.starts], tasks: [...f.tasks] };
      let faults = 0;
      const run = f.command.run.bind(f.command);
      f.command.run = async (args, input, timeoutMs) => {
        if (args[0] === 'exec' && args.includes(role) && faults < 2) {
          faults++;
          const receipt = await actualRace(args, timeoutMs);
          throw receipt;
        }
        return run(args, input, timeoutMs);
      };
      expect(await f.controller.read(f.row())).toEqual(policy);
      expect(faults).toBe(2);
      expect({ creates: [...f.creates], starts: [...f.starts], tasks: [...f.tasks] }).toEqual(before);
      expect(physical.timeouts.every((value) => value > 0 && value <= 30000)).toBe(true);
      expect(physical.timeouts[1]).toBeLessThan(physical.timeouts[0]!);
    }
  );
  it('stops after three actual read failures and publishes no policy proof', async () => {
    const f = await prepared();
    let faults = 0;
    f.beforeRun(async (args) => {
      if (args[0] === 'exec' && args.includes('probe-pool')) {
        faults++;
        throw await actualRace(args);
      }
    });
    await expect(f.controller.read(f.row())).rejects.toThrow('PROCESS_EXITED');
    expect(faults).toBe(3);
    expect(() => f.controller.existingPolicy(f.row(), policy)).toThrow();
  });
  it('refuses changed anchor identity before a second native probe', async () => {
    const f = await prepared();
    let faults = 0;
    f.beforeRun(async (args) => {
      if (args[0] === 'exec' && args.includes('probe-pool')) {
        faults++;
        const receipt = await actualRace(args);
        const raw = f.containers.get(args[1]!)!;
        (raw.State as Record<string, unknown>).Pid = 999;
        throw receipt;
      }
    });
    await expect(f.controller.read(f.row())).rejects.toThrow();
    expect(faults).toBe(1);
  });
  it('refuses a changed member binding before retrying an otherwise identical probe', async () => {
    const f = await prepared();
    let faults = 0;
    f.beforeRun(async (args) => {
      if (args[0] === 'exec' && args.includes('probe-pool')) {
        faults++;
        const receipt = await actualRace(args);
        const raw = f.containers.get('d'.repeat(64))!;
        (raw.Config as { User: string }).User = '999:999';
        throw receipt;
      }
    });
    await expect(f.controller.read(f.row())).rejects.toThrow('OBSERVATION_CHANGED');
    expect(faults).toBe(1);
  });
  it('does not retry a lookalike error or exceed the original whole-probe deadline', async () => {
    for (const exhausted of [false, true]) {
      const f = await prepared();
      let faults = 0;
      const now = performance.now();
      f.beforeRun(async (args) => {
        if (args[0] === 'exec' && args.includes('probe-pool')) {
          faults++;
          if (!exhausted) throw Error(marker);
          const receipt = await actualRace(args);
          vi.spyOn(performance, 'now').mockReturnValue(now + 30001);
          throw receipt;
        }
      });
      await expect(f.controller.read(f.row())).rejects.toThrow();
      expect(faults).toBe(1);
      vi.restoreAllMocks();
    }
  });
  it('bounds an actual deferred inventory callback and dispatches no probe after late resolution', async () => {
    const f = await prepared();
    let entered!: () => void, release!: (ids: readonly string[]) => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inventory = new Promise<readonly string[]>((resolve) => {
      release = resolve;
    });
    const controller = new DockerContainedResources(f.command, f.journal, {
      boxId: box,
      deployment,
      helperImageId: helper,
      selectedWorkerContainerIds: () => {
        entered();
        return inventory;
      },
      retainedPoolConfigurationTasks: () => [],
    });
    let count = 0;
    f.beforeRun((args) => {
      if (args.includes('probe-pool') || args.includes('probe-worker')) count++;
    });
    vi.useFakeTimers();
    let outcome = 'pending';
    const pending = controller.read(f.row()).then(
      () => {
        outcome = 'resolved';
      },
      (error: Error) => {
        outcome = error.message;
      }
    );
    try {
      await seen;
      await vi.advanceTimersByTimeAsync(30001);
      expect(outcome).toBe('DOCKER_RESOURCE_PROBE_DEADLINE');
      expect(count).toBe(0);
      release(['d'.repeat(64)]);
      await vi.advanceTimersByTimeAsync(1);
      expect(count).toBe(0);
      expect(() => controller.existingPolicy(f.row(), policy)).toThrow();
    } finally {
      release(['d'.repeat(64)]);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      vi.useRealTimers();
    }
  });
});

describe('expired inventory admission has no detached rejection', () => {
  it('does not invoke a rejecting inventory callback when earlier native I/O consumed the budget', async () => {
    const f = await prepared();
    const inventory = vi.fn(() => Promise.reject(Error('late inventory must remain uninvoked')));
    const controller = new DockerContainedResources(f.command, f.journal, {
      boxId: box,
      deployment,
      helperImageId: helper,
      selectedWorkerContainerIds: inventory,
      retainedPoolConfigurationTasks: () => [],
    });
    const task = f.tasks.get('anchor')!;
    if (!('containerId' in task)) throw Error('Prepared anchor missing');
    const now = performance.now();
    let inspections = 0,
      probes = 0;
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    f.beforeRun((args) => {
      if (args[0] === 'container' && args[1] === 'inspect' && args[2] === task.containerId && ++inspections === 3)
        vi.spyOn(performance, 'now').mockReturnValue(now + 60000);
      if (args.includes('probe-pool') || args.includes('probe-worker')) probes++;
    });
    try {
      await expect(controller.read(f.row())).rejects.toThrow('PROBE_DEADLINE');
      expect(inspections).toBe(3);
      expect(inventory).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(probes).toBe(0);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
