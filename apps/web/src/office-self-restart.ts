/**
 * @fileoverview The office ends its own process, so that Docker starts it again, when its laptop runtime can no
 * longer be used.
 *
 * The laptop runtime is composed once, at start, from the fixed runtime configuration and the private instance key.
 * The office keeps both open and compares them on every use (`DockerEmployeeRuntime.current`). Once either differs
 * from what was read at start, that comparison fails for good: every laptop route answers
 * `DOCKER_CONTINUATION_RUNTIME_CHANGED`, the supervisor stops its passes, and no laptop is at fault. Nothing reads
 * them again in place, and nothing should: the key and the configuration are the runtime's identity, and a process
 * that swapped them under its open laptops would have to prove every record again. A new office process reads
 * them, and the office container's restart policy starts one when this process ends.
 *
 * An office that exits on purpose can do harm, so every condition below must hold:
 *
 * - the fault has stood, with nothing about it changing, for `settleMs`. While something is still writing the
 *   configuration or the key (an update that is being put in place does) the wait starts over;
 * - what a new process would read is in place and passes the checks of a start. An office that would only fail to
 *   start again is not restarted;
 * - the Engine reports a restart policy for this container that starts it again after a clean exit. A container
 *   that nothing would bring back is never taken down. A container the owner or an update tool stops is not
 *   affected: Docker does not restart a container it was told to stop;
 * - no owner switched automatic repairs off (`supervisorAutoRepair`);
 * - nothing the office itself runs is in flight for any employee: no open plan move, no laptop set-up, rebuild or
 *   repair. A restart would cut it off in the middle;
 * - at most `perDay` restarts in a day and never two within `spacingMs`, by a record that is written before the
 *   exit and read after it. A fault that survives a restart therefore cannot turn into a restart loop.
 *
 * The exit itself is the office's ordinary graceful shutdown. Laptops keep running through it and are attached
 * again by the new process, as after any office restart.
 */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface OfficeSelfRestartLimits {
  /** The fault must have stood unchanged this long. */
  readonly settleMs: number;
  /** Restarts in any 24 hours. */
  readonly perDay: number;
  /** Least time between two restarts. */
  readonly spacingMs: number;
}
export const OFFICE_SELF_RESTART_LIMITS: OfficeSelfRestartLimits = {
  settleMs: 10 * MINUTE,
  perDay: 2,
  spacingMs: 60 * MINUTE,
};

/** A request of the supervisor that was not repeated for this long no longer stands. It asks every half minute. */
const REQUEST_LAPSE_MS = 2 * MINUTE;

/** Restart policies under which Docker starts a container again after its process ended with status 0. */
const RESTARTS_AFTER_CLEAN_EXIT: readonly string[] = ['always', 'unless-stopped'];

export interface OfficeSelfRestartDeps {
  now(): number;
  /** The office has finished starting. Nothing is decided before that. */
  started(): boolean;
  /** The laptop runtime is no longer the one the office started with. */
  stale(): boolean;
  /** Changes whenever the configuration or the key on disk changes. Any stable text. */
  stamp(): string;
  /** A new office process would find a configuration and a key that it accepts. */
  startable(): boolean;
  /** No owner switched automatic repairs off. */
  allowed(): boolean;
  /** The restart policy of the office's own container as the Engine reports it; null when it cannot be read. */
  restartPolicy(): Promise<string | null>;
  /**
   * What the office itself is in the middle of for any employee (an open plan move, a laptop set-up, rebuild or
   * repair), in a few words, or undefined when nothing is. A rejection counts as something. Absent where the
   * office runs no such operations.
   */
  operation?(): Promise<string | undefined>;
  /** The times of earlier restarts, from the record that survives them. */
  load(): readonly number[];
  /** Write that record. A throw means nothing was recorded, and then the office does not exit. */
  save(times: readonly number[]): void;
  /** Ask for the office's ordinary graceful shutdown. */
  exit(): void;
  log(line: string): void;
  audit(entry: { admin: 'office supervisor'; action: string; target: string; detail: Record<string, unknown> }): void;
}

