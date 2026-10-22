import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';

// Owner 10-20/21: an employee on Silent answers the owner only when he @mentions it or @everyone (the one
// room-wide word; @all and @here are plain text). Vibrate and Ring are unchanged.
// With `twin`, a second member 'c' goes by the same name in another case ('ALPHA'), on the same mode.
async function setup(mode?: 'ring' | 'vibrate' | 'silent', twin = false) {
  const writes: string[] = [];
  const twinWrites: string[] = [];
  const session = {
    id: 'a', name: 'Alpha', mode: 'claude', status: 'idle', isWorking: true, pid: 42,
    writeViaMux: async (text: string) => { writes.push(text); return true; },
  };
  const other = {
    id: 'c', name: 'ALPHA', mode: 'claude', status: 'idle', isWorking: true, pid: 43,
    writeViaMux: async (text: string) => { twinWrites.push(text); return true; },
  };
  const sessions: Record<string, typeof session> = twin ? { a: session, c: other } : { a: session };
  const service = new ChatroomService({
    file: join(mkdtempSync(join(tmpdir(), 'alert-silent-')), 'rooms.json'),
    employeeOf: (id) => (sessions[id] ? `employee-${id}` : undefined),
    getSession: (id) => sessions[id],
    broadcast: () => {},
    now: () => 1000000,
  });
  await service.init();
  const room = service.createRoom('Room', undefined);
  service.addMember(room.id, 'a');
  if (twin) service.addMember(room.id, 'c');
  if (mode) for (const id of Object.keys(sessions)) await service.setAlertMode(id, mode, 1000);
  const owner = (text: string) => service.post(room.id, { kind: 'user', name: 'owner', mark: 'owner_typed' }, text);
  const agent = (text: string) => service.post(room.id, { kind: 'agent', sessionId: 'b', name: 'Beta' }, text);
  const deps = (service.delivery as unknown as { deps: { forceWake: (s: string, r: string, m: string) => boolean } }).deps;
  const wakes = (m: { id: string }) => deps.forceWake('a', room.id, m.id);
  const twinWakes = (m: { id: string }) => deps.forceWake('c', room.id, m.id);
  const flush = async () => { session.isWorking = false; await service.delivery.flushAll(); return writes.join(''); };
  const flushTwin = async () => { other.isWorking = false; await service.delivery.flushAll(); return twinWrites.join(''); };
  return { service, room, owner, agent, wakes, twinWakes, flush, flushTwin };
}

describe('Silent: only an owner @mention or @everyone gets through', () => {
  it('holds owner text without a mention, delivers and wakes on an owner @mention or @everyone, still blocks agents', async () => {
    const t = await setup('silent');
    try {
      const plain = t.owner('owner plain held');
      const named = t.owner('@Alpha owner named');
      const other = t.owner('@Beta owner names someone else held');
      const everyone = t.owner('@everyone owner room-wide');
      const all = t.owner('@all owner all-word held');
      const here = t.owner('@here owner here-word held');
      const email = t.owner('mail ops@everyone.test held');
      const peer = t.agent('@Alpha agent mention held');
      const peerAll = t.agent('@everyone agent room-wide held');
      expect([plain, named, other, everyone, all, here, email, peer, peerAll].map(t.wakes))
        .toEqual([false, true, false, true, false, false, false, false, false]);
      const out = await t.flush();
      for (const text of ['owner named', 'owner room-wide']) expect(out).toContain(text);
      expect(out).not.toContain('held');
    } finally { await t.service.stop(); }
  });

  it('an owner @mention of a name two members share (any case) is not a direct mention: neither twin wakes', async () => {
    const t = await setup('silent', true);
    try {
      const shared = t.owner('@alpha owner shared-name held');
      const everyone = t.owner('@everyone owner room-wide');
      expect([shared, everyone].map(t.wakes)).toEqual([false, true]);
      expect([shared, everyone].map(t.twinWakes)).toEqual([false, true]);
      const out = await t.flush();
      const twinOut = await t.flushTwin();
      for (const o of [out, twinOut]) {
        expect(o).toContain('owner room-wide');
        expect(o).not.toContain('held');
      }
    } finally { await t.service.stop(); }
  });

  it('an unverified user mention is not the owner', async () => {
    const t = await setup('silent');
    try {
      t.service.post(t.room.id, { kind: 'user', name: 'owner' }, '@Alpha unverified held');
      expect(await t.flush()).not.toContain('unverified held');
    } finally { await t.service.stop(); }
  });

  it('Vibrate is unchanged: any owner text and any direct mention get through and wake', async () => {
    const t = await setup('vibrate');
    try {
      const plain = t.owner('owner plain through');
      const peer = t.agent('@Alpha agent mention through');
      const other = t.agent('agent unrelated held');
      expect([plain, peer, other].map(t.wakes)).toEqual([true, true, false]);
      const out = await t.flush();
      expect(out).toContain('owner plain through');
      expect(out).toContain('agent mention through');
      expect(out).not.toContain('held');
    } finally { await t.service.stop(); }
  });

  it('Vibrate: an agent @mention of a name two members share wakes neither', async () => {
    const t = await setup('vibrate', true);
    try {
      const shared = t.agent('@Alpha agent shared-name held');
      expect(t.wakes(shared)).toBe(false);
      expect(t.twinWakes(shared)).toBe(false);
      expect(await t.flush()).not.toContain('held');
      expect(await t.flushTwin()).not.toContain('held');
    } finally { await t.service.stop(); }
  });

  it.each([undefined, 'ring'] as const)('Ring (%s) is unchanged: owner force-wakes, others deliver without a force-wake', async (mode) => {
    const t = await setup(mode);
    try {
      const plain = t.owner('owner plain');
      const peer = t.agent('agent plain');
      expect([plain, peer].map(t.wakes)).toEqual([true, false]);
      const out = await t.flush();
      expect(out).toContain('owner plain');
      expect(out).toContain('agent plain');
    } finally { await t.service.stop(); }
  });
});
