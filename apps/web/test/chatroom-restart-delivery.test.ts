import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';
import { PendingDeliveryStore } from '../src/chatroom-pending-delivery.js';
import { ChatroomDelivery, MAX_PENDING_PER_SESSION, type DeliverySession } from '../src/chatroom-delivery.js';
import { sqlite } from '../src/chat-db.js';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { typeAndSubmit } from '../src/submit-settle.js';

const services = new Set<ChatroomService>();
afterEach(async () => {
  for (const s of services) await s.stop();
  services.clear();
  vi.restoreAllMocks();
});

function fixture(database = false) {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-recovery-'));
  const writes: Record<string, string[]> = { alice: [], bob: [] };
  let clock = 1_000_000;
  let outcome: 'submitted' | 'stranded' | 'unverified' | 'none' = 'submitted';
  let fail = false;
  let alertThrows = false;
  const confirmations: Array<(outcome: 'submitted' | 'stranded' | 'unverified') => void> = [];
  const sessions = new Map<string, ChatSessionLike & { isWorking: boolean }>();
  for (const id of ['alice', 'bob'])
    sessions.set(id, {
      id,
      name: id,
      status: 'idle',
      mode: 'claude',
      pid: 1,
      isWorking: true,
      writeViaMux: async (text, options) => {
        if (fail) return false;
        writes[id].push(text);
        if (options?.onOutcome) confirmations.push((outcome) => options.onOutcome!(outcome));
        if (outcome !== 'none') options?.onOutcome?.(outcome);
        return true;
      },
    });
  const alerts: string[] = [];
  const create = async (deferDeliveryRecovery = false) => {
    const s = new ChatroomService({
      file: join(dir, 'chatrooms.json'),
      deferDeliveryRecovery,
      database: database ? join(dir, 'chat.db') : undefined,
      getSession: (id) => sessions.get(id),
      broadcast: () => {},
      now: () => clock,
      alert: (text) => {
        alerts.push(text);
        if (alertThrows) throw new Error('notification transport unavailable');
      },
    });
    await s.init();
    services.add(s);
    return s;
  };
  const stop = async (s: ChatroomService) => {
    await s.stop();
    services.delete(s);
  };
  const ready = () => {
    for (const s of sessions.values()) s.isWorking = false;
    clock += 10_000;
  };
  return {
    dir,
    writes,
    sessions,
    alerts,
    confirm: (outcome: 'submitted' | 'stranded' | 'unverified' = 'submitted', index = 0) => confirmations[index](outcome),
    create,
    stop,
    ready,
    tick: (ms = 10_000) => {
      clock += ms;
    },
    outcome: (o: typeof outcome) => {
      outcome = o;
    },
    alertThrows: () => {
      alertThrows = true;
    },
    fail: (f: boolean) => {
      fail = f;
    },
  };
}

