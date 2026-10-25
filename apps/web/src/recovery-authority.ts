/** Trusted bootstrap seam only. Never accept these adapters or evidence from JSON/config. */
import { buildFixedResumeMessage, type FixedResumeBinding } from './fixed-resume-message.js';
import type { RecoveryAuthority, RecoveryPermit } from './recovery-transaction.js';

export interface RecoveryMetadata extends FixedResumeBinding {
  ownerId: string;
  revision: number;
  goalState: 'ACTIVE';
  desiredRunning: boolean;
  vacation: boolean;
  sleeping: boolean;
  pendingInput: boolean;
  dialog: 'NONE';
  activeJobs: number;
  activeTurn: boolean;
  toolWait: boolean;
}
export interface ResumeGrantLease {
  readonly kind: 'RESUME_SERVICE';
  readonly ownerId: string;
  /** Authenticated dedicated principal, current elected scope and grant epoch. */
  current(employeeId: string): boolean;
}
export interface FrozenLease {
  /** Genuine current positive FROZEN predicates, not silence/CPU/busy or view enum. */
  current(metadata: Readonly<RecoveryMetadata>): boolean;
}
export interface RecoveryAuthoritySources {
  authenticate(context: unknown): Promise<ResumeGrantLease | null>;
  /** Same canonical Goal store + registry/custody as normal Goal writes. Metadata selector only.
   * Must not snapshot/clone the CompanyStore, Goal objective, evidence or private state.
   */
  read(ownerId: string, employeeId: string): unknown;
  frozen(metadata: Readonly<RecoveryMetadata>): Promise<FrozenLease | null>;
}
const fields = [
  'employeeId',
  'goalId',
  'goalGeneration',
  'sessionId',
  'sessionGeneration',
  'transitionSequence',
  'ownerId',
  'revision',
  'goalState',
  'desiredRunning',
  'vacation',
  'sleeping',
  'pendingInput',
  'dialog',
  'activeJobs',
  'activeTurn',
  'toolWait',
];
function metadata(value: unknown): Readonly<RecoveryMetadata> | null {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key)))
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!fields.every((key) => Object.hasOwn(descriptors[key]!, 'value'))) return null;
    const data = Object.fromEntries(fields.map((key) => [key, descriptors[key]!.value])) as unknown as RecoveryMetadata;
    const tuple = Object.fromEntries(fields.slice(0, 6).map((key) => [key, descriptors[key]!.value]));
    buildFixedResumeMessage(tuple); // Structural tuple check without content access.
    if (
      typeof data.ownerId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,100}$/.test(data.ownerId) ||
      /[\r\n]/.test(data.ownerId) ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 0 ||
      data.goalState !== 'ACTIVE' ||
      data.desiredRunning !== true ||
      data.vacation !== false ||
      data.sleeping !== false ||
      data.pendingInput !== false ||
      data.dialog !== 'NONE' ||
      data.activeJobs !== 0 ||
      data.activeTurn !== false ||
      data.toolWait !== false
    )
      return null;
    return Object.freeze(data);
  } catch {
    return null;
  }
}

export class CanonicalRecoveryAuthority implements RecoveryAuthority {
  constructor(private readonly sources?: RecoveryAuthoritySources) {}
  async prepare(context: unknown, employeeId: string): Promise<RecoveryPermit | null> {
    if (!this.sources) return null;
    try {
      const source = this.sources;
      const auth = await source.authenticate(context);
      if (!auth || auth.kind !== 'RESUME_SERVICE' || auth.current(employeeId) !== true) return null;
      const initial = metadata(source.read(auth.ownerId, employeeId));
      if (!initial || initial.ownerId !== auth.ownerId || initial.employeeId !== employeeId) return null;
      const proof = await source.frozen(initial);
      const current = () => {
        try {
          if (!proof || auth.current(employeeId) !== true) return false;
          const fresh = metadata(source.read(auth.ownerId, employeeId));
          return (
            !!fresh &&
            fields.every((key) => fresh[key as keyof RecoveryMetadata] === initial[key as keyof RecoveryMetadata]) &&
            proof.current(fresh) === true
          );
        } catch {
          return false;
        }
      };
      if (!current()) return null; // Recheck every await, including FROZEN evidence acquisition.
      const binding = buildFixedResumeMessage(
        Object.fromEntries(fields.slice(0, 6).map((key) => [key, initial[key as keyof RecoveryMetadata]]))
      ).binding;
      return Object.freeze({ ownerId: auth.ownerId, binding, current });
    } catch {
      return null;
    }
  }
}
