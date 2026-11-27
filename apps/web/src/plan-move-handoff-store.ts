/**
 * @fileoverview The record of handoffs the office typed for plan moves that were closed before the move typed them.
 *
 * A plan move types its handoff into the new session once and records that in its own journal first. A move that is
 * closed after it switched the employee to the new session, and before that, has a journal nobody may write any
 * more, so the same record is kept here: `issued` before the text is typed, `delivered` once the terminal confirmed
 * it. An entry that stays `issued` is a handoff whose outcome is not known, and it is never typed again.
 *
 * `since` is when this office first kept the record. A move that was closed before then is none of its business:
 * nobody may type a handoff into a session weeks after the fact because a new version of the office found an old
 * journal. A file that cannot be read says nothing, and then nothing is typed.
 */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const time = z.number().int().nonnegative().safe();
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const Entry = z
  .object({
    employeeId: id,
    sessionId: id,
    /** Digest of the exact bytes that were typed; see `dockerPlanMoveHandoffDigest`. */
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(['issued', 'delivered']),
    at: time,
  })
  .strict();
const File = z
  .object({
    version: z.literal(1),
    purpose: z.literal('plan-move-handoffs-v1'),
    since: time,
    moves: z.record(id, Entry),
  })
  .strict();
const MAX_BYTES = 1024 * 1024;

export type PlanMoveHandoffEntry = z.infer<typeof Entry>;
export interface PlanMoveHandoffRecord {
  readonly since: number;
  readonly moves: ReadonlyMap<string, PlanMoveHandoffEntry>;
}

export class PlanMoveHandoffStore {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The whole record, or undefined when it cannot be read. A file that does not exist yet is created now, so that
   * `since` is the moment this office began to keep it.
   */
  read(): PlanMoveHandoffRecord | undefined {
    try {
      if (!fs.existsSync(this.file))
        this.#write({ version: 1, purpose: 'plan-move-handoffs-v1', since: this.now(), moves: {} });
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      const parsed = File.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      return { since: parsed.since, moves: new Map(Object.entries(parsed.moves)) };
    } catch {
      return undefined;
    }
  }

  /**
   * Record one step of one handoff and read it back. Throws when the record cannot be read, written or confirmed:
   * the caller types nothing without `issued` on record. `delivered` is only ever written over the same `issued`.
   */
  record(moveId: string, entry: PlanMoveHandoffEntry): void {
    const current = this.read();
    if (!current) throw new Error('The handoff record cannot be read');
    const before = current.moves.get(moveId);
    if (entry.phase === 'issued' ? before !== undefined : before?.phase !== 'issued' || before.digest !== entry.digest)
      throw new Error('The handoff record already says otherwise');
    this.#write({
      version: 1,
      purpose: 'plan-move-handoffs-v1',
      since: current.since,
      moves: { ...Object.fromEntries(current.moves), [id.parse(moveId)]: Entry.parse(entry) },
    });
    const after = this.read()?.moves.get(moveId);
    if (!after || after.phase !== entry.phase || after.digest !== entry.digest)
      throw new Error('The handoff record did not keep the entry');
  }

  #write(content: z.infer<typeof File>): void {
    const body = JSON.stringify(File.parse(content));
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
