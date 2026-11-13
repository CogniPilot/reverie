import fs from 'node:fs/promises';
import { constants, readFileSync, lstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanyStateSchema, type CompanyEmployee, type CompanyState } from './company-types.js';
import { restMetadataId, restMetadataSessionId, type RestEmployeeMetadata } from './rest-canonical-metadata.js';
import {EmployeeRecoveryAttempt} from './employee-recovery-attempt.js';
import { recoveryDataDigest, supersedeStoppedRecoveryHistory } from './employee-recovery-operation.js';

/** Commit sensitive state and launch intent across process crashes and power loss. */
export async function writeCompanyStateFile(
  file: string,
  data: string,
  beforeCommit: () => void | Promise<void> = () => {}
): Promise<void> {
  return writeCanonicalState(file, data, beforeCommit, () => {});
}

async function writeCanonicalState(
  file: string,
  data: string,
  beforeCommit: () => void | Promise<void>,
  beforeRename: () => void
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
    // Preserve the existing same-turn publication boundary for synchronous guards.
    const validation = beforeCommit();
    if (validation !== undefined) await validation;
    beforeRename();
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

/** Only this module can issue an uncertain publication receipt for an actual writer attempt. */
class CompanyPublicationUnconfirmed extends Error {
  #store: CompanyStore;
  constructor(store: CompanyStore, cause: unknown) {
    super('Canonical company publication is unconfirmed; preserve the current identity and do not replay it.', {
      cause,
    });
    this.#store = store;
  }
  static belongsTo(value: unknown, store: CompanyStore): boolean {
    return value instanceof CompanyPublicationUnconfirmed && #store in value && value.#store === store;
  }
}

export type CompanyUpdateOutcome<T> =
  | { readonly state: 'committed'; readonly value: T }
  | { readonly state: 'not-issued'; readonly cause: unknown }
  | { readonly state: 'unconfirmed'; readonly receipt: CompanyPublicationUnconfirmed };

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
  #unconfirmedRecoveryObservation?: {
    owner: EmployeeRecoveryAttempt; before: string; attempted: string; receipt: CompanyPublicationUnconfirmed;
  };
  /** Only this same writer's genuine observation attempt may bridge its own
   * before/attempted rows for a fresh read. This never repairs the writer. */
  matchesEmployeeRecoveryObservation(attempt: EmployeeRecoveryAttempt, state: CompanyState): boolean {
    const original = EmployeeRecoveryAttempt.prototype.observationMetadataOwner.call(attempt, this);
    const matched=this.matchesRetainedEmployeeRecoveryObservation(attempt,state);
    if(matched&&!original.readOnly)throw Error('Unconfirmed observation cannot admit another effect');
    return matched;
  }
  /** Read-only selector equality; never an effect/current-context allowance. */
  matchesRetainedEmployeeRecoveryObservation(attempt: EmployeeRecoveryAttempt, state: CompanyState): boolean {
    const original = EmployeeRecoveryAttempt.prototype.observationMetadataOwner.call(attempt, this);
    const retained = this.#unconfirmedRecoveryObservation;
    if (!retained || retained.owner !== original.owner) return false;
    const serialized = JSON.stringify(CompanyStateSchema.parse(state));
    if (!this.writeUncertain || (serialized !== retained.before && serialized !== retained.attempted))
      throw Error('Original observation writer state changed; preserve the uncertainty');
    return true;
  }
  async employeeAfterRecoveryObservation(attempt:EmployeeRecoveryAttempt,employeeId:string,owner:string|undefined):Promise<CompanyEmployee|undefined> {
    const original=this.chain;
    await original;
    return this.locked(async()=>{
      const state=this.snapshot();
      if(!this.matchesRetainedEmployeeRecoveryObservation(attempt,state))throw Error('Original observation writer required');
      const rows=state.employees.filter(row=>row.id===employeeId);
      return rows.length===1&&rows[0]!.owner===owner?rows[0]:undefined;
    });
  }
  publishEmployeeRecoveryObservation(attempt: EmployeeRecoveryAttempt): Promise<CompanyUpdateOutcome<void>> {
    const {before, attempted} = EmployeeRecoveryAttempt.prototype.observationPublication.call(attempt, this);
    return this.#updateOutcome(state => {
      EmployeeRecoveryAttempt.prototype.assertCurrent.call(attempt, state);
      const rows = state.employeeRecoveryOperations;
      const index = rows?.findIndex(row => row.approval.operationId === before.approval.operationId) ?? -1;
      if (!rows || index < 0 || recoveryDataDigest(rows[index]) !== recoveryDataDigest(before))
        throw Error('Original observation metadata changed');
      rows[index] = attempted;
    }, () => EmployeeRecoveryAttempt.prototype.assertCurrent.call(attempt), undefined, undefined, attempt);
  }
  #stoppedAcknowledgements = new WeakMap<EmployeeRecoveryAttempt, { stage: 'intent' | 'terminal'; digest: string }>();
  #reconciledRecoveryEvidence = new WeakMap<EmployeeRecoveryAttempt, CompanyPublicationUnconfirmed[]>();
  publishStoppedEmployeeRecovery(
    attempt: EmployeeRecoveryAttempt,
    stage: 'intent' | 'terminal'
  ): Promise<CompanyUpdateOutcome<void>> {
    const projection = EmployeeRecoveryAttempt.prototype.stoppedPublication.call(attempt, this, stage);
    return this.#updateOutcome(
      (state) => {
        EmployeeRecoveryAttempt.prototype.assertStoppedPublicationBinding.call(attempt, this, state);
        const rows = state.employeeRecoveryOperations;
        const index =
          rows?.findIndex((row) => row.approval.operationId === projection.before.approval.operationId) ?? -1;
        if (
          !rows ||
          index < 0 ||
          (recoveryDataDigest(rows[index]) !== recoveryDataDigest(projection.before) &&
            recoveryDataDigest(rows[index]) !== recoveryDataDigest(projection.attempted))
        )
          throw Error('Original stopped publication row changed');
        const targets = state.employees.filter((row) => row.id === projection.before.employeeId),
          target = targets[0];
        if (
          targets.length !== 1 ||
          !target ||
          target.owner !== projection.before.owner ||
          target.sessionId !== projection.before.approval.sessionId ||
          String(target.sessionGeneration) !== projection.before.approval.sessionGeneration ||
          state.employees.filter((row) => row.sessionId === target.sessionId).length !== 1
        )
          throw Error('Original stopped target changed');
        target.desiredRunning = false;
        rows[index] = projection.attempted;
      },
      () => EmployeeRecoveryAttempt.prototype.assertStoppedPublication.call(attempt, this),
      undefined,
      undefined,
      undefined,
      { attempt, stage, digest: recoveryDataDigest(projection.attempted) }
    );
  }
  consumeStoppedEmployeeAcknowledgement(attempt: EmployeeRecoveryAttempt, stage: 'intent' | 'terminal'): void {
    const ack = this.#stoppedAcknowledgements.get(attempt);
    if (
      !ack ||
      ack.stage !== stage ||
      ack.digest !== EmployeeRecoveryAttempt.prototype.stoppedPublicationDigest.call(attempt, this, stage)
    )
      throw Error('Actual stopped writer acknowledgement required');
    this.#stoppedAcknowledgements.delete(attempt);
  }
  readonly #recoveryAcknowledgements=new WeakMap<EmployeeRecoveryAttempt,string>();
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
  private writeUncertain = false;

  get publicationUnconfirmed(): boolean {
    return this.writeUncertain;
  }
  isPublicationReceipt(value: unknown): boolean {
    return CompanyPublicationUnconfirmed.belongsTo(value, this);
  }
  private assertWritable(): void {
    if (this.writeUncertain)
      throw new Error('Canonical company publication is unconfirmed; this writer is held pending reconciliation.');
  }
  private queued = 0;
  private existed = false;
  private readStamp?: string;
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
    this.assertWritable();
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

  /** Revalidate only when the canonical file changes; never use a time-based authority cache. */
  private refreshState(): void {
    const before = this.possibleHealthStamp();
    if (before !== undefined && before === this.readStamp) return;
    this.readStamp = undefined;
    // This is an internal private canonical file, never a user-selected remote workspace path.
    try {
      this.state = CompanyStateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.existed) throw error;
    }
    this.rememberHealth(before);
    this.readStamp = this.healthWitness?.stamp;
  }

  snapshot(): CompanyState {
    this.refreshState();
    return structuredClone(this.state);
  }
  /** Permission and recovery reads join earlier writes under the canonical writer lock. */
  async employeeAfterPublications(employeeId: string, owner: string | undefined): Promise<CompanyEmployee | undefined> {
    const original = this.chain;
    await original;
    this.assertWritable();
    return this.locked(async () => {
      this.assertWritable();
      const matches = this.snapshot().employees.filter((employee) => employee.id === employeeId);
      return matches.length === 1 && matches[0]!.owner === owner ? matches[0] : undefined;
    });
  }

  /** Fresh, unambiguous binding without cloning other employees, goals or memories. */
  employeeForSession(sessionId: string, owner: string | undefined): CompanyEmployee | undefined {
    this.refreshState();
    const matches = this.state.employees.filter((employee) => employee.sessionId === sessionId);
    if (matches.length !== 1 || matches[0].owner !== owner) return;
    return structuredClone(matches[0]);
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

  update<T>(
    mutate: (state: CompanyState) => T,
    validateAuthority: () => void | Promise<void> = () => {},
    beforeSave?: (result: T) => void | Promise<void>
  ): Promise<T> {
    return this.updateOutcome(mutate, validateAuthority, beforeSave).then((outcome) => {
      if (outcome.state === 'committed') return outcome.value;
      throw outcome.state === 'not-issued' ? outcome.cause : outcome.receipt;
    });
  }

  /** The current call's closed writer outcome; a recycled exception never supplies publication authority. */
  updateOutcome<T>(
    mutate: (state: CompanyState) => T,
    validateAuthority: () => void | Promise<void> = () => {},
    beforeSave?: (result: T) => void | Promise<void>
  ): Promise<CompanyUpdateOutcome<T>> {
    return this.#updateOutcome(mutate,validateAuthority,beforeSave);
  }
  publishEmployeeRecovery(attempt: EmployeeRecoveryAttempt): Promise<CompanyUpdateOutcome<void>> {
    void this.#recoveryAcknowledgements;
    const row = EmployeeRecoveryAttempt.prototype.publicationRow.call(attempt, this);
    const original = EmployeeRecoveryAttempt.prototype.existingPublicationRow.call(attempt, this);
    return this.#updateOutcome(
      (state) => {
        EmployeeRecoveryAttempt.prototype.assertCurrent.call(attempt, state);
        const rows = (state.employeeRecoveryOperations ??= []);
        if (original) {
          const index = rows.findIndex((value) => value.approval.operationId === original.approval.operationId);
          if (index < 0 || rows[index]!.component || recoveryDataDigest(rows[index]) !== recoveryDataDigest(original))
            throw Error('Original recovery component row changed');
          rows[index] = row;
          return;
        }
        if (
          rows.some(
            (value) =>
              (value.employeeId === row.employeeId && value.application?.state !== 'completed-stopped') ||
              value.approval.operationId === row.approval.operationId
          )
        )
          throw Error('Original employee recovery row is already retained');
        supersedeStoppedRecoveryHistory(rows, row.employeeId, row.owner, row.approval.operationId);
        rows.push(row);
      },
      () => EmployeeRecoveryAttempt.prototype.assertCurrent.call(attempt),
      undefined,
      { attempt, digest: recoveryDataDigest(row) }
    );
  }
  consumeEmployeeRecoveryAcknowledgement(attempt:EmployeeRecoveryAttempt):void {
    const row=EmployeeRecoveryAttempt.prototype.publicationRow.call(attempt,this);
    const digest=this.#recoveryAcknowledgements.get(attempt);
    if(digest===undefined||digest!==recoveryDataDigest(row))throw Error('Original durable recovery acknowledgement is unavailable');
    this.#recoveryAcknowledgements.delete(attempt);
  }
  #updateOutcome<T>(
    mutate: (state: CompanyState) => T,
    validateAuthority: () => void | Promise<void>,
    beforeSave?: (result: T) => void | Promise<void>,
    recovery?: { attempt: EmployeeRecoveryAttempt; digest: string },
    observation?: EmployeeRecoveryAttempt,
    stopped?: { attempt: EmployeeRecoveryAttempt; stage: 'intent' | 'terminal'; digest: string }
  ): Promise<CompanyUpdateOutcome<T>> {
    if (this.queued >= 128)
      return Promise.resolve({ state: 'not-issued', cause: new Error('Canonical company transaction queue is full') });
    this.queued++;
    const run = this.chain
      .then(async (): Promise<CompanyUpdateOutcome<T>> => {
        let issued = false;
        let acknowledgedWrite = false;
        let observationBefore: string | undefined, observationAttempted: string | undefined;
        const priorPublication = this.#unconfirmedRecoveryObservation;
        const writable = () => {
          if (!this.writeUncertain) return;
          if (
            !stopped ||
            !priorPublication ||
            this.#unconfirmedRecoveryObservation !== priorPublication ||
            EmployeeRecoveryAttempt.prototype.stoppedMetadataOwner.call(stopped.attempt, this) !==
              priorPublication.owner
          )
            this.assertWritable();
          this.matchesRetainedEmployeeRecoveryObservation(stopped!.attempt, this.snapshot());
        };
        try {
          writable();
          const value = await this.locked(async () => {
            writable();
            let current: CompanyState;
            try {
              current = CompanyStateSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.existed) throw error;
              current = structuredClone(this.state);
            }
            if (observation || stopped) observationBefore = JSON.stringify(current);
            const validation = validateAuthority();
            if (validation !== undefined) await validation;
            const result = mutate(current);
            CompanyStateSchema.parse(current);
            const goalBytes = Buffer.byteLength(
              JSON.stringify({ goals: current.goals, grants: current.goalGrants, proofs: current.goalUnblockProofs })
            );
            if (goalBytes > 8 * 1024 * 1024) throw new Error('Canonical Goal storage budget exhausted');
            if (serviceAuthorityBytes(current) > SERVICE_AUTHORITY_BUDGET)
              throw new Error('Canonical service grant storage budget exhausted');
            // Optional audit runs while this transaction still owns the writer
            // lock. It receives a copy and cannot mutate the pending company.
            if (beforeSave) {
              await beforeSave(structuredClone(result));
              const validation = validateAuthority();
              if (validation !== undefined) await validation;
            }
            const serialized = JSON.stringify(current);
            if (observation || stopped) observationAttempted = JSON.stringify(CompanyStateSchema.parse(current));
            await writeCanonicalState(this.file, serialized, validateAuthority, () => {
              issued = true;
            });
            this.state = current;
            this.existed = true;
            // The transaction callback has seen `current`; reload a private copy on the next read.
            this.readStamp = undefined;
            // This transaction still owns the canonical cross-process writer lock.
            this.rememberHealth(this.possibleHealthStamp());
            acknowledgedWrite = true;
            return structuredClone(result);
          });
          if (recovery) {
            if (!acknowledgedWrite) throw Error('Actual canonical recovery writer did not acknowledge publication');
            const validation = validateAuthority();
            if (validation !== undefined) await validation;
            this.#recoveryAcknowledgements.set(recovery.attempt, recovery.digest);
          }
          if (stopped) {
            if (!acknowledgedWrite) throw Error('Actual stopped writer did not acknowledge publication');
            const validation = validateAuthority();
            if (validation !== undefined) await validation;
            this.#stoppedAcknowledgements.set(stopped.attempt, { stage: stopped.stage, digest: stopped.digest });
            if (priorPublication && this.#unconfirmedRecoveryObservation === priorPublication) {
              const evidence = this.#reconciledRecoveryEvidence.get(priorPublication.owner) ?? [];
              evidence.push(priorPublication.receipt);
              this.#reconciledRecoveryEvidence.set(priorPublication.owner, evidence);
              this.#unconfirmedRecoveryObservation = undefined;
              this.writeUncertain = false;
            }
          }
          return { state: 'committed', value };
        } catch (cause) {
          if (!issued) return { state: 'not-issued', cause };
          const receipt = new CompanyPublicationUnconfirmed(this, cause);
          if (
            (observation || stopped) &&
            observationBefore !== undefined &&
            observationAttempted !== undefined &&
            (!this.writeUncertain || priorPublication === this.#unconfirmedRecoveryObservation)
          ) {
            const owner = EmployeeRecoveryAttempt.prototype.observationMetadataOwner.call(
              stopped?.attempt ?? observation!,
              this
            ).owner;
            this.#unconfirmedRecoveryObservation = {
              owner,
              before: observationBefore,
              attempted: observationAttempted,
              receipt: priorPublication?.receipt ?? receipt,
            };
          }
          this.writeUncertain = true;
          return { state: 'unconfirmed', receipt };
        }
      })
      .finally(() => {
        this.queued--;
      });
    this.chain = run.catch(() => {});
    return run;
  }
}
