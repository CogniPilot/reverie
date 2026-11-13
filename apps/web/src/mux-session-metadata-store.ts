/** Ordered persistence of mux observations. These bytes never grant process custody. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MuxSession } from './mux-interface.js';

export type MuxMetadataReconciliation = Readonly<{
  version: 1;
  writerId: string;
  kind: 'reconciled';
  repairedIncidentId: string;
  repairedThrough: string;
}>;
export type MuxMetadataIncidentSelector = Readonly<{ writerId: string; expectedIncidentId: string }>;
export type MuxMetadataPublicationStatus = Readonly<
  | { version: 1; writerId: string; kind: 'no-hold-observed' }
  | { version: 1; writerId: string; kind: 'unconfirmed'; incidentId: string; incidentOrdinal: string }
  | MuxMetadataReconciliation
>;

export class MuxMetadataPublicationUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('Mux metadata publication is unconfirmed; explicit reconciliation is required.', { cause });
    this.name = 'MuxMetadataPublicationUnconfirmedError';
  }
}

export class MuxMetadataReconciliationRefusedError extends Error {
  constructor(readonly reason: 'changed' | 'busy') {
    super(
      reason === 'busy'
        ? 'Another metadata reconciliation is still pending.'
        : 'The original metadata incident or its authorization changed. Refresh status before retrying.'
    );
    this.name = 'MuxMetadataReconciliationRefusedError';
  }
}

type Snapshot = Readonly<{ revision: number; json: string }>;
type Listener = (status: MuxMetadataPublicationStatus) => void | Promise<void>;
type Incident = Readonly<{
  id: string;
  ordinal: string;
  error: MuxMetadataPublicationUnconfirmedError;
  originalIO: Promise<void>;
}>;

/** Private checked-I/O outcome. It never crosses a status/API projection. */
class CheckedMetadataWriteError extends Error {
  constructor(
    readonly error: unknown,
    readonly cleanupErrors: readonly unknown[],
    readonly renameIssued: boolean,
    readonly before: string | undefined,
    readonly attempted: string,
    readonly revision: number
  ) {
    super('Mux metadata I/O was not confirmed');
  }
}

/** One in-flight snapshot and one replaceable, not-yet-issued observation snapshot. */
export class MuxSessionMetadataStore {
  readonly #path: string;
  readonly #writerId = randomUUID();
  #incidentOrdinal = 0n;
  readonly #listeners = new Set<Listener>();
  #revision = 0;
  #pending?: Snapshot;
  #active?: Snapshot;
  #lastConfirmed?: Snapshot;
  #running?: Promise<void>;
  #completion: Promise<void> = Promise.resolve();
  #incident?: Incident;
  #repair?: object;
  #lastRepairFailure?: unknown;
  #repaired?: Readonly<{ original: Incident; snapshot: Snapshot; result: MuxMetadataReconciliation }>;

  constructor(filePath: string) {
    this.#path = filePath;
  }

