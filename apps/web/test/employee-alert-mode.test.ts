import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_EMPLOYEE_ALERT_MODE, EmployeeAlertModes, MAX_ALERT_LEASE_MS } from '../src/employee-alert-mode.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { wakePayload } from './helpers/wake-payload.js';

describe('employee phone mode prototype', () => {
  it('persists by employee, expires on read, and stores Ring like any other timed choice', () => {
    let now = 1000000;
    const file = join(mkdtempSync(join(tmpdir(), 'alert-mode-')), 'modes.json');
    const modes = new EmployeeAlertModes(file, () => now);
    modes.set('employee-a', 'silent', 1000);
    expect(new EmployeeAlertModes(file, () => now).get('employee-a')?.mode).toBe('silent');
    expect(modes.get('employee-b')).toBeUndefined();
    now += 1000;
    expect(modes.get('employee-a')).toBeUndefined();
    modes.set('employee-a', 'vibrate', 1000);
    modes.set('employee-a', 'ring', 1000);
    // Ring is no longer what applies without a choice, so an explicit Ring is kept until it ends.
    expect(modes.get('employee-a')).toEqual({ mode: 'ring', until: now + 1000 });
  });
  it('defaults employees to Vibrate; a lease beats the owner preference, which beats the default', () => {
    let now = 1000000;
    const dir = mkdtempSync(join(tmpdir(), 'alert-pref-'));
    const leases = join(dir, 'modes.json');
    const preferences = join(dir, 'preferences.json');
    const modes = new EmployeeAlertModes(leases, () => now, preferences);
    expect(DEFAULT_EMPLOYEE_ALERT_MODE).toBe('vibrate');
    expect(modes.effective('employee-a', DEFAULT_EMPLOYEE_ALERT_MODE)).toEqual({ mode: 'vibrate', source: 'default' });
    modes.set('employee-a', 'silent', 1000);
    expect(modes.effective('employee-a', DEFAULT_EMPLOYEE_ALERT_MODE)).toEqual({
      mode: 'silent',
      source: 'lease',
      until: now + 1000,
      then: 'vibrate',
    });
    // The owner's choice ends the lease and lasts: no expiry, and it survives a restart.
    modes.prefer('employee-a', 'ring');
    expect(modes.get('employee-a')).toBeUndefined();
    now += 10 * MAX_ALERT_LEASE_MS;
    const reloaded = new EmployeeAlertModes(leases, () => now, preferences);
    expect(reloaded.effective('employee-a', DEFAULT_EMPLOYEE_ALERT_MODE)).toEqual({
      mode: 'ring',
      source: 'preference',
    });
    // A later timed choice applies for its lease only, then the preference returns.
    reloaded.set('employee-a', 'silent', 1000);
    expect(reloaded.effective('employee-a', DEFAULT_EMPLOYEE_ALERT_MODE)).toMatchObject({
      mode: 'silent',
      source: 'lease',
      then: 'ring',
    });
    now += 1000;
    expect(reloaded.effective('employee-a', DEFAULT_EMPLOYEE_ALERT_MODE)).toEqual({
      mode: 'ring',
      source: 'preference',
    });
    // The lease file keeps its old flat shape, so an older console still reads it.
    expect(Object.keys(JSON.parse(readFileSync(leases, 'utf8')))).toEqual(['employee-a']);
    expect(JSON.parse(readFileSync(preferences, 'utf8'))).toEqual({
      schema: 1,
      employees: { 'employee-a': { mode: 'ring', at: 1000001 } },
    });
    writeFileSync(preferences, JSON.stringify({ schema: 1, employees: { 'employee-b': { mode: 'loud', at: 1 } } }));
    expect(() => new EmployeeAlertModes(leases, () => now, preferences)).toThrow('Invalid alert preference');
    expect(() => modes.prefer('employee-a', 'loud' as never)).toThrow();
  });
  it.each([0, -1, Infinity, NaN, MAX_ALERT_LEASE_MS + 1])('refuses unbounded/invalid duration %s', (duration) => {
    expect(() => new EmployeeAlertModes(undefined).set('a', 'silent', duration)).toThrow();
  });
  it('does not inject silent context, permits only a verified owner @mention, and never replays held history', async () => {
    let now = 1000000;
    const writes: string[] = [];
    const session = {
      id: 'a',
      name: 'Alpha',
      mode: 'claude',
      status: 'idle',
      isWorking: true,
      pid: 42,
      writeViaMux: async (text: string) => {
        writes.push(wakePayload(service, session.id, text));
        return true;
      },
    };
    const service = new ChatroomService({
      file: join(mkdtempSync(join(tmpdir(), 'alert-service-')), 'rooms.json'),
      employeeOf: (id) => (id === 'a' ? 'employee-a' : undefined),
      getSession: (id) => (id === 'a' ? session : undefined),
      broadcast: () => {},
      now: () => now,
    });
    await service.init();
    try {
      const room = service.createRoom('Room', undefined);
      service.addMember(room.id, 'a');
      await service.setAlertMode('a', 'silent', 1000);
      expect(service.view(room).members[0].alertMode?.mode).toBe('silent');
      service.post(room.id, { kind: 'user', name: 'unverified' }, 'blocked ordinary');
      service.post(room.id, { kind: 'agent', sessionId: 'b', name: 'Beta' }, '@Alpha blocked mention');
      service.post(room.id, { kind: 'user', name: 'owner', mark: 'owner_typed' }, 'blocked owner without mention');
      service.post(room.id, { kind: 'user', name: 'owner', mark: 'owner_typed' }, '@Alpha verified owner wake');
      session.isWorking = false;
      await service.delivery.flushAll();
      expect(writes.join('')).toContain('verified owner wake');
      expect(writes.join('')).not.toContain('blocked');
      expect(service.view(room).messages.some((m) => m.text === 'blocked ordinary')).toBe(true);
      now += 10000;
      expect(service.alertMode('a')).toEqual({ mode: 'vibrate', source: 'default' });
      await service.delivery.flushAll();
      expect(writes).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });
  it("the owner's choice for an employee lasts; the employee's own, a coordinator's and the owner's own phone are leases", async () => {
    let now = 1000000;
    const service = new ChatroomService({
      file: join(mkdtempSync(join(tmpdir(), 'alert-owner-')), 'rooms.json'),
      employeeOf: (id) => (id === 'a' ? 'employee-a' : undefined),
      getSession: () => undefined,
      broadcast: () => {},
      now: () => now,
    });
    await service.init();
    try {
      expect(service.alertMode('a')).toEqual({ mode: 'vibrate', source: 'default' });
      // A session with no employee binding is not on the employee phone, and the owner's own phone keeps Ring.
      expect(service.alertMode('plain')).toEqual({ mode: 'ring', source: 'default' });
      expect(service.ownerPhoneStatus()).toEqual({ mode: 'ring', source: 'default' });
      expect(await service.setPhoneStatus(undefined, 'a', 'silent', 'owner', () => {})).toEqual({
        mode: 'silent',
        source: 'preference',
      });
      now += 3 * MAX_ALERT_LEASE_MS;
      expect(service.alertMode('a')).toEqual({ mode: 'silent', source: 'preference' });
      // The employee itself (or a coordinator) sets a lease of at most eight hours over the owner's choice.
      expect(await service.setPhoneStatus(undefined, 'a', 'ring', 'a', () => {})).toEqual({
        mode: 'ring',
        source: 'lease',
        until: now + MAX_ALERT_LEASE_MS,
        then: 'silent',
      });
      now += MAX_ALERT_LEASE_MS;
      expect(service.alertMode('a')).toEqual({ mode: 'silent', source: 'preference' });
      expect(await service.setAlertMode('a', 'vibrate', 1000)).toMatchObject({
        mode: 'vibrate',
        source: 'lease',
        then: 'silent',
      });
      expect(await service.setPhoneStatus(undefined, undefined, 'silent', 'owner', () => {})).toMatchObject({
        mode: 'silent',
        source: 'lease',
        then: 'ring',
      });
    } finally {
      await service.stop();
    }
  });
  it('Vibrate admits direct mentions but holds unrelated text', async () => {
    const writes: string[] = [];
    const session = {
      id: 'a',
      name: 'Alpha',
      mode: 'claude',
      status: 'idle',
      isWorking: true,
      pid: 42,
      writeViaMux: async (text: string) => {
        writes.push(wakePayload(service, session.id, text));
        return true;
      },
    };
    const service = new ChatroomService({
      file: join(mkdtempSync(join(tmpdir(), 'alert-vibrate-')), 'rooms.json'),
      employeeOf: () => 'employee-a',
      getSession: () => session,
      broadcast: () => {},
      now: () => 1000000,
    });
    await service.init();
    try {
      const room = service.createRoom('Room', undefined);
      service.addMember(room.id, 'a');
      await service.setAlertMode('a', 'vibrate', 1000);
      const unrelated = service.post(room.id, { kind: 'agent', sessionId: 'b', name: 'Beta' }, 'held unrelated');
      const mention = service.post(room.id, { kind: 'agent', sessionId: 'b', name: 'Beta' }, '@Alpha please respond');
      session.isWorking = false;
      await service.delivery.flushAll();
      // An agent's room-wide mention is not an attention item, so the member reads it with chat read; what this checks is
      // the wake policy: the direct mention woke the member and the unrelated text was not carried.
      expect(writes).toHaveLength(1);
      expect(service.delivery.receivedBy(room.id, mention.id)).toEqual(['a']);
      expect(service.delivery.receivedBy(room.id, unrelated.id)).toEqual([]);
    } finally {
      await service.stop();
    }
  });
});
