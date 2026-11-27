import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OFFICE_SELF_RESTART_LIMITS,
  OfficeSelfRestart,
  OfficeSelfRestartRecord,
  ownContainerId,
  ownRestartPolicy,
  type OfficeSelfRestartDeps,
} from '../src/office-self-restart.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** An office whose laptop runtime stopped being current at the start, in a container Docker would start again. */
function office(record: number[] = []) {
  const state = {
    now: 100 * HOUR,
    started: true,
    stale: true,
    stamp: 'changed-once',
    startable: true,
    allowed: true,
    policy: 'unless-stopped' as string | null | Error,
    record,
    saveFails: false,
    /** What the office is in the middle of, or that this cannot be told. */
    operation: undefined as string | Error | undefined,
    /** What happens while the Engine is being asked. */
    duringPolicy: undefined as (() => void) | undefined,
    exits: 0,
    logs: [] as string[],
    audits: [] as Array<{ action: string; detail: Record<string, unknown> }>,
  };
  const deps: OfficeSelfRestartDeps = {
    now: () => state.now,
    started: () => state.started,
    stale: () => state.stale,
    stamp: () => state.stamp,
    startable: () => state.startable,
    allowed: () => state.allowed,
    restartPolicy: async () => {
      state.duringPolicy?.();
      if (state.policy instanceof Error) throw state.policy;
      return state.policy;
    },
    operation: async () => {
      if (state.operation instanceof Error) throw state.operation;
      return state.operation;
    },
    load: () => state.record,
    save: (times) => {
      if (state.saveFails) throw new Error('disk full');
      state.record = [...times];
    },
    exit: () => void state.exits++,
    log: (line) => void state.logs.push(line),
    audit: (entry) => void state.audits.push(entry),
  };
  const restart = new OfficeSelfRestart(deps);
  /** Look every 30 s for `minutes`, as the office timer does. */
  const run = async (minutes: number) => {
    for (let elapsed = 0; elapsed < minutes * MINUTE; elapsed += 30_000) {
      state.now += 30_000;
      await restart.tick();
    }
  };
  return { state, restart, run, again: () => new OfficeSelfRestart(deps) };
}

