/**
 * A member whose session is gone keeps its name: the last live name, or what it signed its messages with, or the name kept on its
 * membership across a restart. Only a session that was never seen at all shows its short id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

describe('offline members keep their names', () => {
  let file: string;
  let live: Map<string, { name: string; pid: number | null; isWorking: boolean; mode: string }>;
  const services: ChatroomService[] = [];
  const make = async (): Promise<ChatroomService> => {
    const service = new ChatroomService({ file, getSession: (id) => live.get(id) as never, broadcast: () => {} });
    await service.init();
    services.push(service);
    return service;
  };

  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'chatnames-')), 'chatrooms.json');
    live = new Map([
      [A, { name: 'Quinn', pid: 1, isWorking: false, mode: 'claude' }],
      [B, { name: 'Rowan', pid: 2, isWorking: false, mode: 'claude' }],
    ]);
  });
  afterEach(async () => {
    for (const s of services.splice(0)) await s.stop();
  });

  const names = (service: ChatroomService, roomId: string) => {
    const room = service.room(roomId)!;
    return Object.fromEntries(service.view(room).members.map((m) => [m.sessionId, { name: m.name, alive: m.alive }]));
  };

  it('shows the last live name once the session is gone, and its short id only if it was never seen', async () => {
    const service = await make();
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, A, { goal: 'x' });
    service.addMember(room.id, B, { goal: 'y' });
    expect(names(service, room.id)[A]).toEqual({ name: 'Quinn', alive: true });
    live.delete(A);
    expect(names(service, room.id)[A]).toEqual({ name: 'Quinn', alive: false });
    expect(service.nameOf(A)).toBe('Quinn');
    expect(service.nameOf(C)).toBe(C.slice(0, 8));
  });

  it('a live rename replaces the remembered name', async () => {
    const service = await make();
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, A, {});
    names(service, room.id);
    live.get(A)!.name = 'Quinn (IT)';
    expect(names(service, room.id)[A].name).toBe('Quinn (IT)');
    live.delete(A);
    expect(names(service, room.id)[A].name).toBe('Quinn (IT)');
  });

  it('survives a restart of the console: from the name kept on the membership, or from what the agent signed', async () => {
    const first = await make();
    const room = first.createRoom('Lab', undefined);
    first.addMember(room.id, A, {});
    first.addMember(room.id, B, {});
    // A is seen live (its name is kept on the membership); B speaks, then both sessions vanish
    names(first, room.id);
    first.post(room.id, { kind: 'agent', sessionId: B, name: 'Rowan' }, 'hello', 'all', { deliver: false });
    await first.stop();
    live.clear();
    const second = await make();
    expect(names(second, room.id)[A]).toEqual({ name: 'Quinn', alive: false });
    expect(names(second, room.id)[B]).toEqual({ name: 'Rowan', alive: false });
  });

  it('an agent that has only ever spoken (a session the console never held) keeps the name it signed with', async () => {
    live = new Map();
    const service = await make();
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, C, { postOnly: true });
    expect(names(service, room.id)[C].name).toBe(C.slice(0, 8));
    service.post(room.id, { kind: 'agent', sessionId: C, name: 'Quinn' }, 'on the host', 'all', { deliver: false });
    expect(names(service, room.id)[C].name).toBe('Quinn');
  });

  it('cleans a stored name: control characters are dropped and it is capped', async () => {
    const first = await make();
    const room = first.createRoom('Lab', undefined);
    first.addMember(room.id, C, { postOnly: true });
    first.post(room.id, { kind: 'agent', sessionId: C, name: `Ti\u0007m ${'x'.repeat(200)}` }, 'hi', 'all', { deliver: false });
    await first.stop();
    const second = await make();
    const name = names(second, room.id)[C].name;
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).not.toMatch(/[\u0000-\u001f]/);
  });

  it('control characters never reach what is shown or kept, on the live paths as well as after a restart', async () => {
    live.get(A)!.name = 'Qui\u0007nn\u001b[31m\nx';
    const service = await make();
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, A, {});
    const shown = names(service, room.id)[A].name;
    expect(shown).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(service.room(room.id)!.members[0].lastName).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(service.nameOf(A)).toBe(shown);
    service.post(room.id, { kind: 'agent', sessionId: C, name: 'Rowan\u0000\u202e\n' }, 'hi', 'all', { deliver: false });
    live.delete(A);
    expect(service.nameOf(C)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(names(service, room.id)[A].name).toBe(shown);
  });

  it('on a restart the name last seen live on the membership wins over what was signed earlier', async () => {
    const first = await make();
    const room = first.createRoom('Lab', undefined);
    first.addMember(room.id, A, {});
    // signed as "Quinn" long ago, then renamed while live to "Quinn (IT)", which the membership remembers
    first.post(room.id, { kind: 'agent', sessionId: A, name: 'Quinn' }, 'old message', 'all', { deliver: false });
    live.get(A)!.name = 'Quinn (IT)';
    names(first, room.id);
    await first.stop();
    live.clear();
    const second = await make();
    expect(names(second, room.id)[A].name).toBe('Quinn (IT)');
  });

  it('only an agent\u2019s own signature names a session: a user, an external sender or the system never does', async () => {
    live = new Map();
    const service = await make();
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, C, { postOnly: true });
    service.post(room.id, { kind: 'user', name: 'Someone' }, 'from the owner', 'all', { deliver: false });
    service.post(room.id, { kind: 'external', name: 'Mallory', provider: 'slack', connectionId: 'c', channelId: 'ch', userId: 'U1' } as never, 'external', 'all', { deliver: false });
    service.post(room.id, { kind: 'system', name: 'system', sessionId: C } as never, 'joined', 'all', { deliver: false });
    expect(names(service, room.id)[C].name).toBe(C.slice(0, 8));
    expect(service.nameOf(C)).toBe(C.slice(0, 8));
    // and the same after a restart, which learns from the stored messages
    await service.stop();
    const again = await make();
    expect(names(again, room.id)[C].name).toBe(C.slice(0, 8));
  });

  it('zero-width and bidirectional-override characters cannot disguise a name', async () => {
    live = new Map();
    const service = await make();
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, C, { postOnly: true });
    service.post(room.id, { kind: 'agent', sessionId: C, name: 'Ad\u200bmin\u202e\u2066 x\u200f' }, 'hi', 'all', { deliver: false });
    const name = names(service, room.id)[C].name;
    expect(name).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(name).toBe('Ad min x');
  });
});
