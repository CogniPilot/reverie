/** Lost-acknowledgment faults after actual owned FileHandle operations.
 * No native actor, host registration, authority substitute or clock control. */
import { promises as filesystem } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';

const password = 'Synthetic-durable-registration-fixture-42!';
let directory: string, store: OwnerAuthStore, auth: OwnerAuthService, legacy: string;

beforeEach(async () => {
  directory = await filesystem.mkdtemp(join(tmpdir(), 'owner-registration-write-'));
  store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  auth = new OwnerAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  const first = await auth.setup('fixture-owner', password, password, '127.0.0.1');
  await store.update((account) => {
    delete account.accountId;
  });
  auth.logout(first);
  legacy = (await auth.login('fixture-owner', password, '127.0.0.1')).session!;
  expect(store.readCurrent()!.accountId).toBeUndefined();
});

afterEach(async () => {
  vi.restoreAllMocks();
  auth?.logout(legacy);
  await filesystem.rm(directory, { recursive: true, force: true });
});

type Failure = 'write' | 'sync' | 'close' | 'write+close' | 'marker-sync' | 'parent-sync';

/** Inject only after the selected real operation has completed; the exact
 * original error objects let the test distinguish preserved body/close causes. */
function lostAcknowledgment(failure: Failure) {
  const body = new Error('owned-registration-' + failure);
  const closeFailure = new Error('owned-registration-consuming-close');
  const events: string[] = [];
  const handles: FileHandle[] = [];
  const restore: Array<() => void> = [];
  const actualOpen = filesystem.open.bind(filesystem);
  const opened = vi
    .spyOn(filesystem, 'open')
    .mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await actualOpen(...args);
      const name = typeof args[0] === 'string' ? args[0] : '';
      const selected =
        failure === 'parent-sync'
          ? name === directory && args[1] === 'r'
          : args[1] === 'wx' &&
            name.endsWith('.tmp') &&
            name.startsWith((failure === 'marker-sync' ? store.markerFile : store.file) + '.');
      if (!selected) return handle;
      handles.push(handle);
      const write = handle.writeFile.bind(handle),
        sync = handle.sync.bind(handle),
        close = handle.close.bind(handle);
      try {
        const writer = vi
          .spyOn(handle, 'writeFile')
          .mockImplementation(async (...data: Parameters<typeof handle.writeFile>) => {
            await write(...data);
            events.push('write');
            if (failure === 'write' || failure === 'write+close') throw body;
          });
        restore.push(() => writer.mockRestore());
        const synced = vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          events.push('sync');
          if (failure === 'sync' || failure === 'marker-sync' || failure === 'parent-sync') throw body;
        });
        restore.push(() => synced.mockRestore());
        const closed = vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          events.push('close');
          if (failure === 'close' || failure === 'write+close') throw closeFailure;
        });
        restore.push(() => closed.mockRestore());
        return handle;
      } catch (cause) {
        // The caller never received this descriptor if hook setup failed.
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Fixture setup and native close both failed');
        }
        throw cause;
      }
    });
  return {
    body,
    closeFailure,
    events,
    handles,
    restore: () => {
      opened.mockRestore();
      for (const close of restore) close();
    },
  };
}

it.each(['write', 'sync', 'close', 'write+close'] as const)(
  'retains the canonical account and unavailable legacy registration after actual tempfile %s lost acknowledgment',
  async (failure) => {
    const original = await filesystem.readFile(store.file, 'utf8');
    const fault = lostAcknowledgment(failure);
    let error: unknown;
    try {
      await auth.enrollRegistrationIdentity(legacy);
    } catch (cause) {
      error = cause;
    } finally {
      fault.restore();
    }
    expect(fault.handles).toHaveLength(1);
    expect(fault.handles[0]!.fd).toBe(-1);
    expect(fault.events.filter((event) => event === 'close')).toHaveLength(1);
    expect(fault.events).toContain('write');
    if (failure === 'sync' || failure === 'close') expect(fault.events).toContain('sync');
    if (failure === 'write+close') {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([fault.body, fault.closeFailure]);
    } else expect(error).toBe(failure === 'close' ? fault.closeFailure : fault.body);
    expect(await filesystem.readFile(store.file, 'utf8')).toBe(original);
    expect(store.readCurrent()!.accountId).toBeUndefined();
    expect(auth.identity(legacy)).toMatchObject({ id: 'owner', role: 'owner' });
    expect(() => auth.registrationIdentity(legacy)).toThrow();
  }
);

it.each(['marker-sync', 'parent-sync'] as const)(
  'cannot adopt an actually published UUID after post-rename %s lost acknowledgment',
  async (failure) => {
    const original = store.readCurrent()!;
    const fault = lostAcknowledgment(failure);
    let error: unknown;
    try {
      await auth.enrollRegistrationIdentity(legacy);
    } catch (cause) {
      error = cause;
    } finally {
      fault.restore();
    }
    expect(error).toBe(fault.body);
    expect(fault.handles).toHaveLength(1);
    expect(fault.handles[0]!.fd).toBe(-1);
    expect(fault.events).toContain('sync');
    expect(fault.events.filter((event) => event === 'close')).toHaveLength(1);
    const published = store.readCurrent()!;
    expect(published.accountId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    expect(published).toEqual({ ...original, accountId: published.accountId });
    const raw = await filesystem.readFile(store.file, 'utf8');
    expect(() => auth.registrationIdentity(legacy)).toThrow();
    await expect(auth.enrollRegistrationIdentity(legacy)).rejects.toThrow();
    expect(await filesystem.readFile(store.file, 'utf8')).toBe(raw);
    const fresh = (await auth.login('fixture-owner', password, '127.0.0.1')).session!;
    try {
      expect(auth.registrationIdentity(fresh).accountId).toBe(published.accountId);
      expect(() => auth.registrationIdentity(legacy)).toThrow();
      await expect(auth.enrollRegistrationIdentity(legacy)).rejects.toThrow();
    } finally {
      auth.logout(fresh);
    }
  }
);