for (const database of [false, true])
  describe(`restart delivery (${database ? 'SQLite' : 'JSON'} rooms)`, () => {
    it('replays queued identities despite a later seen mark, in order, once per intended member', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.addMember(room.id, 'bob', {});
      const old = a.post(room.id, { kind: 'user', name: 'Owner' }, 'earlier missed task', ['alice']);
      const newer = a.post(room.id, { kind: 'user', name: 'Owner' }, 'later known task', ['bob']);
      a.markSeen('alice', room.id, newer.id);
      await f.stop(a);
      f.ready();
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      expect(f.writes.alice[0]).toContain('earlier missed task');
      expect(f.writes.alice[0]).not.toContain('later known task');
      expect(f.writes.bob).toHaveLength(1);
      expect(f.writes.bob[0]).toContain('later known task');
      expect(b.lastSeen('alice', room.id)?.messageId).toBe(newer.id); // never rewound
      expect(old.id).not.toBe(newer.id);
      await f.stop(b);
      const c = await f.create();
      await c.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      expect(f.writes.bob).toHaveLength(1);
    });

    it('keeps passive messages passive across restart, then carries them only with a wake-up', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.setMemberNotify(room.id, 'alice', 'mentions');
      a.post(room.id, { kind: 'agent', sessionId: 'outsider', name: 'Visitor' }, 'held context');
      await f.stop(a);
      f.ready();
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(0);
      b.post(room.id, { kind: 'user', name: 'Owner' }, 'wake now');
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      expect(f.writes.alice[0]).toContain('held context');
      expect(f.writes.alice[0]).toContain('wake now');
    });

    it('does not replay deleted messages, departed members or post-only members', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.addMember(room.id, 'bob', {});
      const m = a.post(room.id, { kind: 'user', name: 'Owner' }, 'withdraw this');
      await a.deleteMessage(room.id, m.id, 'Owner');
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'departed task', ['alice']);
      a.removeMember(room.id, 'alice');
      a.addMember(room.id, 'terminal', { postOnly: true });
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'terminal task', ['terminal']);
      await f.stop(a);
      f.ready();
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(0);
      expect(f.writes.bob.join('')).not.toContain('withdraw this');
      expect(b.delivery.pendingFor('terminal')).toBe(0);
    });

    it('rechecks owner scope before replaying a private room', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Private workshop', 'owner-one');
      a.addMember(room.id, 'alice', {});
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'private task', ['alice']);
      await f.stop(a);
      f.sessions.set('alice', { ...f.sessions.get('alice')!, owner: 'owner-two', isWorking: false });
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(0);
    });

    it('a pull read settles exactly its page and leaves an earlier missed message recoverable', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'earlier missed task');
      const newest = a.post(room.id, { kind: 'user', name: 'Owner' }, 'already read task');
      a.acknowledgeAgentRead('alice', room.id, [newest]);
      await f.stop(a);
      f.ready();
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      expect(f.writes.alice[0]).toContain('earlier missed task');
      expect(f.writes.alice[0]).not.toContain('already read task');
    });

    it('does not resend the submitted half of a batch after another restart', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.post(room.id, { kind: 'user', name: 'Owner' }, `first ${'a'.repeat(2100)}`, ['alice']);
      a.post(room.id, { kind: 'user', name: 'Owner' }, `second ${'b'.repeat(2100)}`, ['alice']);
      await f.stop(a);
      f.ready();
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      expect(f.writes.alice[0]).toContain('first ');
      await f.stop(b);
      const c = await f.create();
      await c.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(2);
      expect(f.writes.alice[1]).toContain('second ');
      expect(f.writes.alice[1]).not.toContain('first ');
    });

    it('a pull read resolves uncertain identities without another startup warning', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      const message = a.post(room.id, { kind: 'user', name: 'Owner' }, 'read this explicitly', ['alice']);
      f.outcome('unverified');
      f.ready();
      await a.delivery.flushAll();
      await f.stop(a);
      const b = await f.create();
      expect(f.alerts.filter((text) => text.startsWith('Some chat deliveries'))).toHaveLength(1);
      b.acknowledgeAgentRead('alice', room.id, [message]);
      await f.stop(b);
      const c = await f.create();
      await c.delivery.flushAll();
      expect(f.alerts.filter((text) => text.startsWith('Some chat deliveries'))).toHaveLength(1);
      expect(f.writes.alice).toHaveLength(1);
    });

    it.each(['corrupt', 'future'] as const)(
      'starts chat after preserving a %s delivery database and alerts only once',
      async (format) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const f = fixture(database);
        const a = await f.create();
        const room = a.createRoom('Workshop', undefined);
        a.addMember(room.id, 'alice', {});
        a.post(room.id, { kind: 'user', name: 'Owner' }, 'history stays readable', 'all', { deliver: false });
        await f.stop(a);
        const file = join(f.dir, 'chat-pending-delivery.db');
        if (format === 'corrupt') writeFileSync(file, 'corrupt delivery metadata');
        else {
          const db = new (sqlite().DatabaseSync)(file);
          db.exec('PRAGMA user_version = 2');
          db.close();
        }
        const original = readFileSync(file);
        const b = await f.create();
        expect(b.room(room.id)?.messages.some((m) => m.text === 'history stays readable')).toBe(true);
        expect(f.alerts).toHaveLength(1);
        expect(f.alerts[0]).toContain('empty delivery queue');
        const preserved = readdirSync(f.dir).filter((name) => name.startsWith('chat-pending-delivery.db.quarantine-'));
        expect(preserved).toHaveLength(1);
        expect(preserved[0]).toMatch(/quarantine-\d{8}T\d{9}Z-/);
        expect(readFileSync(join(f.dir, preserved[0], 'chat-pending-delivery.db'))).toEqual(original);
        f.ready();
        b.post(room.id, { kind: 'user', name: 'Owner' }, 'new delivery still works', ['alice']);
        await b.delivery.flushAll();
        expect(f.writes.alice.join('')).toContain('new delivery still works');
        await f.stop(b);
        const c = await f.create();
        await c.delivery.flushAll();
        expect(f.alerts).toHaveLength(1);
      }
    );

    it('gives a gone-session member zero queued identities for three posts and a restart', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'bob', {});
      f.sessions.delete('bob');
      for (let i = 0; i < 3; i++) a.post(room.id, { kind: 'user', name: 'Owner' }, `gone task ${i}`, ['bob']);
      expect(a.delivery.pendingFor('bob')).toBe(0);
      const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(journal.list()).toEqual([]);
      journal.close();
      await f.stop(a);
      const b = await f.create();
      expect(b.delivery.pendingFor('bob')).toBe(0);
      const reopened = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(reopened.list()).toEqual([]);
      reopened.close();
      expect(b.room(room.id)?.members.some((m) => m.sessionId === 'bob')).toBe(true);
    });

    it('prunes persisted identities when their session is gone before recovery', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'bob', {});
      for (let i = 0; i < 3; i++) a.post(room.id, { kind: 'user', name: 'Owner' }, `old task ${i}`, ['bob']);
      await f.stop(a);
      f.sessions.delete('bob');
      const b = await f.create();
      expect(b.delivery.pendingFor('bob')).toBe(0);
      const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(journal.list()).toEqual([]);
      journal.close();
    });

    it('polling removes queued and uncertain identities after a registered session disappears', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'bob', {});
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'first task', ['bob']);
      f.outcome('none');
      f.ready();
      await a.delivery.flushAll();
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'second task', ['bob']);
      f.sessions.delete('bob');
      await a.delivery.flushAll();
      expect(a.delivery.pendingFor('bob')).toBe(0);
      const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(journal.list()).toEqual([]);
      journal.close();
    });

    it('waits for registry restoration before replay or gone-session pruning', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.addMember(room.id, 'bob', {});
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'restore alice task', ['alice']);
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'gone bob task', ['bob']);
      await f.stop(a);
      const alice = f.sessions.get('alice')!;
      f.sessions.clear();
      const b = await f.create(true);
      b.post(room.id, { kind: 'user', name: 'Owner' }, 'bootstrap task', ['alice']);
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(0);
      const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(journal.list()).toHaveLength(3);
      journal.close();
      f.sessions.set('alice', { ...alice, isWorking: false });
      f.tick();
      await b.startDelivery();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      expect(f.writes.alice[0]).toContain('restore alice task');
      expect(f.writes.alice[0]).toContain('bootstrap task');
      expect(f.writes.bob).toHaveLength(0);
      await b.startDelivery();
      f.tick();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      const restored = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(restored.list()).toEqual([]);
      restored.close();
    });

    it('notifies the owner when an unverified outcome holds further delivery until chat read', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      const first = a.post(room.id, { kind: 'user', name: 'Owner' }, 'private test body', ['alice']);
      f.outcome('unverified');
      f.ready();
      await a.delivery.flushAll();
      expect(f.alerts).toHaveLength(1);
      expect(f.alerts[0]).toContain('session alice is paused');
      expect(f.alerts[0]).toContain('Inspect its pane');
      expect(f.alerts[0]).toContain('reverie agent chat read');
      expect(f.alerts[0]).not.toContain('private test body');
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'next held task', ['alice']);
      f.tick();
      await a.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      expect(f.alerts).toHaveLength(1); // Polling a held queue does not repeat the alert.
      const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(journal.list().find((entry) => entry.messageId === first.id)?.state).toBe('uncertain');
      a.acknowledgeAgentRead('alice', room.id, [first]);
      f.outcome('submitted');
      f.tick();
      await a.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(2);
      expect(journal.list()).toEqual([]);
      journal.close();
      await f.stop(a);
      expect(readFileSync(join(f.dir, 'chatrooms.json.audit.jsonl'), 'utf8')).toContain('delivery-uncertain');
    });

    it('limits owner uncertainty notices to one per session per thirty minutes and includes the suppressed count', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      f.outcome('unverified');
      f.ready();
      for (let n = 0; n < 3; n++) {
        const message = a.post(room.id, { kind: 'user', name: 'Owner' }, `task ${n}`, ['alice']);
        f.tick();
        await a.delivery.flushAll();
        a.acknowledgeAgentRead('alice', room.id, [message]);
      }
      expect(f.alerts).toHaveLength(1);
      expect(f.alerts[0]).toContain('1 unconfirmed event');
      f.tick(30 * 60_000);
      const next = a.post(room.id, { kind: 'user', name: 'Owner' }, 'later task', ['alice']);
      await a.delivery.flushAll();
      expect(f.alerts).toHaveLength(2);
      expect(f.alerts[1]).toContain('3 unconfirmed events');
      a.acknowledgeAgentRead('alice', room.id, [next]);
      a.addMember(room.id, 'bob', {});
      const other = a.post(room.id, { kind: 'user', name: 'Owner' }, 'another member', ['bob']);
      f.tick();
      await a.delivery.flushAll();
      expect(f.alerts).toHaveLength(3); // A different session has its own cooldown.
      expect(f.alerts[2]).toContain('session bob is paused');
      a.acknowledgeAgentRead('bob', room.id, [other]);
    });

    it.each(['unverified', 'none'] as const)(
      'holds further input for true/%s until the exact first message is read',
      async (outcome) => {
        const f = fixture(database);
        const a = await f.create();
        const room = a.createRoom('Workshop', undefined);
        a.addMember(room.id, 'alice', {});
        const first = a.post(room.id, { kind: 'user', name: 'Owner' }, 'first uncertain', ['alice']);
        f.outcome(outcome);
        f.ready();
        await a.delivery.flushAll();
        a.post(room.id, { kind: 'user', name: 'Owner' }, 'second held', ['alice']);
        f.tick();
        await a.delivery.flushAll();
        expect(f.writes.alice).toHaveLength(1);
        a.acknowledgeAgentRead('alice', room.id, [first]);
        if (outcome === 'none') f.confirm('unverified'); // The pending verifier must stop touching the pane first.
        f.outcome('submitted');
        f.tick();
        await a.delivery.flushAll();
        expect(f.writes.alice).toHaveLength(2);
        expect(f.writes.alice[1]).toContain('second held');
        expect(f.writes.alice[1]).not.toContain('first uncertain');
      }
    );

    it.each(['false', 'throw', 'submitted', 'unverified', 'stranded', 'submitted-before', 'unverified-before', 'stranded-before'] as const)(
      'serializes an exact read during pending mux IO with its %s settlement',
      async (settlement) => {
        const f = fixture(database);
        const a = await f.create();
        const room = a.createRoom('Workshop', undefined);
        a.addMember(room.id, 'alice', {});
        const first = a.post(room.id, { kind: 'user', name: 'Owner' }, 'first pending write', ['alice']);
        const alice = f.sessions.get('alice')!;
        const normalWrite = alice.writeViaMux;
        let resolve!: (value: boolean) => void;
        let reject!: (error: Error) => void;
        let receipt!: (outcome: 'submitted' | 'stranded' | 'unverified') => void;
        alice.writeViaMux = (text, options) => {
          f.writes.alice.push(text);
          receipt = options!.onOutcome!;
          return new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
        };
        f.ready();
        const flushing = a.delivery.flush('alice');
        a.acknowledgeAgentRead('alice', room.id, [first]);
        const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
        expect(journal.list().find((entry) => entry.messageId === first.id)?.state).toBe('uncertain');
        a.post(room.id, { kind: 'user', name: 'Owner' }, 'second after settlement', ['alice']);
        f.tick();
        expect(await a.delivery.flush('alice')).toBe(false);
        expect(f.writes.alice).toHaveLength(1);
        const before = settlement.endsWith('-before');
        if (before) {
          receipt(settlement.replace('-before', '') as 'submitted' | 'unverified' | 'stranded');
          f.tick();
          expect(await a.delivery.flush('alice')).toBe(false);
          expect(f.writes.alice).toHaveLength(1);
          expect(journal.list().some((entry) => entry.messageId === first.id)).toBe(settlement !== 'submitted-before');
        }
        if (settlement === 'throw') reject(new Error('Enter failed after paste'));
        else resolve(settlement !== 'false');
        await flushing;
        if (!before && settlement !== 'false' && settlement !== 'throw') {
          // A resolved write may still have a verifier sending Enter. Keep the read
          // deferred and durable until its terminal callback, not just the promise.
          expect(journal.list().find((entry) => entry.messageId === first.id)?.state).toBe('uncertain');
          f.tick();
          expect(await a.delivery.flush('alice')).toBe(false);
          receipt(settlement as 'submitted' | 'unverified' | 'stranded');
        }
        expect(journal.list().some((entry) => entry.messageId === first.id)).toBe(false);
        // Late callbacks from a completed attempt cannot resurrect an acknowledged hold.
        receipt('stranded');
        alice.writeViaMux = normalWrite;
        f.tick();
        await a.delivery.flushAll();
        expect(f.writes.alice).toHaveLength(2);
        expect(f.writes.alice[1]).toContain('second after settlement');
        expect(journal.list()).toEqual([]);
        journal.close();
        await f.stop(a);
        const b = await f.create();
        b.post(room.id, { kind: 'user', name: 'Owner' }, 'after clean restart', ['alice']);
        f.tick();
        await b.delivery.flushAll();
        expect(f.writes.alice).toHaveLength(3);
      }
    );

    it('retains a racing read as durable uncertainty if restart happens before IO settles', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      const first = a.post(room.id, { kind: 'user', name: 'Owner' }, 'pending at restart', ['alice']);
      const alice = f.sessions.get('alice')!;
      const normalWrite = alice.writeViaMux;
      let resolve!: (value: boolean) => void;
      alice.writeViaMux = (text) => {
        f.writes.alice.push(text);
        return new Promise<boolean>((yes) => { resolve = yes; });
      };
      f.ready();
      const flushing = a.delivery.flush('alice');
      a.acknowledgeAgentRead('alice', room.id, [first]);
      await f.stop(a);
      resolve(false);
      await flushing;
      alice.writeViaMux = normalWrite;
      const b = await f.create();
      b.post(room.id, { kind: 'user', name: 'Owner' }, 'held after restart', ['alice']);
      f.tick();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
      expect(journal.list().find((entry) => entry.messageId === first.id)?.state).toBe('uncertain');
      b.acknowledgeAgentRead('alice', room.id, [first]);
      f.tick();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(2);
      expect(journal.list()).toEqual([]);
      journal.close();
    });

    it('a delayed submitted receipt releases the hold for a queued next message', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'await receipt', ['alice']);
      f.outcome('none');
      f.ready();
      await a.delivery.flushAll();
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'after receipt', ['alice']);
      f.tick();
      await a.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(1);
      f.confirm();
      f.outcome('submitted');
      f.tick();
      await a.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(2);
      expect(f.writes.alice[1]).toContain('after receipt');
      await f.stop(a);
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(2);
    });

    it('keeps a false write result uncertain without blindly retrying after restart', async () => {
      const f = fixture(database);
      const a = await f.create();
      const room = a.createRoom('Workshop', undefined);
      a.addMember(room.id, 'alice', {});
      a.post(room.id, { kind: 'user', name: 'Owner' }, 'retry me');
      f.fail(true);
      f.ready();
      await a.delivery.flushAll();
      await f.stop(a);
      f.fail(false);
      const b = await f.create();
      await b.delivery.flushAll();
      expect(f.writes.alice).toHaveLength(0);
      expect(f.alerts.filter((text) => text.startsWith('Some chat deliveries'))).toHaveLength(1);
    });

    it.each(['none', 'unverified', 'stranded'] as const)(
      'flags %s writes after restart instead of blindly pasting a duplicate',
      async (outcome) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const f = fixture(database);
        const a = await f.create();
        const room = a.createRoom('Workshop', undefined);
        a.addMember(room.id, 'alice', {});
        a.post(room.id, { kind: 'user', name: 'Owner' }, 'may be in composer');
        f.outcome(outcome);
        f.ready();
        await a.delivery.flushAll();
        expect(f.writes.alice).toHaveLength(1);
        await f.stop(a);
        f.outcome('submitted');
        const b = await f.create();
        await b.delivery.flushAll();
        expect(f.writes.alice).toHaveLength(1);
        expect(f.alerts.filter((text) => text.startsWith('Some chat deliveries'))).toHaveLength(1);
        const audit = readFileSync(join(f.dir, 'chatrooms.json.audit.jsonl'), 'utf8');
        expect(audit).toContain('delivery-recovery-uncertain');
      }
    );
  });

