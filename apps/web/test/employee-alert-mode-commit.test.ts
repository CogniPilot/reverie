import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EMPLOYEE_ALERT_MODE, EmployeeAlertModes, MAX_ALERT_LEASE_MS } from '../src/employee-alert-mode.js';

// Fails the rename onto one chosen file, as a full or read-only disk would; every other file
// operation is real.
const failing = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (failing.target && to === failing.target)
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return fs.renameSync(from, to);
    },
  };
});

afterEach(() => {
  failing.target = '';
  vi.restoreAllMocks();
});

const start = 1000000;

/** An owner preference of Vibrate, then the employee's own Ring lease for an hour. */
function prepared() {
  let now = start;
  const dir = mkdtempSync(join(tmpdir(), 'alert-commit-'));
  const leases = join(dir, 'modes.json');
  const preferences = join(dir, 'preferences.json');
  const clock = () => now;
  const modes = new EmployeeAlertModes(leases, clock, preferences);
  modes.prefer('employee-a', 'vibrate');
  modes.set('employee-a', 'ring', 60 * 60 * 1000);
  modes.set('employee-b', 'silent', 60 * 60 * 1000);
  return {
    leases,
    preferences,
    modes,
    advance: (ms: number) => (now += ms),
    reopen: () => new EmployeeAlertModes(leases, clock, preferences),
    bytes: () => [readFileSync(leases, 'utf8'), readFileSync(preferences, 'utf8')],
  };
}

const mode = (modes: EmployeeAlertModes) => modes.effective('employee-a', DEFAULT_EMPLOYEE_ALERT_MODE);

describe("an owner's phone choice commits in one write", () => {
  it('a refused preference write changes nothing, before or after a restart', () => {
    const p = prepared();
    const before = p.bytes();
    failing.target = p.preferences;
    expect(() => p.modes.prefer('employee-a', 'silent')).toThrow('EACCES');
    expect(p.bytes()).toEqual(before);
    expect(mode(p.modes)).toMatchObject({ mode: 'ring', source: 'lease', then: 'vibrate' });
    failing.target = '';
    expect(mode(p.reopen())).toMatchObject({ mode: 'ring', source: 'lease', then: 'vibrate' });
    p.advance(60 * 60 * 1000);
    expect(mode(p.reopen())).toEqual({ mode: 'vibrate', source: 'preference' });
  });

  it('once the preference is written, a failed lease cleanup neither refuses nor lets the old lease apply', () => {
    const p = prepared();
    const [leasesBefore] = p.bytes();
    failing.target = p.leases;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    p.modes.prefer('employee-a', 'silent');
    expect(warn).toHaveBeenCalledOnce();
    // The old Ring lease is still on disk, and is ended by the later preference.
    expect(readFileSync(p.leases, 'utf8')).toBe(leasesBefore);
    expect(mode(p.modes)).toEqual({ mode: 'silent', source: 'preference' });
    failing.target = '';
    expect(mode(p.reopen())).toEqual({ mode: 'silent', source: 'preference' });
    p.advance(60 * 60 * 1000);
    expect(mode(p.reopen())).toEqual({ mode: 'silent', source: 'preference' });
  });

  it("applies at once, removes only that employee's lease, and survives a restart", () => {
    const p = prepared();
    p.modes.prefer('employee-a', 'silent');
    expect(mode(p.modes)).toEqual({ mode: 'silent', source: 'preference' });
    expect(Object.keys(JSON.parse(readFileSync(p.leases, 'utf8')))).toEqual(['employee-b']);
    const reopened = p.reopen();
    expect(mode(reopened)).toEqual({ mode: 'silent', source: 'preference' });
    expect(reopened.get('employee-b')?.mode).toBe('silent');
  });

  it('a lease set after the preference applies, even in the same millisecond, then the preference returns', () => {
    const p = prepared();
    p.modes.prefer('employee-a', 'silent');
    p.modes.set('employee-a', 'ring', 1000);
    expect(mode(p.modes)).toMatchObject({ mode: 'ring', source: 'lease', then: 'silent' });
    expect(mode(p.reopen())).toMatchObject({ mode: 'ring', source: 'lease', then: 'silent' });
    // And a preference in that same millisecond ends that lease again.
    p.modes.prefer('employee-a', 'vibrate');
    expect(mode(p.reopen())).toEqual({ mode: 'vibrate', source: 'preference' });
    p.modes.set('employee-a', 'ring', 1000);
    p.advance(1000);
    expect(mode(p.reopen())).toEqual({ mode: 'vibrate', source: 'preference' });
  });

  it("orders an older console's lease, which has no start time, by the earliest it could have begun", () => {
    const p = prepared();
    p.modes.prefer('employee-a', 'silent');
    const at = start + 1;
    p.advance(5000);
    // Written after the preference by a console that predates it: Ring for the full eight hours.
    const later = { 'employee-a': { mode: 'ring', until: start + 5000 + MAX_ALERT_LEASE_MS } };
    writeFileSync(p.leases, JSON.stringify(later));
    expect(mode(p.reopen())).toMatchObject({ mode: 'ring', source: 'lease', then: 'silent' });
    // One that could have begun before the preference does not override it.
    const unclear = { 'employee-a': { mode: 'ring', until: at + MAX_ALERT_LEASE_MS } };
    writeFileSync(p.leases, JSON.stringify(unclear));
    expect(mode(p.reopen())).toEqual({ mode: 'silent', source: 'preference' });
  });

  it('refuses a preferences file of another version or shape', () => {
    const p = prepared();
    for (const stored of [
      { 'employee-a': 'silent' },
      { schema: 2, employees: {} },
      { schema: 1, employees: { 'employee-a': { mode: 'silent' } } },
      { schema: 1, employees: [] },
    ]) {
      writeFileSync(p.preferences, JSON.stringify(stored));
      expect(() => p.reopen()).toThrow('Invalid alert preference');
    }
  });
});