describe('the office restarting itself after its laptop configuration changed', () => {
  it('does nothing while the runtime is current, and nothing before the office has started', async () => {
    const o = office();
    o.state.stale = false;
    await o.run(60);
    expect(o.restart.status()).toBeUndefined();
    o.state.stale = true;
    o.state.started = false;
    await o.run(60);
    expect([o.state.exits, o.state.logs, o.restart.status()]).toEqual([0, [], undefined]);
  });

  it('waits ten minutes for the change to settle, says when, and then ends the process once', async () => {
    const o = office();
    await o.run(9.5);
    expect(o.state.exits).toBe(0);
    expect(o.restart.status()).toBe(
      'the office to restart itself at 1970-01-05 04:10 UTC and read its configuration again'
    );
    await o.run(1);
    expect(o.state.exits).toBe(1);
    // The record is written before the exit, and the step is in the audit trail.
    expect(o.state.record).toEqual([100 * HOUR + 10.5 * MINUTE]);
    expect(o.state.audits).toEqual([
      {
        admin: 'office supervisor',
        action: 'supervisor_restart_office',
        target: 'office',
        detail: {
          reason: 'DOCKER_CONTINUATION_RUNTIME_CHANGED',
          restartPolicy: 'unless-stopped',
          since: 100 * HOUR + 30_000,
          at: 100 * HOUR + 10.5 * MINUTE,
        },
      },
    ]);
    // A shutdown that takes a while is not asked for twice.
    await o.run(30);
    expect(o.state.exits).toBe(1);
    expect(o.restart.status()).toMatch(/restarting now/);
    expect(OFFICE_SELF_RESTART_LIMITS).toEqual({ settleMs: 10 * MINUTE, perDay: 2, spacingMs: HOUR });
  });

  it('starts the wait over whenever what changed changes again', async () => {
    const o = office();
    await o.run(9);
    o.state.stamp = 'changed-twice';
    await o.run(9.5);
    expect(o.state.exits).toBe(0);
    await o.run(1);
    expect(o.state.exits).toBe(1);
  });

  it.each([
    [
      'automatic repairs are switched off',
      (s: ReturnType<typeof office>['state']) => (s.allowed = false),
      /supervisorAutoRepair/,
    ],
    [
      'what is on disk would not be accepted at start',
      (s: ReturnType<typeof office>['state']) => (s.startable = false),
      /would be\s+refused/,
    ],
    [
      'the container has no restart policy',
      (s: ReturnType<typeof office>['state']) => (s.policy = 'no'),
      /restart policy “no”/,
    ],
    [
      'the container is only restarted after a failure',
      (s: ReturnType<typeof office>['state']) => (s.policy = 'on-failure'),
      /restart policy “on-failure”/,
    ],
    [
      'the restart policy cannot be read',
      (s: ReturnType<typeof office>['state']) => (s.policy = null),
      /restart policy unreadable/,
    ],
    [
      'the Engine cannot be asked',
      (s: ReturnType<typeof office>['state']) => (s.policy = new Error('socket')),
      /could not finish/,
    ],
    [
      'the record of the restart cannot be written',
      (s: ReturnType<typeof office>['state']) => (s.saveFails = true),
      /could not finish/,
    ],
  ])('never ends the process when %s, and says so', async (_title, change, status) => {
    const o = office();
    change(o.state);
    await o.run(120);
    expect(o.state.exits).toBe(0);
    expect(o.state.audits).toEqual([]);
    expect(o.restart.status()).toMatch(status);
    // Said once, not on every look.
    expect(o.state.logs.filter((line) => status.test(line))).toHaveLength(1);
  });

  it('reads the fault once more after asking the Engine, and ends nothing for one that is gone or still moving', async () => {
    const gone = office();
    gone.state.duringPolicy = () => (gone.state.stale = false);
    await gone.run(30);
    expect(gone.state.exits).toBe(0);
    expect(gone.restart.status()).toBeUndefined();
    const moving = office();
    let moved = 0;
    moving.state.duringPolicy = () => (moving.state.stamp = 'changed-' + ++moved);
    await moving.run(60);
    expect(moving.state.exits).toBe(0);
  });

  it('is not repeated within an hour, by the record a new process reads', async () => {
    const before = office();
    await before.run(11);
    expect(before.state.exits).toBe(1);
    // The new process finds the same fault: the restart did not settle it.
    const o = office(before.state.record);
    o.state.now = before.state.now + 2 * MINUTE;
    await o.run(50);
    expect(o.state.exits).toBe(0);
    expect(o.restart.status()).toBe(
      'the office to restart itself: it already did and that did not settle it, so the next restart is at 1970-01-05 05:10 UTC'
    );
    await o.run(10);
    expect(o.state.exits).toBe(1);
    expect(o.state.record).toHaveLength(2);
  });

  it('is done at most twice in a day, and then again the day after', async () => {
    const start = 100 * HOUR;
    const o = office([start - 5 * HOUR, start - 3 * HOUR]);
    await o.run(18 * 60);
    expect(o.state.exits).toBe(0);
    expect(o.restart.status()).toMatch(/the next restart is at 1970-01-05 23:00 UTC$/);
    await o.run(61);
    expect(o.state.exits).toBe(1);
    expect(o.state.record).toEqual([start - 3 * HOUR, expect.any(Number)]);
  });

  it('says when the runtime is current again', async () => {
    const o = office();
    o.state.allowed = false;
    await o.run(1);
    o.state.stale = false;
    await o.run(1);
    expect(o.restart.status()).toBeUndefined();
    expect(o.state.logs.at(-1)).toMatch(/is current again/);
  });
});