  /** Fixed resource selector from the actual instance writer, never a grant or request path. */
  resourceId(): string {
    return 'mux-metadata:' + createHash('sha256').update(this.#path).digest('hex');
  }

  getStatus(): MuxMetadataPublicationStatus {
    if (this.#incident)
      return Object.freeze({
        version: 1,
        writerId: this.#writerId,
        kind: 'unconfirmed',
        incidentId: this.#incident.id,
        incidentOrdinal: this.#incident.ordinal,
      });
    return this.#repaired?.result ?? Object.freeze({ version: 1, writerId: this.#writerId, kind: 'no-hold-observed' });
  }

  /** Publication observations only; a listener cannot acknowledge or repair I/O. */
  onStatus(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  request(rows: readonly MuxSession[]): void {
    try {
      // Capture before returning to the caller; mutable registry rows never
      // travel through the asynchronous writer. Superseding an unissued
      // observation is not replaying a launch, intent, input, or permission.
      this.#pending = Object.freeze({ revision: ++this.#revision, json: JSON.stringify(rows, null, 2) });
    } catch (cause) {
      this.#hold(Object.freeze({ phase: 'serialize', error: cause, attempted: null }));
      return;
    }
    if (!this.#incident) this.#start();
  }

  /** Joins the original I/O. A rejected publication is never acknowledged by a log. */
  async flush(): Promise<void> {
    try {
      await this.#completion;
    } catch (cause) {
      throw this.#incident?.error ?? cause;
    }
    if (this.#incident) throw this.#incident.error;
  }

  /** Code-only owner boundary. Callers cannot supply file bytes or grant data. */
  reconcile(
    selector: MuxMetadataIncidentSelector,
    currentRows: () => readonly MuxSession[],
    admitted: () => boolean
  ): Promise<MuxMetadataReconciliation> {
    const current = () => {
      try {
        return admitted() === true;
      } catch {
        return false;
      }
    };
    if (selector.writerId !== this.#writerId || !current())
      return Promise.reject(new MuxMetadataReconciliationRefusedError('changed'));
    const original = this.#incident;
    if (!original) {
      if (this.#repaired?.result.repairedIncidentId === selector.expectedIncidentId)
        return Promise.resolve(this.#repaired.result); // Exact receipt; never re-execute a lost reply.
      return Promise.reject(new MuxMetadataReconciliationRefusedError('changed'));
    }
    if (original.id !== selector.expectedIncidentId)
      return Promise.reject(new MuxMetadataReconciliationRefusedError('changed'));
    if (this.#repair) return Promise.reject(new MuxMetadataReconciliationRefusedError('busy'));
    const token = Object.freeze({});
    this.#repair = token;
    const previousIO = this.#completion;
    const operation = this.#reconcileOwned(token, original, previousIO, currentRows, current);
    this.#completion = operation.then(() => undefined);
    // Preserve the rejection for explicit flush/API receivers. Fixed status
    // remains unconfirmed even when no caller awaits a rejected operation.
    void this.#completion.catch(() => {});
    return operation;
  }

  async #reconcileOwned(
    token: object,
    original: Incident,
    previousIO: Promise<void>,
    currentRows: () => readonly MuxSession[],
    admitted: () => boolean
  ): Promise<MuxMetadataReconciliation> {
    try {
      // Join the actual original (or preceding repair) promise. A failed notice
      // is neither cancellation nor proof that an old syscall cannot finish.
      try {
        await original.originalIO;
      } catch {
        /* The retained incident is the original cause. */
      }
      if (previousIO !== original.originalIO) {
        try {
          await previousIO;
        } catch {
          /* A preceding repair also owns its I/O until settlement. */
        }
      }
      const current = () => this.#repair === token && this.#incident === original && admitted();
      if (!current()) throw new MuxMetadataReconciliationRefusedError('changed');
      const snapshot: Snapshot = Object.freeze({
        revision: this.#revision,
        json: JSON.stringify(currentRows(), null, 2),
      });
      const validate = () => {
        if (
          !current() ||
          this.#revision !== snapshot.revision ||
          JSON.stringify(currentRows(), null, 2) !== snapshot.json
        )
          throw new MuxMetadataReconciliationRefusedError('changed');
      };
      await this.#publish(snapshot, validate);
      // A late authority/metadata change cannot make an issued write a known
      // refusal. Keep the incident and report uncertainty instead.
      if (
        !current() ||
        this.#revision !== snapshot.revision ||
        JSON.stringify(currentRows(), null, 2) !== snapshot.json
      )
        throw new MuxMetadataPublicationUnconfirmedError(Object.freeze({ phase: 'changed-after-publication' }));
      const result: MuxMetadataReconciliation = Object.freeze({
        version: 1,
        writerId: this.#writerId,
        kind: 'reconciled',
        repairedIncidentId: original.id,
        repairedThrough: original.ordinal,
      });
      this.#lastConfirmed = snapshot;
      this.#repaired = Object.freeze({ original, snapshot, result });
      this.#pending = undefined;
      this.#incident = undefined;
      // All original I/O is settled before observers run. A reentrant ordinary
      // observation owns a new queue operation, never this finished repair.
      if (this.#repair === token) this.#repair = undefined;
      this.#notify(result);
      return result;
    } catch (cause) {
      this.#lastRepairFailure = Object.freeze({ original, cause });
      if (cause instanceof MuxMetadataReconciliationRefusedError) throw cause;
      if (
        cause instanceof CheckedMetadataWriteError &&
        !cause.renameIssued &&
        cause.cleanupErrors.length === 0 &&
        cause.error instanceof MuxMetadataReconciliationRefusedError
      )
        throw cause.error;
      this.#diagnostic('[TmuxManager] MUX_METADATA_RECONCILIATION_UNCONFIRMED: original incident retained');
      throw new MuxMetadataPublicationUnconfirmedError(this.#lastRepairFailure);
    } finally {
      if (this.#repair === token) this.#repair = undefined;
    }
  }

  #start(): void {
    if (this.#running || !this.#pending || this.#incident || this.#repair) return;
    const original = this.#drain();
    this.#running = original;
    this.#completion = original;
    // Void legacy mutators have no promise receiver. The original rejection
    // remains in #completion/#failure and reaches flush plus fixed observers.
    void original.then(
      () => {
        if (this.#running === original) this.#running = undefined;
        this.#start();
      },
      () => {
        if (this.#running === original) this.#running = undefined;
      }
    );
  }

  async #drain(): Promise<void> {
    while (this.#pending && !this.#incident) {
      const original = this.#pending;
      this.#pending = undefined;
      this.#active = original;
      try {
        await this.#publish(original);
        this.#lastConfirmed = original;
      } catch (cause) {
        throw this.#hold(cause);
      } finally {
        this.#active = undefined;
      }
    }
    if (this.#incident) throw this.#incident.error;
  }

  async #publish(snapshot: Snapshot, validate: () => void = () => {}): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    let file: FileHandle | undefined;
    let renameIssued = false;
    const close = async () => {
      const original = file;
      file = undefined; // Consuming close: failure never permits an FD-reuse retry.
      if (original) await original.close();
    };
    try {
      validate();
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      validate();
      file = await open(temporary, 'wx', 0o600);
      validate();
      await file.writeFile(snapshot.json, 'utf8');
      validate();
      await file.sync();
      validate();
      await close();
      validate();
      renameIssued = true;
      await rename(temporary, this.#path);
      file = await open(dirname(this.#path), 'r');
      await file.sync();
      await close();
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (file) {
        try {
          await close();
        } catch (cleanup) {
          cleanupErrors.push(cleanup);
        }
      }
      try {
        await unlink(temporary);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException)?.code !== 'ENOENT') cleanupErrors.push(cleanup);
      }
      throw new CheckedMetadataWriteError(
        error,
        Object.freeze(cleanupErrors),
        renameIssued,
        this.#lastConfirmed?.json,
        snapshot.json,
        snapshot.revision
      );
    }
  }

  #hold(cause: unknown): MuxMetadataPublicationUnconfirmedError {
    if (!this.#incident) {
      const error = new MuxMetadataPublicationUnconfirmedError(
        Object.freeze({
          error: cause,
          active: this.#active,
          pendingRevision: this.#pending?.revision,
          lastConfirmed: this.#lastConfirmed,
        })
      );
      this.#incident = Object.freeze({
        id: randomUUID(),
        ordinal: String(++this.#incidentOrdinal),
        error,
        originalIO: this.#completion,
      });
      this.#diagnostic(
        '[TmuxManager] MUX_METADATA_PUBLICATION_UNCONFIRMED: metadata writes held; explicit reconciliation required'
      );
      this.#notify(this.getStatus());
    }
    return this.#incident.error;
  }

  #notify(status: MuxMetadataPublicationStatus): void {
    const observerFailed = () => this.#diagnostic('[TmuxManager] Mux metadata publication observer failed');
    for (const listener of [...this.#listeners]) {
      try {
        void Promise.resolve(listener(status)).catch(observerFailed);
      } catch {
        observerFailed();
      }
    }
  }

  #diagnostic(message: string): void {
    try {
      console.error(message);
    } catch {
      /* The original failure and all observers survive a logger failure. */
    }
  }
}
