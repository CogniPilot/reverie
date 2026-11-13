/** Private continuation of one actual Session's acknowledged launch intent.
 * The persisted row is a denial after restart, never an execution permit.
 */
import { createHash, randomUUID } from 'node:crypto';
import { verifyProviderLaunchAcknowledgement } from './state-store.js';

export const PROVIDER_LAUNCH_DISK_KEY = '__providerLaunchIntentsV1';
export type ProviderLaunchTransport =
  | 'local-pty'
  | 'local-mux'
  | 'native-ordinary'
  | 'protected-resource'
  | 'remote'
  | 'docker';
export interface ProviderLaunchIntent {
  readonly version: 1;
  readonly phase: 'dispatch-intent';
  readonly attemptId: string;
  readonly sessionId: string;
  readonly owner: string | null;
  readonly mode: string;
  readonly transport: ProviderLaunchTransport;
  readonly configurationDigest: string;
}
export interface ProviderLaunchSource {
  readonly subject: object;
  readonly sessionId: string;
  readonly owner: string | null;
  readonly mode: string;
  readonly workingDir: string;
  readonly transport: ProviderLaunchTransport;
  readonly brokerSocket?: string;
  current(): boolean;
  snapshot(): import('./types.js').SessionState;
}
export type ProviderLaunchExecution = Readonly<{
  kind: 'mux' | 'pty';
  sessionId: string;
  owner: string | null;
  mode: string;
  command: string;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
}>;
type Phase =
  | 'staged'
  | 'refused'
  | 'preparing'
  | 'armed'
  | 'claimed'
  | 'returned'
  | 'held'
  | 'retired-unused'
  | 'retired-stopped';
const MINT = Symbol('original-provider-launch');
const operations = new WeakSet<object>();

/** No public constructor, JSON restoration, boolean or saved ID can mint this. */
export class ProviderLaunchPublication {
  readonly #source: ProviderLaunchSource;
  readonly #write: (operation: ProviderLaunchPublication, row: ProviderLaunchIntent) => Promise<unknown>;
  readonly #attemptId = randomUUID();
  #phase: Phase = 'staged';
  #execution?: ProviderLaunchExecution;
  #row?: ProviderLaunchIntent;
  #acknowledgement?: unknown;

  constructor(
    token: symbol,
    source: ProviderLaunchSource,
    write: (operation: ProviderLaunchPublication, row: ProviderLaunchIntent) => Promise<unknown>
  ) {
    if (token !== MINT) throw new Error('Original provider launch publication required');
    this.#source = Object.freeze({ ...source });
    this.#write = write;
    operations.add(this);
  }

