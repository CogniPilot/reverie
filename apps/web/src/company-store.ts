import fs from 'node:fs/promises';
import { constants, readFileSync, lstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanyStateSchema, type CompanyState } from './company-types.js';
import { restMetadataId, restMetadataSessionId, type RestEmployeeMetadata } from './rest-canonical-metadata.js';

/** Commit sensitive state and launch intent across process crashes and power loss. */
export async function writeCompanyStateFile(
  file: string,
  data: string,
  beforeCommit: () => void = () => {}
): Promise<void> {
  const directory = dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    beforeCommit();
    await fs.rename(temporary, file);
    const parent = await fs.open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Cross-process lock covers reload, validation, CAS and durable rename. The kernel releases it on process death. */
/** Canonical byte budget for service authority (serviceGrants plus serviceGrantRevocations), enforced at every commit. */
export const SERVICE_AUTHORITY_BUDGET = 2 * 1024 * 1024;
export function serviceAuthorityBytes(state: Pick<CompanyState, 'serviceGrants' | 'serviceGrantRevocations'>): number {
  return Buffer.byteLength(JSON.stringify({ grants: state.serviceGrants, revocations: state.serviceGrantRevocations }));
}
/** Worst-case bytes one revocation adds for this owner (100-char grant id, largest timestamp). */
export function serviceRevocationBytes(owner: string | undefined): number {
  return Buffer.byteLength(JSON.stringify({ grantId: 'x'.repeat(100), owner, at: Number.MAX_SAFE_INTEGER })) + 1;
}
/** Issuance must leave room to revoke every grant not yet revoked, so a saturated store can always still revoke. */
export function serviceAuthorityFits(state: Pick<CompanyState, 'serviceGrants' | 'serviceGrantRevocations'>): boolean {
  const revoked = new Set(state.serviceGrantRevocations.map((r) => r.grantId));
  const reserve = state.serviceGrants
    .filter((g) => !revoked.has(g.id))
    .reduce((sum, g) => sum + serviceRevocationBytes(g.owner), 0);
  return serviceAuthorityBytes(state) + reserve <= SERVICE_AUTHORITY_BUDGET;
}

export class CompanyStore {
  private state: CompanyState = {
    version: 1,
    employees: [],
    settings: [],
    cycles: [],
    memories: [],
    goals: [],
    goalGrants: [],
    goalGrantRevocations: [],
    serviceGrants: [],
    serviceGrantRevocations: [],
    goalUnblockProofs: [],
    goalProofRevocations: [],
    temporaryAgents: [],
    retired: [],
  };
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private existed = false;
  // Metadata may use only a state already observed by ordinary canonical I/O.
  // A changed/missing file refuses; a health read never reloads/clones private state.
  private healthWitness?: { state: CompanyState; stamp: string };
  constructor(readonly file: string) {}

  private healthStamp(): string {
    const stat = lstatSync(this.file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Canonical metadata unavailable');
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }
  private possibleHealthStamp(): string | undefined {
    try {
      return this.healthStamp();
    } catch {
      return undefined;
    }
  }
  private rememberHealth(before: string | undefined): void {
    const after = this.possibleHealthStamp();
    this.healthWitness = before !== undefined && before === after ? { state: this.state, stamp: after } : undefined;
  }

  async init(): Promise<void> {
    const before = this.possibleHealthStamp();
    try {
      this.state = CompanyStateSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.existed) throw error;
    }
    this.rememberHealth(before);
  }

  /** Fixed health metadata only: never clone/read memories, objectives, prompts or receipt bodies. */
  healthMetadataSnapshot(): { employees: readonly unknown[]; goals?: readonly unknown[] } {
    const witness = this.healthWitness;
    const current = () => {
      if (!witness || witness.state !== this.state || witness.stamp !== this.healthStamp())
        throw new Error('Canonical metadata changed or unavailable');
    };
    current();
    const records = this.state as CompanyState & { goals?: readonly Record<string, unknown>[] };
    if (records.employees.length > 1024 || (records.goals?.length ?? 0) > 4096)
      throw new Error('Health metadata budget exceeded');
    const metadata = {
      employees: records.employees.map((value) => {
        const e = value as typeof value & { sessionGeneration?: unknown; bindingMigration?: unknown };
        return {
          id: e.id,
          owner: e.owner,
          sessionId: e.sessionId,
          sessionGeneration: e.sessionGeneration,
          desiredRunning: e.desiredRunning,
          onVacation: e.onVacation,
          bindingMigration: e.bindingMigration === undefined ? undefined : true,
        };
      }),
      goals: records.goals?.map((g) => {
        const transitions = g.transitions;
        const last =
          Array.isArray(transitions) && transitions.length > 0 && transitions.length <= 256
            ? (transitions[transitions.length - 1] as Record<string, unknown>)
            : undefined;
        const a = last?.after as Record<string, unknown> | undefined;
        return {
          id: g.id,
          employeeId: g.employeeId,
          owner: g.owner,
          sessionId: g.sessionId,
          sessionGeneration: g.sessionGeneration,
          generation: g.generation,
          state: g.state,
          transitionSequence: g.transitionSequence,
          semanticProgressAt: g.semanticProgressAt,
          updatedAt: g.updatedAt,
          transitions:
            last && a
              ? [
                  {
                    sequence: last.sequence,
                    generation: last.generation,
                    after: {
                      sessionId: a.sessionId,
                      sessionGeneration: a.sessionGeneration,
                      generation: a.generation,
                      state: a.state,
                      transitionSequence: a.transitionSequence,
                      semanticProgressAt: a.semanticProgressAt,
                      updatedAt: a.updatedAt,
                    },
                  },
                ]
              : [],
        };
      }),
    };
    current();
    return metadata;
  }

  snapshot(): CompanyState {
    const before = this.possibleHealthStamp();
    // This is an internal private canonical file, never a user-selected remote workspace path.
    try {
      this.state = CompanyStateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.existed) throw error;
    }
    this.rememberHealth(before);
    return structuredClone(this.state);
  }

  /** Internal scalar selector: no profile/objective/memory copy and no authority or generation synthesis. */
  restEmployeeMetadata(ownerId: string | undefined, employeeId: string): RestEmployeeMetadata | undefined {
    if (!restMetadataId(employeeId) || (ownerId !== undefined && !restMetadataId(ownerId))) return;
    const employees = this.state.employees;
    const matches = employees.filter((employee) => employee.id === employeeId);
    if (matches.length !== 1) return;
    const employee = matches[0]!;
    if (
      employee.owner !== ownerId ||
      !restMetadataSessionId(employee.sessionId) ||
      employees.filter((candidate) => candidate.sessionId === employee.sessionId).length !== 1 ||
      (employee.desiredRunning !== undefined && typeof employee.desiredRunning !== 'boolean') ||
      typeof employee.onVacation !== 'boolean' ||
      typeof employee.sleepEnabled !== 'boolean' ||
      typeof employee.dreamEnabled !== 'boolean'
    )
      return;
    return Object.freeze({
      employeeId: employee.id,
      ownerId: employee.owner ?? null,
      sessionId: employee.sessionId,
      desiredRunning: employee.desiredRunning ?? null,
      vacation: employee.onVacation,
      sleepEnabled: employee.sleepEnabled,
      dreamEnabled: employee.dreamEnabled,
    });
  }

  /** Current canonical Goal scalars only; never objective, nextAction, evidence or receipt bodies. */
  restGoalMetadata(ownerId: string | undefined, employeeId: string, sessionId: string) {
    const witness = this.healthWitness;
    const current = () => {
      if (!witness || witness.state !== this.state || witness.stamp !== this.healthStamp())
        throw new Error('Canonical Goal metadata changed or unavailable');
    };
    try {
      current();
    } catch {
      return null;
    }
    const matches = this.state.goals.filter(
      (goal) => goal.owner === ownerId && goal.employeeId === employeeId && goal.sessionId === sessionId
    );
    // No guessed latest Goal or generation. Ambiguous assignment remains unknown.
    if (matches.length !== 1) return null;
    const goal = matches[0]!;
    const result = Object.freeze({
      goalId: goal.id,
      goalGeneration: goal.generation,
      transitionSequence: goal.transitionSequence,
      goalState: goal.state,
    });
    try {
      current();
    } catch {
      return null;
    }
    return result;
  }

  private async locked<T>(body: () => Promise<T>): Promise<T> {
    await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await fs.open(
      `${this.file}.lock`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '--wait', '5', '--conflict-exit-code', '75', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', handle.fd],
          env: { PATH: process.env.PATH },
        });
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error('Canonical company transaction lock unavailable; nothing committed'))
        );
      });
      return await body();
    } finally {
      await handle.close();
    }
  }

  update<T>(mutate: (state: CompanyState) => T, validateAuthority: () => void = () => {}): Promise<T> {
    if (this.queued >= 128) return Promise.reject(new Error('Canonical company transaction queue is full'));
    this.queued++;
    const run = this.chain
      .then(() =>
        this.locked(async () => {
          let current: CompanyState;
          try {
            current = CompanyStateSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.existed) throw error;
            current = structuredClone(this.state);
          }
          validateAuthority();
          const result = mutate(current);
          CompanyStateSchema.parse(current);
          const goalBytes = Buffer.byteLength(
            JSON.stringify({ goals: current.goals, grants: current.goalGrants, proofs: current.goalUnblockProofs })
          );
          if (goalBytes > 8 * 1024 * 1024) throw new Error('Canonical Goal storage budget exhausted');
          if (serviceAuthorityBytes(current) > SERVICE_AUTHORITY_BUDGET)
            throw new Error('Canonical service grant storage budget exhausted');
          await writeCompanyStateFile(this.file, JSON.stringify(current), validateAuthority);
          this.state = current;
          this.existed = true;
          // This transaction still owns the canonical cross-process writer lock.
          this.rememberHealth(this.possibleHealthStamp());
          return structuredClone(result);
        })
      )
      .finally(() => {
        this.queued--;
      });
    this.chain = run.catch(() => {});
    return run;
  }
}
