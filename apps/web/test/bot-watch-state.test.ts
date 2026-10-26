import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BotWatchState, BOT_WATCH_MAX_STATE_BYTES } from '../src/bot-watch-state.js';
import { AssignmentWatchStateSchema } from '../src/assignment-status-watch.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.length = 0;
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-byte-control-'));
  roots.push(root);
  return path.join(root, 'watch.json');
}
describe('bot journal byte admission and archive uncertainty', () => {
  it('schema-valid6MiB update refuses before publication/effect; priorbytes+inode reopen and ordinaryupdate remain valid', async () => {
    const file = await fixture(),
      initial = { version: 1 as const, entries: [], posts: [] };
    const store = new BotWatchState(file, AssignmentWatchStateSchema, initial);
    await store.init();
    await store.update(() => {});
    const before = await fs.readFile(file),
      info = await fs.stat(file);
    const response = {
      messageId: 'owned',
      at: 1,
      status: 'blocked' as const,
      reason: 'x'.repeat(500),
      applied: true,
      planApplied: false,
    };
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: randomUUID(),
      taskId: 'task' + i,
      employeeId: 'employee',
      sessionId: 'sid',
      generation: 1,
      roomId: 'room',
      createdAt: 1,
      deadline: 2,
      priorStatus: 'doing',
      phase: 'answered' as const,
      response,
      history: Array.from({ length: 100 }, () => ({ ...response })),
      attentionPending: false,
    }));
    AssignmentWatchStateSchema.parse({ ...initial, entries });
    let effects = 0;
    await expect(
      (async () => {
        await store.update((s) => {
          s.entries = entries;
        });
        effects++;
      })()
    ).rejects.toThrow('byte bound');
    expect(effects).toBe(0);
    expect(await fs.readFile(file)).toEqual(before);
    expect((await fs.stat(file)).ino).toBe(info.ino);
    const reopened = new BotWatchState(file, AssignmentWatchStateSchema, initial);
    await reopened.init();
    expect(reopened.snapshot().entries).toHaveLength(0);
    await store.update((s) => {
      s.posts = [1];
    });
    expect(store.snapshot().posts).toEqual([1]);
  });
  it('accepts exact byte limit and refuses one additional byte with no inode change', async () => {
    const file = await fixture(),
      schema = z.object({ payload: z.string() }).strict(),
      store = new BotWatchState(file, schema, { payload: '' });
    await store.init();
    const overhead = Buffer.byteLength(JSON.stringify({ payload: '' }));
    await store.update((s) => {
      s.payload = 'a'.repeat(BOT_WATCH_MAX_STATE_BYTES - overhead);
    });
    expect((await fs.stat(file)).size).toBe(BOT_WATCH_MAX_STATE_BYTES);
    const info = await fs.stat(file);
    await expect(
      store.update((s) => {
        s.payload += 'x';
      })
    ).rejects.toThrow('byte bound');
    expect((await fs.stat(file)).ino).toBe(info.ino);
    const reopen = new BotWatchState(file, schema, { payload: '' });
    await reopen.init();
    expect(Buffer.byteLength(JSON.stringify(reopen.snapshot()))).toBe(BOT_WATCH_MAX_STATE_BYTES);
  });
  it('uses UTF8 byte count rather than Javascript character count', async () => {
    const file = await fixture(),
      schema = z.object({ payload: z.string() }).strict(),
      store = new BotWatchState(file, schema, { payload: '' });
    await store.init();
    await store.update(() => {});
    await expect(
      store.update((s) => {
        s.payload = '💡'.repeat(BOT_WATCH_MAX_STATE_BYTES / 4);
      })
    ).rejects.toThrow('byte bound');
    expect(store.snapshot().payload).toBe('');
  });
  it('partial archive failure latches current instance and restart; live ledger and partialbytes are preserved', async () => {
    const file = await fixture(),
      schema = z.object({ version: z.literal(1), items: z.array(z.string()) }).strict(),
      initial = { version: 1 as const, items: ['one', 'two'] },
      store = new BotWatchState(file, schema, initial);
    await store.init();
    await store.update(() => {});
    const before = await fs.readFile(file),
      real = fs.open.bind(fs);
    let once = true;
    vi.spyOn(fs, 'open').mockImplementation((async (p: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
      const fd = await (real as (...a: unknown[]) => ReturnType<typeof fs.open>)(p, ...args);
      if (String(p).endsWith('.history.jsonl') && once) {
        once = false;
        return new Proxy(fd, {
          get(target, key) {
            if (key === 'writeFile')
              return async (raw: unknown) => {
                await target.write(String(raw).slice(0, 10));
                throw Error('owned partial append');
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return fd;
    }) as typeof fs.open);
    await expect(store.archive([{ id: 'one' }, { id: 'two' }])).rejects.toThrow('unconfirmed');
    vi.restoreAllMocks();
    const partial = await fs.readFile(file + '.history.jsonl');
    expect(() => store.snapshot()).toThrow('unavailable');
    await expect(store.archive([{ id: 'one' }, { id: 'two' }])).rejects.toThrow('unavailable');
    expect(await fs.readFile(file + '.history.jsonl')).toEqual(partial);
    expect(await fs.readFile(file)).toEqual(before);
    const reopened = new BotWatchState(file, schema, initial);
    await expect(reopened.init()).rejects.toThrow('history unavailable');
    expect(await fs.readFile(file)).toEqual(before);
  });
  it('published state is isolated from retained constructor and update references', async () => {
    const file = await fixture(),
      schema = z.object({ payload: z.object({ value: z.string() }) }).strict(),
      initial = { payload: { value: 'initial' } };
    const store = new BotWatchState(file, schema, initial);
    initial.payload.value = 'mutated-outside';
    await store.init();
    expect(store.snapshot().payload.value).toBe('initial');
    let retained: typeof initial | undefined;
    const external = { value: 'published' };
    await store.update((s) => {
      s.payload = external;
      retained = s;
    });
    external.value = 'leaked';
    retained!.payload.value = 'also-leaked';
    expect(store.snapshot().payload.value).toBe('published');
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.payload.value).toBe('published');
  });
  it('fully acknowledged framed archive reopens and permits normal further append', async () => {
    const file = await fixture(),
      schema = z.object({ version: z.literal(1) }),
      store = new BotWatchState(file, schema, { version: 1 });
    await store.init();
    await store.update(() => {});
    await store.archive([{ id: 'one' }]);
    const reopened = new BotWatchState(file, schema, { version: 1 });
    await reopened.init();
    await reopened.archive([{ id: 'two' }]);
    const rows = (await fs.readFile(file + '.history.jsonl', 'utf8'))
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x).record.id);
    expect(rows).toEqual(['one', 'two']);
  });
});