function when(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export class OfficeSelfRestart {
  #since?: number;
  #stamp?: string;
  #status?: string;
  #said?: string;
  #flight?: Promise<void>;
  #exiting = false;
  /** The supervisor's finding that the office itself is at fault, and when it was first and last made. */
  #asked?: { readonly reason: string; readonly first: number; readonly last: number };
  /** The last look found that this office does not restart itself, whatever is asked of it. */
  #never = false;

  constructor(
    private readonly deps: OfficeSelfRestartDeps,
    private readonly limits: OfficeSelfRestartLimits = OFFICE_SELF_RESTART_LIMITS
  ) {}

  /**
   * What every employee waits for while the laptop runtime cannot be used, in the words of a report's `waitingFor`.
   * Undefined while the runtime is current.
   */
  status(): string | undefined {
    return this.#status;
  }

  /**
   * The supervisor found a fault that looks like the office's own and not any laptop's (it reads none of its
   * laptops). It asks on every pass while that stands; a request that is not repeated lapses. The restart keeps
   * every condition and limit of this file. `refused`: this office does not restart itself, so nothing should wait
   * for it.
   */
  request(reason: string): 'pending' | 'refused' {
    const now = this.deps.now(),
      before = this.#asked,
      running = before && before.reason === reason && now - before.last <= REQUEST_LAPSE_MS;
    this.#asked = { reason, first: running ? before.first : now, last: now };
    return this.#never ? 'refused' : 'pending';
  }

  /** When the office last restarted itself, by the record that survives it. */
  lastAt(): number | undefined {
    return this.deps.load().at(-1);
  }

  /** One look. A look that is still running is joined, never doubled. Never rejects. */
  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    const flight = this.#look()
      .catch(() => this.#say('the office to restart itself; its last check of whether it may could not finish'))
      .finally(() => {
        if (this.#flight === flight) this.#flight = undefined;
      });
    this.#flight = flight;
    return flight;
  }

  #say(status: string | undefined): void {
    this.#status = status;
    if (status === this.#said) return;
    this.#said = status;
    const stale = this.deps.stale();
    this.deps.log(
      status
        ? `[supervisor] ${stale ? "the office's laptop configuration changed while it was running" : 'the office itself looks at fault'}; every employee waits for ${status}`
        : "[supervisor] the office's laptop configuration is current again, and nothing asks for an office restart"
    );
  }

  /**
   * The earliest time at which the record of earlier restarts allows the next one (at most two a day, an hour
   * apart), or undefined while one may run now. The supervisor asks it before it waits for a restart: one that the
   * limits forbid for the rest of the day is no restart to wait for.
   */
  nextAllowedAt(): number | undefined {
    const now = this.deps.now(),
      next = this.#next(this.deps.load(), now);
    return next > now ? next : undefined;
  }

  #next(times: readonly number[], now: number): number {
    const today = times.filter((at) => now - at < DAY && at <= now);
    const last = today.at(-1);
    return Math.max(
      today.length >= this.limits.perDay ? today[today.length - this.limits.perDay]! + DAY : 0,
      last === undefined ? 0 : last + this.limits.spacingMs
    );
  }

  /** Why no restart may run yet by the record of earlier ones, or undefined. */
  #paced(times: readonly number[], now: number): string | undefined {
    const next = this.#next(times, now);
    return next > now
      ? `the office to restart itself: it already did and that did not settle it, so the next restart is at ${when(next)}`
      : undefined;
  }

  async #look(): Promise<void> {
    if (this.#exiting || !this.deps.started()) return;
    const now = this.deps.now(),
      stale = this.deps.stale();
    // The supervisor's finding stands only while it goes on asking; a changed configuration needs no asking.
    const asked = () =>
      this.#asked && this.deps.now() - this.#asked.last <= REQUEST_LAPSE_MS ? this.#asked : undefined;
    const request = stale ? undefined : asked();
    if (!stale && !request) {
      this.#since = undefined;
      this.#stamp = undefined;
      this.#never = false;
      return this.#say(undefined);
    }
    const stamp = request ? 'asked:' + request.reason : this.deps.stamp();
    if (this.#since === undefined || stamp !== this.#stamp) {
      this.#since = request ? request.first : now;
      this.#stamp = stamp;
    }
    const due = this.#since + this.limits.settleMs;
    if (!this.deps.allowed()) {
      this.#never = true;
      return this.#say(
        'an office restart, which the office does not do by itself while automatic repairs are switched off ' +
          '(company setting supervisorAutoRepair)'
      );
    }
    if (now < due)
      return this.#say(
        request
          ? `the office to restart itself at ${when(due)}: ${request.reason}`
          : `the office to restart itself at ${when(due)} and read its configuration again`
      );
    const times = this.deps.load();
    const paced = this.#paced(times, now);
    if (paced) return this.#say(paced);
    if (!this.deps.startable()) {
      this.#never = true;
      return this.#say(
        'a laptop configuration and key that the office would accept at start: what is in place now would be ' +
          'refused, so the office does not restart itself into it'
      );
    }
    const policy = await this.deps.restartPolicy();
    if (!policy || !RESTARTS_AFTER_CLEAN_EXIT.includes(policy)) {
      this.#never = true;
      return this.#say(
        'an office restart: the container engine does not say that it starts this container again after an exit ' +
          `(restart policy ${policy ? `“${policy.slice(0, 40)}”` : 'unreadable'}), so the office does not end itself`
      );
    }
    this.#never = false;
    // Asked last, so that as little as possible can start between the answer and the exit. A restart would cut an
    // operation off in the middle, and for a plan move it would also reset what the move's own clocks have watched.
    const operation = this.deps.operation
      ? await this.deps.operation().catch(() => 'an operation it could not rule out')
      : undefined;
    if (operation) return this.#say(`the office to restart itself once ${operation} has ended`);
    // Read once more after the await: nothing is ended for a fault that is gone or still moving.
    const stands = request
      ? !this.deps.stale() && asked()?.reason === request.reason
      : this.deps.stale() && this.deps.stamp() === stamp;
    if (!stands || !this.deps.allowed()) return;
    this.deps.save([...times.filter((at) => now - at < DAY), now].slice(-8));
    this.#exiting = true;
    this.#say(
      request
        ? `the office, which is restarting now: ${request.reason}`
        : 'the office, which is restarting now to read its laptop configuration again'
    );
    try {
      this.deps.audit({
        admin: 'office supervisor',
        action: 'supervisor_restart_office',
        target: 'office',
        detail: {
          reason: request ? request.reason : 'DOCKER_CONTINUATION_RUNTIME_CHANGED',
          restartPolicy: policy,
          since: this.#since,
          at: now,
        },
      });
    } catch {
      /* best-effort */
    }
    this.deps.exit();
  }
}

