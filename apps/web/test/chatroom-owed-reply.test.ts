/**
 * An owner message that @mentions or addresses an agent is owed a reply in that room. Only a post linked to that exact message
 * settles it: an explicit replyTo from the agent, never inferred. Each request is watched on its own. Once the deadline has
 * passed and the agent has been idle for the grace, the feed says the reply is unconfirmed, once, with the delivery state (never "received");
 * the grace runs from when the agent is seen idle and restarts if work resumes; while it is working, only a fixed later
 * deadline may say that delivery is still unconfirmed. Delivery problems are shown in the room, rate-limited, and held:
 * nothing is pasted twice. System lines are never typed into a pane and never create an obligation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const USER = { kind: 'user', name: 'user' } as const;
type Outcome = 'submitted' | 'stranded' | 'unverified';

describe('owed replies and visible delivery problems', () => {
  let outcome: Record<string, Outcome>;
  let writes: Record<string, number>;
  let live: Map<string, { isWorking: boolean }>;
  let service: ChatroomService;
  const system = (roomId: string) => service.room(roomId)!.messages.filter((m) => m.from.kind === 'system').map((m) => m.text);

  beforeEach(async () => {
    vi.useFakeTimers();
    outcome = { Quinn: 'submitted', Rowan: 'submitted' };
    writes = { Quinn: 0, Rowan: 0 };
    const session = (id: string, name: string, pid: number) => ({
      id, name, pid, isWorking: false, mode: 'claude',
      writeViaMux: async (_d: string, o?: { onOutcome?: (x: Outcome) => void }) => {
        writes[name]++;
        setTimeout(() => o?.onOutcome?.(outcome[name]), 10);
        return true;
      },
    });
    live = new Map([[A, session(A, 'Quinn', 1)], [B, session(B, 'Rowan', 2)]]);
    const file = join(mkdtempSync(join(tmpdir(), 'owed-')), 'chatrooms.json');
    service = new ChatroomService({ file, getSession: (id) => live.get(id) as never, broadcast: () => {}, owedReplyMs: 60_000 });
    await service.init();
  });
  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
  });

  const lab = () => {
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, A, {});
    service.addMember(room.id, B, {});
    return room;
  };

  it('reports a missing reply once, with the delivery state, for the mentioned agent only', async () => {
    const room = lab();
    const before = system(room.id).length;
    service.post(room.id, USER, '@Quinn status please?');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(system(room.id).length).toBe(before);
    await vi.advanceTimersByTimeAsync(2_000);
    const added = system(room.id).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^Reply from Quinn unconfirmed: no reply linked to the \d{1,2}:\d\d [AP]M ET message to it after 1 min \(delivery: submitted\)$/);
    expect(added[0]).not.toMatch(/received/);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(system(room.id).length).toBe(before + 1);
  });

  it('only an explicit exact replyTo settles it; an unlinked post or a post elsewhere does not', async () => {
    const room = lab();
    const other = lab();
    const before = system(room.id).length;
    const asked = service.post(room.id, USER, '@Quinn and @Rowan, status?');
    await vi.advanceTimersByTimeAsync(30_000); // both submitted
    service.post(other.id, { kind: 'agent', sessionId: B, name: 'Rowan' }, 'wrong room');
    const unlinked = service.post(room.id, { kind: 'agent', sessionId: B, name: 'Rowan' }, 'progress on something else');
    expect(unlinked.replyTo).toBeUndefined(); // never inferred
    service.post(room.id, { kind: 'agent', sessionId: A, name: 'Quinn' }, 'done', 'all', { replyTo: asked.id });
    await vi.advanceTimersByTimeAsync(61_000);
    const added = system(room.id).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^Reply from Rowan unconfirmed:/);
  });

  it('a post before submission, or linked to another message, does not settle it', async () => {
    outcome.Quinn = 'unverified';
    const room = lab();
    const before = system(room.id).length;
    const earlier = service.post(room.id, USER, 'note');
    service.post(room.id, USER, '@Quinn status?');
    const early = service.post(room.id, { kind: 'agent', sessionId: A, name: 'Quinn' }, 'progress');
    expect(early.replyTo).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    service.post(room.id, { kind: 'agent', sessionId: A, name: 'Quinn' }, 'about the note', 'all', { replyTo: earlier.id });
    await vi.advanceTimersByTimeAsync(61_000);
    const added = system(room.id).slice(before);
    expect(added.some((t) => /^Delivery to Quinn is unconfirmed: .*\(held, not resent\)/.test(t))).toBe(true);
    expect(added.some((t) => /^Reply from Quinn unconfirmed: .*\(delivery: unconfirmed\)$/.test(t))).toBe(true);
  });

  it('an unconfirmed delivery is shown once per 10 min and never pasted again', async () => {
    outcome.Quinn = 'unverified';
    const room = lab();
    const before = system(room.id).length;
    service.post(room.id, USER, '@Quinn one');
    await vi.advanceTimersByTimeAsync(5_000);
    const pasted = writes.Quinn;
    service.post(room.id, USER, '@Quinn two');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const notices = system(room.id).slice(before).filter((t) => t.startsWith('Delivery to Quinn'));
    expect(notices).toHaveLength(1);
    expect(pasted).toBe(1);
    expect(writes.Quinn).toBe(1); // held for inspection: the second message waits, the first is not repasted
  });

  it('owes nothing for an unaddressed owner post, an agent-to-agent mention, or a system line', async () => {
    const room = lab();
    const before = system(room.id).length;
    service.post(room.id, USER, 'general note');
    service.post(room.id, { kind: 'agent', sessionId: B, name: 'Rowan' }, '@Quinn can you look?');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(system(room.id).length).toBe(before);
    expect(writes.Quinn).toBeGreaterThan(0);
  });

  it('watches each request on its own: request B stays owed after A is answered', async () => {
    const room = lab();
    const before = system(room.id).length;
    const a = service.post(room.id, USER, '@Quinn first question');
    const b = service.post(room.id, USER, '@Quinn second question');
    await vi.advanceTimersByTimeAsync(30_000);
    service.post(room.id, { kind: 'agent', sessionId: A, name: 'Quinn' }, 'answer to first', 'all', { replyTo: a.id });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(system(room.id).slice(before)).toHaveLength(1); // B, not A
    service.post(room.id, { kind: 'agent', sessionId: A, name: 'Quinn' }, 'answer to second', 'all', { replyTo: b.id });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(system(room.id).slice(before)).toHaveLength(1);
  });

  it('@everyone makes every member that takes chat owe a reply', async () => {
    const room = lab();
    const before = system(room.id).length;
    service.post(room.id, USER, '@everyone status?');
    await vi.advanceTimersByTimeAsync(61_000);
    const added = system(room.id).slice(before);
    expect(added.filter((t) => t.startsWith('Reply from Quinn unconfirmed:'))).toHaveLength(1);
    expect(added.filter((t) => t.startsWith('Reply from Rowan unconfirmed:'))).toHaveLength(1);
  });

  it('@here and @all are plain text: nobody owes a reply', async () => {
    const room = lab();
    const before = system(room.id).length;
    service.post(room.id, USER, '@here status?');
    service.post(room.id, USER, '@all status?');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(system(room.id).slice(before).filter((t) => t.startsWith('Reply from'))).toEqual([]);
  });

  it('no missed-reply line while working; after work ends it waits a full idle grace, restarted if work resumes', async () => {
    const room = lab();
    const before = system(room.id).length;
    live.get(A)!.isWorking = true;
    service.post(room.id, USER, '@Quinn long task, report back');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    // A working pane is not typed into, so delivery waits: only the labelled delivery line, never a missed-reply line.
    const working = system(room.id).slice(before);
    expect(working).toHaveLength(1);
    expect(working[0]).toMatch(/^Delivery to Quinn still unconfirmed 10 min after .+ \(it is still working\)$/);
    live.get(A)!.isWorking = false; // busy well past the original deadline, now idle: the grace starts here
    await vi.advanceTimersByTimeAsync(45_000);
    expect(system(room.id).slice(before + 1)).toHaveLength(0); // no notice right after the task finishes
    live.get(A)!.isWorking = true; // work resumes: the grace restarts
    await vi.advanceTimersByTimeAsync(30_000);
    live.get(A)!.isWorking = false;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(system(room.id).slice(before + 1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const added = system(room.id).slice(before + 1);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^Reply from Quinn unconfirmed: .* after 2\d min \(delivery: submitted\)$/);
  });

  it('an exact reply during the idle grace settles it: no notice ever', async () => {
    const room = lab();
    const before = system(room.id).length;
    live.get(A)!.isWorking = true;
    const asked = service.post(room.id, USER, '@Quinn long task, report back');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const working = system(room.id).length;
    live.get(A)!.isWorking = false;
    await vi.advanceTimersByTimeAsync(45_000); // inside the grace (delivery went through once idle)
    service.post(room.id, { kind: 'agent', sessionId: A, name: 'Quinn' }, 'done', 'all', { replyTo: asked.id });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(system(room.id).length).toBe(working);
    expect(system(room.id).slice(before).some((t) => t.startsWith('Reply from Quinn'))).toBe(false);
  });

  it('while working, a fixed deadline says once that delivery is still unconfirmed, labelled as that', async () => {
    outcome.Quinn = 'unverified';
    const room = lab();
    live.get(A)!.isWorking = true;
    service.post(room.id, USER, '@Quinn status?');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const lines = system(room.id);
    expect(lines.filter((t) => /^Delivery to Quinn still unconfirmed 10 min after the .+ ET message to it \(it is still working\)$/.test(t))).toHaveLength(1);
    expect(lines.some((t) => t.startsWith('Reply from Quinn'))).toBe(false);
  });
});
