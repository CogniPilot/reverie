import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmployeeAlertModes, MAX_ALERT_LEASE_MS } from '../src/employee-alert-mode.js';
import { ChatroomService } from '../src/chatroom-service.js';

describe('employee phone mode prototype', () => {
  it('persists by employee, expires on read, and Ring clears a lease', () => {
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
    expect(modes.get('employee-a')).toBeUndefined();
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
        writes.push(text);
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
      expect(service.alertMode('a')).toBeUndefined();
      await service.delivery.flushAll();
      expect(writes).toHaveLength(1);
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
        writes.push(text);
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
      service.post(room.id, { kind: 'agent', sessionId: 'b', name: 'Beta' }, 'held unrelated');
      service.post(room.id, { kind: 'agent', sessionId: 'b', name: 'Beta' }, '@Alpha please respond');
      session.isWorking = false;
      await service.delivery.flushAll();
      expect(writes.join('')).toContain('please respond');
      expect(writes.join('')).not.toContain('held unrelated');
    } finally {
      await service.stop();
    }
  });
});