  /** Command construction only. The actual effect still requires prepare+claim. */
  nativeSelection(): Readonly<{ attemptId: string; socket: string }> | undefined {
    this.assertCurrent();
    if (this.#source.transport !== 'native-ordinary') return;
    const socket = this.#source.brokerSocket;
    if (!socket || !socket.startsWith('/') || /[\0\r\n]/.test(socket) || Buffer.byteLength(socket) >= 108)
      throw new Error('Original native launch endpoint is unavailable');
    return Object.freeze({ attemptId: this.#attemptId, socket });
  }

  async prepare(subject: object | undefined, execution: ProviderLaunchExecution): Promise<void> {
    this.assertEffectBinding(subject, execution);
    if (this.#phase !== 'staged') throw new Error('Provider launch preparation was already attempted');
    this.assertCurrent();
    this.#phase = 'preparing';
    this.#execution = Object.freeze({ ...execution, environment: Object.freeze({ ...execution.environment }) });
    this.#row = Object.freeze({
      version: 1,
      phase: 'dispatch-intent',
      attemptId: this.#attemptId,
      sessionId: this.#source.sessionId,
      owner: this.#source.owner,
      mode: this.#source.mode,
      transport: this.#source.transport,
      configurationDigest: createHash('sha256').update(JSON.stringify(this.#execution)).digest('hex'),
    });
    try {
      const acknowledgement = await this.#write(this, this.#row);
      this.assertCurrent();
      if (!verifyProviderLaunchAcknowledgement(acknowledgement, this, this.#source.subject, this.#row, 'prepare'))
        throw new Error('Canonical durable provider acknowledgement required');
      this.#acknowledgement = acknowledgement;
      this.#phase = 'armed';
    } catch (cause) {
      this.#phase = 'held';
      throw cause;
    }
  }

  /** Synchronous one-use claim immediately followed by the original physical effect. */
  claim(): void {
    if (this.#phase !== 'armed') throw new Error('Acknowledged original provider intent required');
    this.assertCurrent();
    if (
      !this.#row ||
      !verifyProviderLaunchAcknowledgement(this.#acknowledgement, this, this.#source.subject, this.#row, 'claim')
    ) {
      this.#phase = 'held';
      throw new Error('Original one-use durable provider acknowledgement required');
    }
    this.#phase = 'claimed';
  }

  assertClaimed(subject: object | undefined, execution: ProviderLaunchExecution): void {
    this.assertEffectBinding(subject, execution);
    this.assertCurrent();
    if (JSON.stringify(execution) !== JSON.stringify(this.#execution))
      throw new Error('Original provider execution changed');
    if (this.#phase !== 'claimed') throw new Error('Original provider dispatch receipt was not consumed');
  }

  private assertEffectBinding(subject: object | undefined, execution: ProviderLaunchExecution): void {
    if (
      subject !== this.#source.subject ||
      execution.sessionId !== this.#source.sessionId ||
      execution.owner !== this.#source.owner ||
      execution.mode !== this.#source.mode ||
      execution.cwd !== this.#source.workingDir
    ) {
      this.#phase = 'held';
      throw new Error('Provider execution does not belong to the original Session');
    }
  }
  get fenced(): boolean {
    return this.#phase !== 'staged' && this.#phase !== 'refused';
  }
  assertCurrent(): void {
    if (this.#phase === 'refused') throw new Error('Original provider launch was refused before preparation');
    if (this.#phase === 'retired-stopped') throw new Error('Original native provider launch was stopped');
    if (this.#phase === 'retired-unused') throw new Error('Original unused provider launch was retired');
    if (!operations.has(this) || this.#phase === 'held' || !this.#source.current()) {
      this.#phase = this.#phase === 'staged' ? 'refused' : 'held';
      throw new Error('Original provider launch configuration or authority changed');
    }
  }
  /** Adapter return is not native/provider readiness and never clears its disk fence. */
  settle(returned: boolean): void {
    if (this.#phase === 'retired-stopped' || this.#phase === 'retired-unused') return;
    // No preparation or physical claim happened. Keep this terminal refusal
    // distinct from an uncertain intent; this object still cannot be reused.
    if (this.#phase === 'staged' || this.#phase === 'refused') {
      this.#phase = 'refused';
      return;
    }
    if (this.#phase !== 'claimed') {
      this.#phase = 'held';
      return;
    }
    try {
      this.assertCurrent();
    } catch {
      returned = false;
    }
    this.#phase = returned ? 'returned' : 'held';
  }

  owns(subject: object): boolean {
    return operations.has(this) && this.#source.subject === subject;
  }
  /** Original writer fact only; expired execution authority is intentionally irrelevant. */
  acknowledgedNeverClaimed(subject: object): boolean {
    return (
      this.owns(subject) &&
      !!this.#row &&
      verifyProviderLaunchAcknowledgement(this.#acknowledgement, this, subject, this.#row, 'unused')
    );
  }
  /** Denial join only: equality does not attest socket/process identity or grant execution. */
  matchesRetainedNativeEndpoint(subject: object, configuredSocket: string | undefined): boolean {
    return (
      this.owns(subject) &&
      !!this.#acknowledgement &&
      !!this.#row &&
      this.#source.transport === 'native-ordinary' &&
      typeof configuredSocket === 'string' &&
      this.#source.brokerSocket === configuredSocket
    );
  }
  retainedDenial(subject: object): ProviderLaunchIntent {
    if (!this.owns(subject) || !this.#row || !this.#acknowledgement)
      throw new Error('Original acknowledged launch denial is unavailable');
    return this.#row;
  }
  consumeUnusedRetirement(subject: object): void {
    if (
      !this.owns(subject) ||
      !this.#row ||
      !verifyProviderLaunchAcknowledgement(this.#acknowledgement, this, subject, this.#row, 'retire-unused')
    )
      throw new Error('Original never-claimed writer acknowledgement is unavailable');
    this.#phase = 'retired-unused';
  }
  /** Invalidates only this original launch after the actual writer acknowledges
   * its exact retirement. No new launch/readiness authority is returned. */
  consumeStoppedRetirement(
    subject: import('./session.js').Session,
    attempt: import('./employee-recovery-attempt.js').EmployeeRecoveryAttempt
  ): void {
    if (!this.owns(subject) || !subject.stoppedEmployeeRetirementKnown(attempt))
      throw Error('Original stopped writer acknowledgement required');
    this.#phase = 'retired-stopped';
  }
  retiredStoppedFor(subject: object): boolean {
    return this.owns(subject) && this.#phase === 'retired-stopped';
  }
  snapshot(): import('./types.js').SessionState {
    this.assertCurrent();
    return this.#source.snapshot();
  }
  /** Only a known-returned local continuation may begin a later explicit local operation. */
  permitsNextLocal(subject: object): boolean {
    return (
      this.owns(subject) &&
      this.#phase === 'returned' &&
      (this.#source.transport === 'local-pty' || this.#source.transport === 'local-mux')
    );
  }
}

/** Used only by the canonical StateStore, with the actual Session object. */
export function stageProviderLaunch(
  source: ProviderLaunchSource,
  write: (operation: ProviderLaunchPublication, row: ProviderLaunchIntent) => Promise<unknown>
): ProviderLaunchPublication {
  return new ProviderLaunchPublication(MINT, source, write);
}

/** A read is denial data only; unknown/malformed rows must refuse new effects. */
export function decodeProviderLaunchIntents(value: unknown): Record<string, ProviderLaunchIntent> {
  if (value === undefined) return Object.create(null) as Record<string, ProviderLaunchIntent>;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid saved provider launch intents');
  const result: Record<string, ProviderLaunchIntent> = Object.create(null) as Record<string, ProviderLaunchIntent>;
  for (const [id, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('Invalid saved provider launch intent');
    const row = candidate as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(',') !==
        'attemptId,configurationDigest,mode,owner,phase,sessionId,transport,version' ||
      row.version !== 1 ||
      row.phase !== 'dispatch-intent' ||
      row.sessionId !== id ||
      id.length < 1 ||
      id.length > 128 ||
      typeof row.attemptId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.attemptId) ||
      row.attemptId === '00000000-0000-0000-0000-000000000000' ||
      typeof row.configurationDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.configurationDigest) ||
      typeof row.mode !== 'string' ||
      row.mode.length < 1 ||
      row.mode.length > 128 ||
      !(row.owner === null || (typeof row.owner === 'string' && Buffer.byteLength(row.owner) <= 1024)) ||
      typeof row.transport !== 'string' ||
      !['local-pty', 'local-mux', 'native-ordinary', 'protected-resource', 'remote', 'docker'].includes(row.transport)
    )
      throw new Error('Invalid saved provider launch intent');
    result[id] = Object.freeze(row) as unknown as ProviderLaunchIntent;
  }
  return result;
}
