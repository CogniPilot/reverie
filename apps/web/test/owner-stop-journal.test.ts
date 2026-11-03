/** The durable record of unsettled owner stops: what holds a session's input across a website restart. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearOwnerStop, ownerStopPending, pendingOwnerStops, recordOwnerStop, useOwnerStopJournal } from '../src/owner-stop-journal.js';

const FENCE = '0123456789abcdef0123456789abcdef';
let root = '', dir = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'owner-stops-')); dir = join(root, 'owner-stops'); useOwnerStopJournal(dir); });
afterEach(() => { useOwnerStopJournal(); rmSync(root, { recursive: true, force: true }); });

describe('owner stop journal', () => {
  it('keeps a recorded stop across a fresh read of the directory, as after a restart', () => {
    expect(ownerStopPending('session-1')).toBe(false);
    recordOwnerStop('session-1', { fence: FENCE, notAfter: 1_793_400_000_000 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'session-1.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['session-1.json']); // no temporary file left behind
    useOwnerStopJournal(dir);
    expect(ownerStopPending('session-1')).toBe(true);
    expect(pendingOwnerStops()).toEqual([['session-1', { fence: FENCE, notAfter: 1_793_400_000_000 }]]);
  });

  it('is cleared only by the same stop, and then stays cleared after a restart', () => {
    recordOwnerStop('session-1', { fence: FENCE, notAfter: 1 });
    expect(clearOwnerStop('session-1', 'f'.repeat(32))).toBe(false);
    expect(ownerStopPending('session-1')).toBe(true);
    expect(clearOwnerStop('session-1', FENCE)).toBe(true);
    useOwnerStopJournal(dir);
    expect(ownerStopPending('session-1')).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('still holds a session whose record cannot be read, with no fence to settle', () => {
    recordOwnerStop('session-1', { fence: FENCE, notAfter: 1 });
    writeFileSync(join(dir, 'session-1.json'), '{not json');
    useOwnerStopJournal(dir);
    expect(pendingOwnerStops()).toEqual([['session-1', { fence: '', notAfter: 0 }]]);
  });

  it('refuses a record it could not settle or name safely', () => {
    for (const [id, stop] of [['../escape', { fence: FENCE, notAfter: 1 }], ['session-1', { fence: 'short', notAfter: 1 }],
      ['session-1', { fence: FENCE, notAfter: 1.5 }]] as const)
      expect(() => recordOwnerStop(id, stop)).toThrow('Invalid owner stop record');
    expect(ownerStopPending('session-1')).toBe(false);
  });

  it('holds every session, without throwing, while its directory cannot be listed', () => {
    writeFileSync(dir, 'not a directory');  // readdir fails with ENOTDIR, not ENOENT
    useOwnerStopJournal(dir);
    expect(ownerStopPending('any-session')).toBe(true);
    expect(clearOwnerStop('any-session', FENCE)).toBe(false);
    expect(() => recordOwnerStop('any-session', { fence: FENCE, notAfter: 1 })).toThrow('unreadable');
    rmSync(dir);
    expect(ownerStopPending('any-session')).toBe(false);  // retried on the next check, once listing works
  });

  it('throws, without hanging, when its directory cannot be created', () => {
    useOwnerStopJournal('/proc/reverie-owner-stops-cannot-exist');
    expect(() => recordOwnerStop('session-1', { fence: FENCE, notAfter: 1 })).toThrow();
    expect(ownerStopPending('session-1')).toBe(false);
  });
});