/** The container this process runs in, as the three files Docker mounts into every container name it. */
export function ownContainerId(mountinfo: string): string | undefined {
  const ids = new Set(
    [...mountinfo.matchAll(/\/containers\/([a-f0-9]{64})\/(?:hostname|hosts|resolv\.conf)(?= )/g)].map(
      (match) => match[1]!
    )
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}

/**
 * The restart policy of the office's own container, read through the Engine; null when it cannot be told. The
 * container is found by its id from the mount table, or by its host name where the two are still the same, and it
 * is taken for the office's own only when the Engine reports that same host name for it.
 */
export async function ownRestartPolicy(
  run: (args: readonly string[]) => Promise<string>,
  hostname: string,
  mountinfo: string
): Promise<string | null> {
  const names = [ownContainerId(mountinfo), hostname].filter(
    (name): name is string => !!name && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
  );
  for (const name of names) {
    try {
      const answer = await run([
        'container',
        'inspect',
        '--format',
        '{{.Config.Hostname}}|{{.HostConfig.RestartPolicy.Name}}',
        name,
      ]);
      const match = /^([^|\n]{1,253})\|([a-z-]{0,32})\n?$/.exec(answer);
      if (match && match[1] === hostname) return match[2] || 'no';
    } catch {
      /* the next name */
    }
  }
  return null;
}

const RestartRecord = z
  .object({
    version: z.literal(1),
    purpose: z.literal('office-self-restart-v1'),
    restarts: z.array(z.number().int().nonnegative().safe()).max(8),
  })
  .strict();

/**
 * The record of the office's own restarts. It is written, synchronously and whole, before the office exits. A file
 * that is absent reads as no restart. One that exists and cannot be read counts as a restart made at this moment,
 * so that a damaged record slows the office down and never lets it loop.
 */
export class OfficeSelfRestartRecord {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  load(): number[] {
    let body: string;
    try {
      body = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [this.now()];
    }
    try {
      return RestartRecord.parse(JSON.parse(body)).restarts;
    } catch {
      return [this.now()];
    }
  }

  save(times: readonly number[]): void {
    const body = JSON.stringify(
      RestartRecord.parse({ version: 1, purpose: 'office-self-restart-v1', restarts: [...times] })
    );
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
