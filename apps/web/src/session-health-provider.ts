/** Read-only projection of canonical server records. Never reads Session terminal/display state. */
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const sessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const state = z.enum(['READY', 'ASSIGNED', 'ACTIVE', 'HOLD', 'REVIEW', 'DONE', 'NO_GO', 'CANCELLED']);
const employee = z.object({
  id,
  owner: z.string().optional(),
  sessionId,
  sessionGeneration: positive.optional(),
  desiredRunning: z.boolean().optional(),
  onVacation: z.boolean().optional(),
  bindingMigration: z.unknown().optional(),
});
const goal = z.object({
  id,
  employeeId: id,
  owner: z.string().optional(),
  sessionId,
  sessionGeneration: positive,
  generation: positive,
  state,
  transitionSequence: integer,
  semanticProgressAt: integer,
  updatedAt: integer,
  transitions: z
    .array(
      z.object({
        sequence: positive,
        generation: positive,
        after: z.object({
          sessionId,
          sessionGeneration: positive,
          generation: positive,
          state,
          transitionSequence: integer,
          semanticProgressAt: integer,
          updatedAt: integer,
        }),
      })
    )
    .max(256),
});
/** Purpose-distinct metadata interface. NOT Goal authentication, signing or action authority. */
export interface CanonicalHealthBindingReader {
  metadataBinding(sessionId: string):
    | {
        readonly owner?: string;
        readonly employeeId: string;
        readonly sessionId: string;
        readonly sessionGeneration: number;
      }
    | undefined;
}
export interface HealthMetadataPorts {
  authority?: CanonicalHealthBindingReader;
  /** Actual canonical CompanyStore fixed scalar projection. Never a full snapshot/reload. */
  canonical(): { employees: readonly unknown[]; goals?: readonly unknown[] };
  /** Only fixed scalar registry metadata; do not call toState/isRunning or inspect terminal content. */
  session(id: string): { id: string; owner?: string } | undefined;
  now?: () => number;
}
export type HealthMetadata = ReturnType<ServerHealthMetadataProvider['read']>;
export class ServerHealthMetadataProvider {
  private sequence = 0;
  constructor(private readonly ports: HealthMetadataPorts) {}
  read(target: string) {
    const now = (this.ports.now ?? Date.now)();
    if (!sessionId.safeParse(target).success || !integer.safeParse(now).success)
      throw Error('HEALTH_METADATA_UNAVAILABLE');
    const authority = this.ports.authority;
    const binding = authority?.metadataBinding(target);
    if (
      !binding ||
      binding.sessionId !== target ||
      !positive.safeParse(binding.sessionGeneration).success ||
      !id.safeParse(binding.employeeId).success
    )
      throw Error('HEALTH_BINDING_UNAVAILABLE');
    const runtime = this.ports.session(target);
    if (!runtime || runtime.id !== target) throw Error('HEALTH_METADATA_UNAVAILABLE');
    const select = () => {
      const canonical = this.ports.canonical();
      if (canonical.employees.length > 1024 || (canonical.goals?.length ?? 0) > 4096)
        throw Error('HEALTH_METADATA_UNAVAILABLE');
      // Select raw identity first: invalid/duplicate records cannot silently disappear through parsing.
      const matches = canonical.employees.filter(
        (value) =>
          value !== null && typeof value === 'object' && (value as { sessionId?: unknown }).sessionId === target
      );
      if (matches.length !== 1) throw Error('HEALTH_METADATA_UNAVAILABLE');
      const e = employee.parse(matches[0]);
      if (
        e.owner !== runtime.owner ||
        e.owner !== binding.owner ||
        e.id !== binding.employeeId ||
        e.sessionGeneration !== binding.sessionGeneration ||
        e.bindingMigration !== undefined
      )
        throw Error('HEALTH_METADATA_UNAVAILABLE');
      if (
        canonical.employees.filter(
          (value) => value !== null && typeof value === 'object' && (value as { id?: unknown }).id === e.id
        ).length !== 1
      )
        throw Error('HEALTH_METADATA_UNAVAILABLE');
      const candidates = (canonical.goals ?? []).filter(
        (value) =>
          value !== null &&
          typeof value === 'object' &&
          (value as { employeeId?: unknown }).employeeId === e.id &&
          !['DONE', 'NO_GO', 'CANCELLED'].includes(String((value as { state?: unknown }).state))
      );
      // No newest-goal election: ambiguous/malformed bindings remain unknown.
      const parsed = candidates.length === 1 ? goal.safeParse(candidates[0]) : undefined;
      const g =
        parsed?.success &&
        e.sessionGeneration !== undefined &&
        parsed.data.owner === e.owner &&
        parsed.data.sessionId === target &&
        parsed.data.sessionGeneration === e.sessionGeneration
          ? parsed.data
          : undefined;
      return { e, g };
    };
    const { e, g } = select();
    const receipt = g?.transitions.at(-1);
    const progress =
      g &&
      receipt &&
      receipt.sequence === g.transitionSequence &&
      receipt.generation === g.generation &&
      receipt.after.sessionId === target &&
      receipt.after.sessionGeneration === e.sessionGeneration &&
      receipt.after.generation === g.generation &&
      receipt.after.state === g.state &&
      receipt.after.transitionSequence === g.transitionSequence &&
      receipt.after.semanticProgressAt === g.semanticProgressAt &&
      receipt.after.updatedAt === g.updatedAt &&
      g.updatedAt <= now &&
      g.semanticProgressAt <= g.updatedAt &&
      now - g.semanticProgressAt <= 30000
        ? g.semanticProgressAt
        : null;
    const current = authority?.metadataBinding(target);
    const after = select();
    if (JSON.stringify(after.e) !== JSON.stringify(e) || JSON.stringify(after.g) !== JSON.stringify(g))
      throw Error('HEALTH_METADATA_UNAVAILABLE');
    if (
      this.ports.authority !== authority ||
      this.ports.session(target) !== runtime ||
      !current ||
      current.employeeId !== binding.employeeId ||
      current.sessionId !== binding.sessionId ||
      current.sessionGeneration !== binding.sessionGeneration ||
      current.owner !== binding.owner
    )
      throw Error('HEALTH_METADATA_UNAVAILABLE');
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw Error('HEALTH_METADATA_UNAVAILABLE');
    return {
      schema_version: 1 as const,
      sequence: ++this.sequence,
      observedAtMs: now,
      employeeId: e.id,
      sessionId: target,
      sessionGeneration: e.sessionGeneration ?? null,
      intent:
        e.onVacation === true
          ? 'VACATION'
          : e.desiredRunning === false
            ? 'STOPPED'
            : e.desiredRunning === true
              ? 'RUNNING'
              : 'UNKNOWN',
      goal: g
        ? {
            id: g.id,
            generation: g.generation,
            sessionId: g.sessionId,
            sessionGeneration: g.sessionGeneration,
            state: g.state,
            transitionSequence: g.transitionSequence,
          }
        : null,
      semanticProgressAtMs: progress,
      progressSource: progress === null ? 'UNKNOWN' : 'CANONICAL_GOAL_RECEIPT',
      // Registry presence, spinner/PTY bytes and a PID do not establish any of these signals.
      process: 'UNKNOWN',
      activity: 'UNKNOWN',
      pending: 'UNKNOWN',
      phase: 'UNKNOWN',
      trackedJob: null,
      classification: 'AMBIGUOUS',
      reason: 'UNKNOWN_METADATA',
      automaticAction: 'NONE',
    } as const;
  }
}