describe('the record of the office’s own restarts', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'office-restart-')), 'office-self-restart.json');

  it('reads back what it wrote, and reads nothing from a file that is not there', () => {
    const path = file();
    const record = new OfficeSelfRestartRecord(path, () => 9000);
    expect(record.load()).toEqual([]);
    record.save([1000, 2000]);
    expect(record.load()).toEqual([1000, 2000]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      purpose: 'office-self-restart-v1',
      restarts: [1000, 2000],
    });
  });

  it('counts a record it cannot read as a restart made now, so that damage slows the office and never lets it loop', () => {
    const path = file();
    for (const body of [
      '',
      '{',
      '{"version":1}',
      JSON.stringify({ version: 1, purpose: 'office-self-restart-v1', restarts: ['x'] }),
    ]) {
      writeFileSync(path, body);
      expect(new OfficeSelfRestartRecord(path, () => 9000).load()).toEqual([9000]);
    }
  });
});

describe('reading the restart policy of the office’s own container', () => {
  const ID = 'c'.repeat(64);
  const MOUNTS = [
    '1157 1023 0:112 / / rw,relatime master:412 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC',
    `1171 1157 259:2 /var/lib/docker/containers/${ID}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/nvme0n1p2 rw`,
    `1172 1157 259:2 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/nvme0n1p2 rw`,
    `1173 1157 259:2 /var/lib/docker/containers/${ID}/hosts /etc/hosts rw,relatime - ext4 /dev/nvme0n1p2 rw`,
    '1180 1157 259:2 /home/owner/data /data rw,relatime - ext4 /dev/nvme0n1p2 rw',
  ].join('\n');
  const engine = (answers: Record<string, string | Error>) => {
    const asked: string[] = [];
    return {
      asked,
      run: async (args: readonly string[]) => {
        expect(args.slice(0, 4)).toEqual([
          'container',
          'inspect',
          '--format',
          '{{.Config.Hostname}}|{{.HostConfig.RestartPolicy.Name}}',
        ]);
        asked.push(args[4]!);
        const answer = answers[args[4]!] ?? new Error('No such container');
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  };

  it('finds the container by the id in its mount table, where its host name is no longer that id', async () => {
    expect(ownContainerId(MOUNTS)).toBe(ID);
    const e = engine({ [ID]: 'office-host|unless-stopped\n' });
    expect(await ownRestartPolicy(e.run, 'office-host', MOUNTS)).toBe('unless-stopped');
    expect(e.asked).toEqual([ID]);
  });

  it('falls back to the host name, and reads an empty policy as none', async () => {
    const e = engine({ abcdef012345: 'abcdef012345|\n' });
    expect(await ownRestartPolicy(e.run, 'abcdef012345', '')).toBe('no');
    expect(e.asked).toEqual(['abcdef012345']);
  });

  it('knows nothing when the mount table names two containers, the Engine names another host, or nothing answers', async () => {
    const other =
      MOUNTS + `\n1190 1157 259:2 /var/lib/docker/containers/${'d'.repeat(64)}/hosts /x rw - ext4 /dev/x rw`;
    expect(ownContainerId(other)).toBeUndefined();
    expect(ownContainerId('')).toBeUndefined();
    expect(await ownRestartPolicy(engine({ [ID]: 'another-host|always\n' }).run, 'office-host', MOUNTS)).toBeNull();
    expect(await ownRestartPolicy(engine({}).run, 'office-host', MOUNTS)).toBeNull();
    expect(await ownRestartPolicy(engine({ [ID]: 'office-host|always\nextra' }).run, 'office-host', MOUNTS)).toBeNull();
    expect(await ownRestartPolicy(engine({}).run, 'not a name', '')).toBeNull();
  });
});

describe('the office restarting itself because it reads none of its laptops', () => {
  const REASON = 'the office reads none of its laptops although they should be running';
  /** The laptop runtime is current; the supervisor asks on every look, as it does on every pass. */
  const asking = (record: number[] = []) => {
    const o = office(record);
    o.state.stale = false;
    const run = async (minutes: number, ask = true) => {
      for (let elapsed = 0; elapsed < minutes * MINUTE; elapsed += 30_000) {
        o.state.now += 30_000;
        if (ask) o.restart.request(REASON);
        await o.restart.tick();
      }
    };
    return { ...o, run };
  };

  it('does so ten minutes after it was first asked, under every condition of any other restart', async () => {
    const o = asking();
    await o.run(9.5);
    expect(o.state.exits).toBe(0);
    expect(o.restart.status()).toMatch(/^the office to restart itself at .* UTC: the office reads none of its laptops/);
    await o.run(1);
    expect(o.state.exits).toBe(1);
    expect(o.state.audits[0]).toMatchObject({ action: 'supervisor_restart_office', detail: { reason: REASON } });
    expect(o.state.record).toHaveLength(1);
  });

  it('lets a request lapse that is not repeated', async () => {
    const o = asking();
    await o.run(5);
    await o.run(30, false);
    expect(o.state.exits).toBe(0);
    expect(o.restart.status()).toBeUndefined();
  });

  it('says when this office never restarts itself, so that the supervisor does not wait for it', async () => {
    const off = asking();
    off.state.allowed = false;
    await off.run(1);
    expect(off.restart.request(REASON)).toBe('refused');
    const fixed = asking();
    fixed.state.policy = 'no';
    expect(fixed.restart.request(REASON)).toBe('pending');
    await fixed.run(12);
    expect(fixed.state.exits).toBe(0);
    expect(fixed.restart.request(REASON)).toBe('refused');
  });

  it('keeps the limits of any restart, and says when it last restarted', async () => {
    const start = 100 * HOUR;
    const o = asking([start - 20 * MINUTE]);
    expect(o.restart.lastAt()).toBe(start - 20 * MINUTE);
    expect(o.restart.request(REASON)).toBe('pending');
    await o.run(39);
    expect(o.state.exits).toBe(0);
    await o.run(2);
    expect(o.state.exits).toBe(1);
    expect(asking().restart.lastAt()).toBeUndefined();
  });
});

describe('the office never ending its process beside an operation of its own', () => {
  it('waits for a plan move or a laptop operation to end, whatever asked for the restart, and says so', async () => {
    for (const stale of [true, false]) {
      const o = office();
      o.state.stale = stale;
      o.state.operation = 'a plan move that is open';
      const run = async (minutes: number) => {
        for (let elapsed = 0; elapsed < minutes * MINUTE; elapsed += 30_000) {
          o.state.now += 30_000;
          if (!stale) o.restart.request('the office reads none of its laptops');
          await o.restart.tick();
        }
      };
      await run(3 * 60);
      expect([stale, o.state.exits]).toEqual([stale, 0]);
      expect(o.restart.status()).toBe('the office to restart itself once a plan move that is open has ended');
      expect(o.state.record).toEqual([]);
      o.state.operation = undefined;
      await run(1);
      expect([stale, o.state.exits]).toEqual([stale, 1]);
    }
  });

  it('does not end it when it cannot tell whether an operation is running', async () => {
    const o = office();
    o.state.operation = new Error('the list of moves could not be read');
    await o.run(60);
    expect(o.state.exits).toBe(0);
    expect(o.restart.status()).toMatch(/once an operation it could not rule out has ended$/);
  });
});

describe('when the office may restart itself next', () => {
  it('says when its limits next allow a restart, and nothing while one may run now', () => {
    expect(office().restart.nextAllowedAt()).toBeUndefined();
    // An hour apart: one twenty minutes ago allows the next forty minutes from now.
    const spaced = office([100 * HOUR - 20 * MINUTE]);
    expect(spaced.restart.nextAllowedAt()).toBe(100 * HOUR + 40 * MINUTE);
    // Two a day: after two today, the next is a day after the first of them.
    const twice = office([100 * HOUR - 8 * HOUR, 100 * HOUR - 7 * HOUR]);
    expect(twice.restart.nextAllowedAt()).toBe(100 * HOUR + 16 * HOUR);
    // Restarts more than a day ago do not count.
    expect(office([10 * HOUR, 11 * HOUR]).restart.nextAllowedAt()).toBeUndefined();
  });
});