// Run the actual mux method in an isolated VM: all command IO is mocked, with no pane access.
function partialMuxFailure() {
  const source = ts.createSourceFile(
    'tmux-manager.ts',
    readFileSync(new URL('../src/tmux-manager.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const klass = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TmuxManager'
  )!;
  const method = klass.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === 'sendInput'
  )!;
  const textWrites: string[] = [];
  let failEnter = true;
  const sendInput = runInNewContext(
    ts.transpileModule(`(class { ${method.getText(source)} }).prototype.sendInput`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      IS_TEST_MODE: false,
      EXEC_TIMEOUT_MS: 1000,
      isValidMuxName: () => true,
      shellescape: (value: string) => JSON.stringify(value),
      typeAndSubmit,
      execAsync: async (command: string) => {
        textWrites.push(command);
      },
      console: { log() {}, warn() {}, error() {} },
    }
  ) as (this: unknown, id: string, text: string) => Promise<boolean>;
  const mux = {
    sessions: new Map([['alice', { muxName: 'fixture-alice', mode: 'claude' }]]),
    tmux: () => 'mock-tmux',
    turnSignals: () => ({}),
    submitIo: () => ({
      capture: () => null,
      sleep: async () => {},
      sendEnter: async () => {
        if (failEnter) throw new Error('Enter failed after text was typed');
      },
    }),
  };
  return {
    textWrites,
    allowEnter: () => {
      failEnter = false;
    },
    write: (text: string) => sendInput.call(mux, 'alice', text),
  };
}

describe('pending delivery durability', () => {
  it.each([false, true])('closes chat writes and preserves reads if deferred startup fails (alert failure %s)', async (alertFailure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture(true);
    const a = await f.create(true);
    const room = a.createRoom('Workshop', undefined);
    a.addMember(room.id, 'alice', {});
    const original = a.post(room.id, { kind: 'user', name: 'Owner' }, 'committed before recovery', ['alice']);
    if (alertFailure) f.alertThrows();
    vi.spyOn(PendingDeliveryStore.prototype, 'list').mockImplementationOnce(() => { throw new Error('recovery IO failure'); });
    await expect(a.startDelivery()).rejects.toThrow('recovery IO failure');
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]).toContain('read-only');
    expect(f.alerts[0]).toContain('delivery recovery failed');
    expect(() => a.post(room.id, { kind: 'user', name: 'Owner' }, 'must not commit')).toThrow('read-only');
    expect(a.room(room.id)?.messages.some((m) => m.id === original.id)).toBe(true);
    expect(a.room(room.id)?.messages.some((m) => m.text === 'must not commit')).toBe(false);
    f.ready();
    await a.delivery.flushAll();
    expect(f.writes.alice).toHaveLength(0);
    const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
    expect(journal.list()).toMatchObject([{ messageId: original.id, state: 'queued' }]);
    journal.close();
  });

  it('holds an uncertain identity with missing history until the owner resets that room membership', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const a = await f.create();
    const room = a.createRoom('Workshop', undefined);
    a.addMember(room.id, 'alice', {});
    const first = a.post(room.id, { kind: 'user', name: 'Owner' }, 'missing original body', ['alice']);
    f.outcome('unverified');
    f.ready();
    await a.delivery.flushAll();
    await f.stop(a);
    const file = join(f.dir, 'chatrooms.json');
    const rooms = JSON.parse(readFileSync(file, 'utf8')) as Array<{ id: string; messages: Array<{ id: string }> }>;
    const saved = rooms.find((r) => r.id === room.id)!;
    saved.messages = saved.messages.filter((m) => m.id !== first.id);
    writeFileSync(file, JSON.stringify(rooms));
    const b = await f.create();
    b.post(room.id, { kind: 'user', name: 'Owner' }, 'blocked next task', ['alice']);
    f.tick();
    await b.delivery.flushAll();
    expect(f.writes.alice).toHaveLength(1);
    const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
    expect(journal.list().find((entry) => entry.messageId === first.id)?.state).toBe('uncertain');
    journal.close();
    // Operator first inspects/clears the pane; existing owner membership actions resolve the un-readable identity.
    b.removeMember(room.id, 'alice');
    b.addMember(room.id, 'alice', {});
    f.outcome('submitted');
    b.post(room.id, { kind: 'user', name: 'Owner' }, 'task after reset', ['alice']);
    f.tick();
    await b.delivery.flushAll();
    expect(f.writes.alice).toHaveLength(2);
    expect(f.writes.alice[1]).toContain('task after reset');
    expect(f.writes.alice[1]).not.toContain('blocked next task');
    expect(b.room(room.id)?.messages.some((m) => m.text === 'blocked next task')).toBe(true);
  });

  it('does not paste twice when actual mux text succeeds but Enter fails, before or after restart', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const a = await f.create();
    const room = a.createRoom('Workshop', undefined);
    a.addMember(room.id, 'alice', {});
    const mux = partialMuxFailure();
    f.sessions.get('alice')!.writeViaMux = (text) => mux.write(text);
    const message = a.post(room.id, { kind: 'user', name: 'Owner' }, 'perform once', ['alice']);
    f.ready();
    await a.delivery.flushAll();
    expect(mux.textWrites).toHaveLength(1);
    const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
    expect(journal.list()).toMatchObject([{ state: 'uncertain' }]);
    journal.close();
    mux.allowEnter();
    a.post(room.id, { kind: 'user', name: 'Owner' }, 'later queued task', ['alice']);
    f.tick();
    await a.delivery.flushAll();
    expect(mux.textWrites).toHaveLength(1);
    await f.stop(a);
    const b = await f.create();
    await b.delivery.flushAll();
    expect(mux.textWrites).toHaveLength(1);
    expect(f.alerts.filter((text) => text.startsWith('Some chat deliveries'))).toHaveLength(1);
    b.acknowledgeAgentRead('alice', room.id, [message]);
    f.tick();
    await b.delivery.flushAll();
    expect(mux.textWrites).toHaveLength(2);
    expect(mux.textWrites[1]).toContain('later queued task');
    expect(mux.textWrites[1]).not.toContain('perform once');
  });

  it('removes a newly dropped passive identity behind a full waking queue, including across restart', async () => {
    const f = fixture();
    const a = await f.create();
    const room = a.createRoom('Workshop', undefined);
    a.addMember(room.id, 'alice', {});
    const messages = [];
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
      messages.push(a.post(room.id, { kind: 'user', name: 'Owner' }, `wake ${i}`, ['alice']));
    }
    const passive = a.post(
      room.id,
      { kind: 'agent', sessionId: 'visitor', name: 'Visitor' },
      'omitted passive text',
      'all',
      { deliver: false }
    );
    a.delivery.enqueue('alice', room, 'omitted passive text', { messageId: passive.id, passive: true, durable: true });
    expect(a.delivery.pendingFor('alice')).toBe(MAX_PENDING_PER_SESSION);
    const journal = PendingDeliveryStore.open(join(f.dir, 'chat-pending-delivery.db'));
    expect(journal.list()).toHaveLength(MAX_PENDING_PER_SESSION);
    expect(journal.list().some((entry) => entry.messageId === passive.id)).toBe(false);
    journal.close();
    a.acknowledgeAgentRead('alice', room.id, messages);
    await f.stop(a);
    f.ready();
    const b = await f.create();
    b.post(room.id, { kind: 'user', name: 'Owner' }, 'next task', ['alice']);
    await b.delivery.flushAll();
    expect(f.writes.alice).toHaveLength(1);
    expect(f.writes.alice[0]).not.toContain('omitted passive text');
  });

  it('an alert transport failure does not prevent recovered chat from starting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const a = await f.create();
    await f.stop(a);
    writeFileSync(join(f.dir, 'chat-pending-delivery.db'), 'corrupt metadata');
    f.alertThrows();
    const b = await f.create();
    expect(f.alerts).toHaveLength(1);
    expect(() => b.createRoom('Still available', undefined)).not.toThrow();
  });

  it('commits queued identities before the pane can be written, with private file permissions', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pending-delivery-')), 'pending.db');
    const store = PendingDeliveryStore.open(file);
    const session: DeliverySession = {
      id: 'alice',
      name: 'Alice',
      mode: 'claude',
      pid: 1,
      isWorking: false,
      writeViaMux: async (_text, options) => {
        const other = PendingDeliveryStore.open(file);
        expect(other.list()).toMatchObject([{ sessionId: 'alice', messageId: 'message-1', state: 'uncertain' }]);
        other.close();
        options?.onOutcome?.('submitted');
        return true;
      },
    };
    const d = new ChatroomDelivery({ getSession: () => session, pendingStore: () => store });
    d.enqueue('alice', { id: 'room', name: 'Workshop' }, 'message', { messageId: 'message-1', durable: true });
    expect(store.list()).toMatchObject([{ state: 'queued' }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await d.flushAll();
    expect(store.list()).toEqual([]);
    d.stop();
    store.close();
  });

  it('a failed durable write stops delivery before any pane input', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pending-delivery-')), 'pending.db');
    const store = PendingDeliveryStore.open(file);
    const write = vi.fn(async () => true);
    const alert = vi.fn();
    const d = new ChatroomDelivery({
      getSession: () => ({ id: 'alice', name: 'Alice', mode: 'claude', pid: 1, isWorking: false, writeViaMux: write }),
      pendingStore: () => store,
      onPersistenceError: alert,
    });
    vi.spyOn(store, 'add').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() =>
      d.enqueue('alice', { id: 'room', name: 'Workshop' }, 'message', { messageId: 'm', durable: true })
    ).toThrow('disk full');
    await d.flushAll();
    expect(write).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledOnce();
    d.stop();
    store.close();
  });

  it('retains existing queue bounds in the journal, without resurrecting deliberately omitted messages', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pending-delivery-')), 'pending.db');
    const store = PendingDeliveryStore.open(file);
    const d = new ChatroomDelivery({
      getSession: () => ({
        id: 'alice',
        name: 'Alice',
        mode: 'claude',
        pid: null,
        isWorking: false,
        writeViaMux: async () => true,
      }),
      pendingStore: () => store,
    });
    for (let i = 0; i < MAX_PENDING_PER_SESSION + 3; i++) {
      d.enqueue('alice', { id: 'room', name: 'Workshop' }, 'message', { messageId: `m-${i}`, durable: true });
    }
    expect(store.list()).toHaveLength(MAX_PENDING_PER_SESSION);
    expect(store.list()[0].messageId).toBe('m-3');
    d.stop();
    store.close();
  });

  it('preserves an unknown-schema WAL with its database before creating a fresh queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-delivery-wal-'));
    const source = join(dir, 'source.db');
    const file = join(dir, 'pending.db');
    const db = new (sqlite().DatabaseSync)(source);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE future(value TEXT); INSERT INTO future VALUES ('future metadata'); PRAGMA user_version = 2;"
    );
    const original = Object.fromEntries(['', '-wal', '-shm'].map((suffix) => [suffix, readFileSync(source + suffix)]));
    db.close();
    for (const [suffix, bytes] of Object.entries(original)) writeFileSync(file + suffix, bytes);
    const { store, quarantined } = PendingDeliveryStore.openRecoverable(file);
    expect(quarantined).toBeDefined();
    expect(store.list()).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(quarantined!).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(quarantined!, 'pending.db'))).toEqual(original['']);
    expect(readFileSync(join(quarantined!, 'pending.db-wal'))).toEqual(original['-wal']);
    expect(existsSync(join(quarantined!, 'pending.db-shm'))).toBe(true);
    store.close();
  });

  it('does not quarantine ordinary filesystem failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-delivery-io-'));
    const file = join(dir, 'directory.db');
    mkdirSync(file);
    expect(() => PendingDeliveryStore.openRecoverable(file)).toThrow();
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual(['directory.db']);
  });

  it('refuses corrupt or newer-schema journals rather than overwriting them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-delivery-'));
    const file = join(dir, 'broken.db');
    writeFileSync(file, 'not a database');
    expect(() => PendingDeliveryStore.open(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('not a database');
    const future = join(dir, 'future.db');
    const db = new (sqlite().DatabaseSync)(future);
    db.exec('PRAGMA user_version = 2');
    db.close();
    expect(() => PendingDeliveryStore.open(future)).toThrow('Unsupported pending delivery schema');
  });
});
