/** Versioned own-attention metadata. This store never reads or changes delivery state. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  fstatSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ChatroomError, type ChatMessage } from './chatroom-store.js';

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({ roomId: id, messageId: id, digest }).strict();
const recipientSchema = z.object({ owner: id.nullable(), kind: z.enum(['employee', 'session']), id }).strict();
const recordSchema = z
  .object({
    recipient: recipientSchema,
    source: sourceSchema,
    disposition: z.enum(['handled', 'superseded']),
    recordedAt: z.number().finite().nonnegative(),
    proof: z.object({ kind: z.literal('exact-read'), receiptDigest: digest }).strict(),
    replacement: sourceSchema.optional(),
  })
  .strict()
  .refine((r) => (r.disposition === 'superseded') === !!r.replacement);
const MAX_RECORDS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const schema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(MAX_RECORDS) }).strict();

export type NoticeSource = z.infer<typeof sourceSchema>;
export type NoticeRecipient = z.infer<typeof recipientSchema>;
export type NoticeRecord = z.infer<typeof recordSchema>;
export interface NoticeAttention {
  disposition: 'pending' | 'handled' | 'superseded';
  proof?: { kind: 'linked-reply'; reply: NoticeSource } | { kind: 'exact-read'; recordedAt: number };
  replacement?: NoticeSource;
}

/** Canonical JSON keys; delivery bookkeeping, votes, reactions and pinning are not source edits. */
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}

export function noticeDigest(message: ChatMessage): string {
  const { id, roomId, at, from, to, text, edited, deleted, replyTo, attachments, audioUrl, voice, spoken, poll } =
    message;
  return createHash('sha256')
    .update(
      canonical({
        version: 1,
        id,
        roomId,
        at,
        from,
        to,
        text,
        edited,
        deleted,
        replyTo,
        attachments,
        audioUrl,
        voice,
        spoken,
        poll: poll && {
          question: poll.question,
          options: poll.options,
          multi: poll.multi,
          closesAt: poll.closesAt,
          recommended: poll.recommended,
        },
      })
    )
    .digest('hex');
}

const key = (recipient: NoticeRecipient, roomId: string, messageId: string) =>
  canonical([recipient, roomId, messageId]);

export class ChatroomNoticeState {
  private records: NoticeRecord[] = [];
  private index = new Map<string, NoticeRecord[]>();
  private closed = false;

  get available(): boolean {
    return !this.closed;
  }

  constructor(private readonly file: string | undefined) {
    if (!file) return;
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: string;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Notice state exceeds bound');
        raw = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
      this.records = schema.parse(JSON.parse(raw)).records;
      this.reindex();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.closed = true;
      // Preserve invalid state untouched. Reads show pending and writes refuse until repaired.
    }
  }

  private reindex(): void {
    this.index.clear();
    for (const record of this.records) {
      const k = key(record.recipient, record.source.roomId, record.source.messageId);
      const rows = this.index.get(k) ?? [];
      rows.push(record);
      this.index.set(k, rows);
    }
  }

  /** A detached metadata snapshot only; the service revalidates source and access on every use. */
  forSource(recipient: NoticeRecipient, roomId: string, messageId: string): NoticeRecord[] {
    return this.closed ? [] : structuredClone(this.index.get(key(recipient, roomId, messageId)) ?? []);
  }

  /** Synchronous validation/rename is one event-loop commit boundary; never evict older records. */
  commit(input: NoticeRecord, validateCurrent: () => void): NoticeRecord {
    if (this.closed) throw new ChatroomError('Notice state is unavailable; existing file preserved', 'UNAVAILABLE');
    const record = recordSchema.parse(input);
    validateCurrent();
    const previous = this.forSource(record.recipient, record.source.roomId, record.source.messageId).at(-1);
    if (
      previous &&
      canonical({ ...previous, recordedAt: 0, proof: undefined }) ===
        canonical({ ...record, recordedAt: 0, proof: undefined })
    )
      return previous;
    if (this.records.length >= MAX_RECORDS)
      throw new ChatroomError('Notice state is full; no history was evicted', 'UNAVAILABLE');
    const next = [...this.records, record];
    const bytes = JSON.stringify({ version: 1, records: next }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES)
      throw new ChatroomError('Notice state is full; no history was evicted', 'UNAVAILABLE');
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      let renamed = false;
      try {
        const fd = openSync(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        validateCurrent();
        renameSync(tmp, this.file);
        renamed = true;
        const dir = openSync(dirname(this.file), constants.O_RDONLY);
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      } catch (error) {
        if (!renamed) {
          try {
            unlinkSync(tmp);
          } catch {
            /* Only this uncommitted temporary file. */
          }
        } else this.closed = true; // Commit uncertainty must not be reported as success or suppress attention.
        if (error instanceof ChatroomError) throw error;
        throw new ChatroomError('Notice state could not be durably committed', 'UNAVAILABLE');
      }
    }
    this.records = next;
    this.reindex();
    return structuredClone(record);
  }
}
