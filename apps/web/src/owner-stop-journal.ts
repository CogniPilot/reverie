/**
 * @fileoverview Durable record of owner stops the laptop has not settled yet.
 *
 * An owner recovery asks the laptop to stop an agent and holds the agent's input until it knows whether the stop ran. When
 * the answer is lost, an exec the laptop accepted can still signal later, and a website restart must not give the input
 * back in the meantime. So the stop is written here (fsync'd) before the request goes out, and removed only once it is
 * settled. Every Session refuses input while its id has a record (see Session.write/writeViaMux), however the Session
 * object was rebuilt, and startup resumes settling each record (WebServer.start, settleOwnerStop).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from './config/instance.js';

export interface PendingOwnerStop { fence: string; notAfter: number }

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FENCE = /^[0-9a-f]{32}$/;
const pending = new Map<string, PendingOwnerStop>();
let configured: string | undefined;
let loadedFrom: string | undefined;

const directory = () => configured ?? join(getDataDir(), 'owner-stops');

function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Reads the records once per directory. A record that cannot be read still holds its session (with no fence to settle).
 * A directory that cannot be listed proves nothing, so it holds every session (retried on the next check) and never throws.
 */
function load(): string | undefined {
  const dir = directory();
  if (loadedFrom === dir) return dir;
  pending.clear();
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { console.error('[owner-stop] stop records unreadable; holding input:', error); return undefined; }
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!ID.test(id)) continue;
    let stop: PendingOwnerStop = { fence: '', notAfter: 0 };
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<PendingOwnerStop>;
      if (typeof raw.fence === 'string' && FENCE.test(raw.fence) && Number.isSafeInteger(raw.notAfter)) stop = { fence: raw.fence, notAfter: raw.notAfter! };
    } catch { /* unreadable: still held */ }
    pending.set(id, stop);
  }
  loadedFrom = dir;
  return dir;
}

/** Tests: use this directory (and read it afresh, as a restarted website would). */
export function useOwnerStopJournal(dir?: string): void {
  configured = dir;
  loadedFrom = undefined;
}

export function ownerStopPending(sessionId: string): boolean {
  return load() === undefined || pending.has(sessionId);
}

export function pendingOwnerStops(): Array<[string, PendingOwnerStop]> {
  load();
  return [...pending.entries()];
}

function loaded(): string {
  const dir = load();
  if (dir === undefined) throw new Error('Owner stop records are unreadable');
  return dir;
}

/** Durably records a stop before it is requested; throws if it cannot, and then nothing may be requested. */
export function recordOwnerStop(sessionId: string, stop: PendingOwnerStop): void {
  if (!ID.test(sessionId) || !FENCE.test(stop.fence) || !Number.isSafeInteger(stop.notAfter)) throw new Error('Invalid owner stop record');
  const dir = loaded();
  // One level only: its parent is the data directory (or a test's own directory); a recursive mkdir can spin on an odd path.
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const file = join(dir, `${sessionId}.json`), temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(stop)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(dir);
  pending.set(sessionId, { ...stop });
}

/**
 * Removes the record once its stop is settled. Only the same stop's fence removes it. If it cannot be removed, it stays
 * (and keeps holding input) and this returns false.
 */
export function clearOwnerStop(sessionId: string, fence: string): boolean {
  const dir = load();
  if (dir === undefined) return false;
  const current = pending.get(sessionId);
  if (!current || current.fence !== fence) return false;
  try {
    unlinkSync(join(dir, `${sessionId}.json`));
    syncDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { console.error('[owner-stop] could not clear a settled stop record:', error); return false; }
  }
  pending.delete(sessionId);
  return true;
}
