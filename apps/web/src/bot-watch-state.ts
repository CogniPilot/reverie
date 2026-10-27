/** Private typed bot state. One website writer; offline activation requires that writer stopped. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeCompanyStateFile } from './company-store.js';

export const BOT_WATCH_MAX_STATE_BYTES = 4 * 1024 * 1024;

export class BotWatchState<T> {
  private value: T;
  private unavailable = false;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly file: string,
    private schema: z.ZodType<T>,
    initial: T
  ) {
    this.value = structuredClone(initial);
  }
  async init(): Promise<void> {
    try {
      const stat = await fs.lstat(this.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > BOT_WATCH_MAX_STATE_BYTES
      )
        throw Error('Invalid bot state custody');
      this.value = this.schema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unavailable = true;
        throw Error('Bot state unavailable; preserved for reconciliation');
      }
    }
    try {
      await this.validateArchive();
    } catch {
      this.unavailable = true;
      throw Error('Bot history unavailable; preserve ledger for reconciliation');
    }
  }
  private async validateArchive(): Promise<void> {
    let fd;
    try {
      fd = await fs.open(
        this.file + '.history.jsonl',
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const before = await fd.stat();
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        before.nlink !== 1 ||
        before.mode & 0o077 ||
        before.size > 256 * 1024 * 1024
      )
        throw Error('History custody or bound');
      const chunk = Buffer.alloc(65536);
      let pending = Buffer.alloc(0),
        total = 0;
      for (;;) {
        const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > 256 * 1024 * 1024) throw Error('History byte bound');
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let end;
        while ((end = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, end),
            text = new TextDecoder('utf-8', { fatal: true }).decode(line);
          if (line.length > 2 * 1024 * 1024) throw Error('History record bound');
          const value = JSON.parse(text);
          if (
            !value ||
            typeof value !== 'object' ||
            Object.keys(value).sort().join(',') !== 'record,version' ||
            value.version !== 1 ||
            JSON.stringify(value) !== text
          )
            throw Error('History framing differs');
          pending = pending.subarray(end + 1);
        }
        if (pending.length > 2 * 1024 * 1024) throw Error('History tail bound');
      }
      const after = await fd.stat(),
        named = await fs.lstat(this.file + '.history.jsonl');
      if (
        pending.length ||
        total !== before.size ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.dev !== named.dev ||
        after.ino !== named.ino
      )
        throw Error('History partial or changed');
    } finally {
      await fd.close();
    }
  }
  snapshot(): T {
    if (this.unavailable) throw Error('Bot state unavailable');
    return structuredClone(this.value);
  }
  /** Fsync history before compaction. A crash may repeat an ID, never discard an unarchived record. */
  async archive(records: readonly unknown[]): Promise<void> {
    if (!records.length) return;
    this.snapshot();
    try {
      await this.validateArchive();
      const raw = records.map((record) => JSON.stringify({ version: 1, record }) + '\n').join('');
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw Error('Bot history batch bound');
      const fd = await fs.open(
        this.file + '.history.jsonl',
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600
      );
      try {
        const st = await fd.stat();
        if (
          !st.isFile() ||
          st.uid !== process.getuid?.() ||
          st.nlink !== 1 ||
          st.mode & 0o077 ||
          st.size + Buffer.byteLength(raw) > 256 * 1024 * 1024
        )
          throw Error('Bot history unavailable; preserved');
        await fd.writeFile(raw);
        await fd.sync();
      } finally {
        await fd.close();
      }
      const parent = await fs.open(dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch {
      this.unavailable = true;
      throw Error('Bot archive outcome unconfirmed; preserve live ledger and history');
    }
  }
  update(change: (next: T) => void, beforeCommit: () => void = () => {}): Promise<void> {
    const run = this.chain.then(async () => {
      const next = this.snapshot();
      const guard = () => { if (beforeCommit() !== undefined) throw Error('Synchronous bot authority guard required'); };
      guard();
      change(next);
      const published = structuredClone(this.schema.parse(next));
      const raw = JSON.stringify(published);
      if (Buffer.byteLength(raw, 'utf8') > BOT_WATCH_MAX_STATE_BYTES)
        throw Error('Bot state byte bound; prior state preserved');
      try {
        await writeCompanyStateFile(this.file, raw, guard);
        this.value = published;
      } catch {
        this.unavailable = true;
        throw Error('Bot state outcome unconfirmed; no further effects');
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** Only a synchronous pre-post admission refusal; never used for ambiguous post/save errors. */
export class BotWatchPostRefused extends Error {}
