import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoardStore } from '../src/board-store.js';
import { AssignmentStatusWatch, type AssignmentEmployee } from '../src/assignment-status-watch.js';
import type { ChatMessage, ChatRoom } from '../src/chatroom-store.js';

describe('typed assignment check-ins, real durable Board/ledger', () => {
  let postDelay = 0;
  let auditHook: () => Promise<void>;
  let root: string,
    board: BoardStore,
    watch: AssignmentStatusWatch,
    employees: AssignmentEmployee[],
    room: ChatRoom,
    at: number,
    canEdit: boolean,
    delivery: boolean,
    failPost: boolean,
    posts: ChatMessage[],
    audits: unknown[];
  const cfg = {
    version: 1,
    type: 'assignment-status',
    enabled: true,
    botId: 'status',
    roomIds: ['room'],
    intervalMinutes: 60,
    responseMinutes: 5,
  };
  const create = () =>
    new AssignmentStatusWatch(path.join(root, 'watch.json'), {
      board,
      employees: () => employees,
      running: () => true,
      bot: () => ({ id: 'status', name: 'Status', rooms: ['room', 'other'], maxPerHour: 30 }),
      room: (id) => (id === 'room' ? room : id === 'other' ? { ...room, id: 'other', messages: [] } : undefined),
      canDeliver: () => delivery,
      canEdit: () => canEdit,
      delivered: () => delivery,
      post: (b, r, text, to) => {
        at += postDelay;
        const message = {
          id: 'm' + (posts.length + 1),
          at,
          from: { kind: 'bot', botId: b.id, name: b.name },
          text,
          to,
        } as ChatMessage;
        posts.push(message);
        room.messages.push(message);
        if (failPost) throw Error('lost local ack');
        return message;
      },
      audit: async (e) => {
        audits.push(e);
        await auditHook();
      },
      now: () => at,
    });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'assignment-watch-'));
    at = Date.parse('2026-10-26T12:00:00Z');
    canEdit = true;
    delivery = true;
    failPost = false;
    posts = [];
    audits = [];
    postDelay = 0;
    auditHook = async () => {};
    employees = [
      {
        id: 'worker',
        name: 'Worker',
        sessionId: 'sid',
        sessionGeneration: 1,
        onVacation: false,
        desiredRunning: true,
        reportsTo: 'manager',
      },
      {
        id: 'manager',
        name: 'Manager',
        sessionId: 'mgr',
        sessionGeneration: 1,
        onVacation: false,
        desiredRunning: true,
      },
    ];
    room = {
      id: 'room',
      name: 'Room',
      members: [{ sessionId: 'sid' }, { sessionId: 'mgr' }],
      messages: [],
    } as ChatRoom;
    board = new BoardStore(path.join(root, 'board.json'));
    await board.init();
    await board.update({}, (s) =>
      s.issues.push({
        id: 'task',
        title: 'Actual assignment',
        owner: 'worker',
        status: 'doing',
        tags: [],
        links: [],
        createdAt: at,
        updatedAt: at,
        end: at + 3600000,
        scale: 'hour',
      })
    );
    watch = create();
    await watch.init();
    await watch.configure(cfg);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const reply = (text: string, change: Partial<ChatMessage> = {}) => {
    room.messages.push({
      id: 'reply' + room.messages.length,
      at: at + 1,
      from: { kind: 'agent', sessionId: 'sid', employeeId: 'worker', name: 'Worker' },
      text,
      to: 'all',
      replyTo: posts[0]!.id,
      ...change,
    } as ChatMessage);
    at += 2;
  };
  it('asks actual assigned doing work once and restart preserves deadline/dedup', async () => {
    await watch.tick();
    const state = watch.status();
    expect(posts).toHaveLength(1);
    expect(state.entries[0]?.deadline).toBe(at + 300000);
    watch = create();
    await watch.init();
    await watch.tick();
    expect(posts).toHaveLength(1);
  });
  it.each(['done', 'wontdo', 'todo', 'triage'])('skips inactive task status %s', async (status) => {
    await board.update({}, (s) => {
      s.issues[0]!.status = status as never;
    });
    await watch.tick();
    expect(posts).toHaveLength(0);
  });
  it.each(['vacation', 'off', 'unassigned', 'migration', 'phone-blocked'])(
    'skips %s without escalating',
    async (reason) => {
      if (reason === 'vacation') employees[0]!.onVacation = true;
      if (reason === 'off') employees[0]!.desiredRunning = false;
      if (reason === 'migration') employees[0]!.bindingMigration = { id: 'moving' };
      if (reason === 'unassigned')
        await board.update({}, (s) => {
          delete s.issues[0]!.owner;
        });
      if (reason === 'phone-blocked') delivery = false;
      await watch.tick();
      at += 3600000;
      await watch.tick();
      expect(posts).toHaveLength(0);
      expect(board.snapshot().issues).toHaveLength(1);
    }
  );
  it('does not move a private-source assignment into a different room', async () => {
    await board.update({}, (s) => {
      s.issues[0]!.source = { roomId: 'private', messageId: 'original' };
    });
    await watch.tick();
    expect(posts).toHaveLength(0);
  });
  it('accepts exact correlated current assignee On track and never marks work done', async () => {
    await watch.tick();
    reply('On track');
    await watch.tick();
    expect(watch.status().entries[0]!.response?.status).toBe('on-track');
    expect(board.snapshot().issues[0]!.status).toBe('doing');
  });
  it.each(['wrong-sid', 'wrong-eid', 'not-reply', 'edited'])('rejects spoofed/unbound %s reply', async (kind) => {
    await watch.tick();
    reply(
      'On track',
      kind === 'wrong-sid'
        ? { from: { kind: 'agent', sessionId: 'other', employeeId: 'worker', name: 'Worker' } }
        : kind === 'wrong-eid'
          ? { from: { kind: 'agent', sessionId: 'sid', employeeId: 'other', name: 'Worker' } }
          : kind === 'not-reply'
            ? { replyTo: undefined }
            : { edited: { at } }
    );
    await watch.tick();
    expect(watch.status().entries[0]!.response).toBeUndefined();
  });
  it('records read-only assignee response without editing canonical work', async () => {
    canEdit = false;
    await watch.tick();
    reply('New ETA: 2026-10-26T16:00:00Z | integration still running');
    await watch.tick();
    const response = watch.status().entries[0]!.response!;
    expect(response.status).toBe('new-eta');
    expect(response.applied).toBe(true);
    expect(response.planApplied).toBe(false);
    expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T13:00:00Z'));
  });
  it('extends ETA with reason, preserves original commitment and response history after restart', async () => {
    await watch.tick();
    reply('New ETA: 2026-10-26T16:00:00Z | integration still running');
    await watch.tick();
    expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T16:00:00Z'));
    expect(watch.status().entries[0]!.originalEnd).toBe(Date.parse('2026-10-26T13:00:00Z'));
    watch = create();
    await watch.init();
    expect(watch.status().entries[0]!.response?.reason).toBe('integration still running');
    expect(audits).not.toHaveLength(0);
  });
  it('tracks no-response once with one Board item and current reporting manager', async () => {
    await watch.tick();
    at += 300001;
    await watch.tick();
    await watch.tick();
    const items = board.snapshot().issues.filter((i) => i.tags.includes('assignment-attention'));
    expect(items).toHaveLength(1);
    expect(items[0]!.owner).toBe('manager');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.to).toEqual(['mgr']);
  });
  it('does not leak attention to a manager outside the source room', async () => {
    await watch.tick();
    room.members = room.members.filter((m) => m.sessionId !== 'mgr');
    at += 300001;
    await watch.tick();
    expect(board.snapshot().issues).toHaveLength(1);
  });
  it('late response resolves attention but never completes actual task', async () => {
    await watch.tick();
    at += 300001;
    await watch.tick();
    reply('On track');
    await watch.tick();
    expect(board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))?.status).toBe('done');
    expect(board.snapshot().issues[0]!.status).toBe('doing');
  });
  it('Blocked response creates tracked attention and preserves task failure reason', async () => {
    await watch.tick();
    reply('Blocked: waiting for dependency');
    await watch.tick();
    expect(board.snapshot().issues[0]!.status).toBe('blocked');
    expect(watch.status().entries[0]!.response?.reason).toBe('waiting for dependency');
    expect(board.snapshot().issues.filter((i) => i.tags.includes('assignment-attention'))).toHaveLength(1);
  });
  it.each([480, 500, 574])('regression: retains a %i-character Blocked explanation through its exact reply reference', async (length) => {
    await watch.tick();
    const qualifier = ' Do not infer completion or remove the required approval.';
    const reason = 'Waiting for separately authorized evidence. '.repeat(20).slice(0, length - qualifier.length) + qualifier;
    expect(reason).toHaveLength(length);
    reply('Blocked: ' + reason);
    const original = structuredClone(room.messages.at(-1)!);
    await watch.tick();
    const response = watch.status().entries[0]!.response!;
    expect(response.status).toBe('blocked');
    expect(response.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    if (length > 500) expect(response.reason).toContain(original.id);
    else expect(response.reason).toBe(reason);
    expect(board.snapshot().issues[0]!.status).toBe('blocked');
    const attention = board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))!;
    expect(attention.reason).toContain('Assignee reported blocked.');
    expect(attention.reason).not.toContain('No correlated assignee response');
    expect(attention.reason!.length).toBeLessThanOrEqual(500);
    expect(attention.reason).toContain(original.id); // Prefix must also respect Board's 500-character bound.
    expect(room.messages.find((m) => m.id === original.id)).toEqual(original);
    expect(room.messages.find((m) => m.id === original.id)!.text.endsWith(qualifier)).toBe(true);
  });
  it('regression: accepts a long multiline direct Blocked reply without copying or trimming its qualifiers', async () => {
    await watch.tick();
    const text = 'Blocked: ' + 'Awaiting current evidence.\n'.repeat(24) + 'No completion or additional permission is claimed.';
    reply(text);
    const original = structuredClone(room.messages.at(-1)!);
    await watch.tick();
    expect(watch.status().entries[0]!.response?.status).toBe('blocked');
    expect(watch.status().entries[0]!.response?.reason).toContain(original.id);
    expect(room.messages.find((m) => m.id === original.id)?.text).toBe(text);
  });
  it('regression: applies a long-reason ETA only through the existing granted plan-edit path', async () => {
    await watch.tick();
    reply('New ETA: 2026-10-26T16:00:00Z | ' + 'Waiting for dependency evidence. '.repeat(20));
    const original = structuredClone(room.messages.at(-1)!);
    await watch.tick();
    expect(watch.status().entries[0]!.response?.status).toBe('new-eta');
    expect(watch.status().entries[0]!.response?.planApplied).toBe(true);
    expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T16:00:00Z'));
    expect(board.snapshot().issues[0]!.reason).toContain(original.id);
    expect(room.messages.find((m) => m.id === original.id)).toEqual(original);
  });
  it('regression: a foreign long reply and a reply beyond the canonical chat bound do not gain status authority', async () => {
    await watch.tick();
    reply('Blocked: ' + 'x'.repeat(574), { from: { kind: 'agent', sessionId: 'other', employeeId: 'other', name: 'Other' } });
    await watch.tick();
    expect(watch.status().entries[0]!.response).toBeUndefined();
    reply('Blocked: ' + 'x'.repeat(8000));
    await watch.tick();
    expect(watch.status().entries[0]!.response).toBeUndefined();
    expect(board.snapshot().issues).toHaveLength(1);
    expect(board.snapshot().issues[0]!.status).toBe('doing');
  });
  it('regression: a manager-completed same-checkin attention stays ended after ticks and reopen', async () => {
    await watch.tick();
    at += 300001;
    await watch.tick();
    const id = board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))!.id;
    await board.update({}, (s) => { const row = s.issues.find((i) => i.id === id)!; row.status = 'done'; row.doneAt = at; });
    const completed = structuredClone(board.snapshot().issues.find((i) => i.id === id)!);
    await watch.tick();
    watch = create(); await watch.init(); await watch.tick();
    expect(board.snapshot().issues.find((i) => i.id === id)).toEqual(completed);
    expect(watch.status().entries[0]!.attentionPending).toBe(false);
    expect(board.snapshot().issues[0]!.status).toBe('doing');
    expect(posts).toHaveLength(2);
    // Closing an attention acknowledges this check-in, never the underlying work;
    // normal monitoring can ask a fresh question at its existing interval.
    at += 3600001;
    await watch.tick();
    expect(watch.status().entries).toHaveLength(2);
    expect(watch.status().entries[1]!.promptId).not.toBe(watch.status().entries[0]!.promptId);
    at += 300001;
    await watch.tick();
    const fresh = board.snapshot().issues.find((i) => i.id === id)!;
    expect(fresh.status).toBe('todo');
    expect(fresh.source?.messageId).toBe(watch.status().entries[1]!.promptId);
    expect(board.snapshot().issues.filter((i) => i.id === id)).toHaveLength(1);
  });
  it('regression: an older Blocked check-in cannot reopen a closed attention for a newer check-in', async () => {
    await watch.tick(); reply('Blocked: current dependency'); await watch.tick();
    const id = board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))!.id;
    const complete = () => board.update({}, (s) => { const row=s.issues.find((i)=>i.id===id)!; row.status='done'; row.doneAt=at; });
    await complete(); await watch.tick();
    at += 3600001; await watch.tick();
    expect(watch.status().entries).toHaveLength(2);
    at += 300001; await watch.tick();
    expect(board.snapshot().issues.find((i)=>i.id===id)!.source?.messageId).toBe(watch.status().entries[1]!.promptId);
    await complete();
    const completed = structuredClone(board.snapshot().issues.find((i)=>i.id===id)!);
    await watch.tick(); await watch.tick();
    expect(board.snapshot().issues.find((i)=>i.id===id)).toEqual(completed);
  });
  it('regression: a completed attention committed during ledger save is not overwritten by queued creation', async () => {
    await watch.tick();
    at += 300001;
    const update = watch.store.update.bind(watch.store);
    let inserted = false;
    watch.store.update = async (change, guard) => {
      await update(change, guard);
      const entry = watch.status().entries[0]!;
      if (!inserted && entry.attentionPending) {
        inserted = true;
        await board.update({}, (s) => s.issues.push({
          id: entry.attentionId!, title: 'Manager handled this check-in', status: 'done',
          tags: ['assignment-attention'], links: [], reason: 'Handled without completing the work',
          source: { roomId: entry.roomId, messageId: entry.promptId! },
          createdAt: at, updatedAt: at, doneAt: at,
        }));
      }
    };
    await expect(watch.tick()).rejects.toThrow('board changed');
    const completed = structuredClone(board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))!);
    expect(completed.status).toBe('done');
    await watch.tick();
    expect(board.snapshot().issues.find((i) => i.id === completed.id)).toEqual(completed);
    expect(watch.status().entries[0]!.attentionPending).toBe(false);
    expect(posts).toHaveLength(1);
    expect(audits.some((e) => (e as { action?: string }).action === 'assignment-attention-opened')).toBe(false);
  });
  it('later unblock response is recorded with prior reason preserved', async () => {
    await watch.tick();
    reply('Blocked: dependency');
    await watch.tick();
    reply('On track');
    await watch.tick();
    const entry = watch.status().entries[0]!;
    expect(entry.response?.status).toBe('on-track');
    expect(entry.history[0]?.reason).toBe('dependency');
    expect(board.snapshot().issues[0]!.status).toBe('doing');
    expect(board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))?.status).toBe('done');
  });
  it('old answered history cannot resolve a later check-in attention', async () => {
    await watch.tick();
    reply('On track');
    await watch.tick();
    at += 3600001;
    await watch.tick();
    at += 300001;
    await watch.tick();
    expect(board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))?.status).toBe('todo');
    await watch.tick();
    expect(board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))?.status).toBe('todo');
  });
  it('manager changes route the same unresolved attention to current manager only', async () => {
    await watch.tick();
    at += 300001;
    await watch.tick();
    employees.push({
      id: 'new-manager',
      name: 'New Manager',
      sessionId: 'new-mgr',
      sessionGeneration: 1,
      desiredRunning: true,
      onVacation: false,
    });
    room.members.push({ sessionId: 'new-mgr' } as never);
    employees[0]!.reportsTo = 'new-manager';
    await watch.tick();
    expect(board.snapshot().issues.filter((i) => i.tags.includes('assignment-attention'))).toHaveLength(1);
    expect(board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))?.owner).toBe('new-manager');
    expect(posts.at(-1)?.to).toEqual(['new-mgr']);
  });
  it('a phone-blocked assignee gets no false no-response escalation', async () => {
    await watch.tick();
    delivery = false;
    at += 300001;
    await watch.tick();
    expect(board.snapshot().issues).toHaveLength(1);
  });
  it('read-only report is acknowledged without claiming a plan edit', async () => {
    canEdit = false;
    await watch.tick();
    reply('On track');
    await watch.tick();
    expect(posts.at(-1)?.text).toContain('Recorded on-track');
    expect(board.snapshot().issues[0]!.status).toBe('doing');
  });
  it('compacts only durably archived old history, keeping latest cooldown', async () => {
    const base = {
      id: randomUUID(),
      taskId: 'task',
      employeeId: 'worker',
      sessionId: 'sid',
      generation: 1,
      roomId: 'room',
      createdAt: at - 1001,
      deadline: at - 1,
      priorStatus: 'doing',
      phase: 'answered' as const,
      history: [],
      attentionPending: false,
      response: {
        messageId: 'response',
        at: at - 1,
        status: 'on-track' as const,
        reason: '',
        applied: true,
        planApplied: false,
        ackAttempted: true,
      },
    };
    await watch.store.update((s) => {
      s.entries = Array.from({ length: 1001 }, (_, i) => ({ ...base, id: randomUUID(), createdAt: at - 1001 + i }));
    });
    await watch.tick();
    const history = (await fs.readFile(path.join(root, 'watch.json.history.jsonl'), 'utf8')).trim().split('\n');
    expect(history).toHaveLength(501);
    expect(watch.status().entries).toHaveLength(500);
    expect(posts).toHaveLength(0);
    expect((await fs.stat(path.join(root, 'watch.json.history.jsonl'))).mode & 0o777).toBe(0o600);
  });
  it('fair queue gives an unseen task precedence over a repeat and limits one open per assignee', async () => {
    await watch.tick();
    reply('On track');
    await watch.tick();
    at += 3600001;
    await board.update({}, (s) => s.issues.push({ ...s.issues[0]!, id: 'unseen' }));
    await watch.tick();
    expect(watch.status().entries.at(-1)?.taskId).toBe('unseen');
    expect(watch.status().entries.filter((e) => e.phase === 'asked')).toHaveLength(1);
  });
  it('runtime state exposes pending age and explicitly avoids a posting SLA', async () => {
    await watch.tick();
    at += 1234;
    expect(watch.status().pending[0]?.ageMs).toBe(1234);
    expect(watch.status().scheduleAssurance).toContain('not a delivery SLA');
  });
  it('owner disabling automation during audit prevents adjacent Board mutation', async () => {
    await watch.tick();
    reply('Blocked: dependency');
    auditHook = async () => {
      await watch.configure({ ...cfg, enabled: false });
    };
    await expect(watch.tick()).rejects.toThrow('disabled');
    expect(board.snapshot().issues[0]!.status).toBe('doing');
    expect(watch.status().entries[0]!.response?.status).toBe('blocked');
  });
  it('explicit Board-edit revocation during audit preserves the report but refuses plan mutation', async () => {
    await watch.tick();
    reply('New ETA: 2026-10-26T16:00:00Z | dependency');
    auditHook = async () => {
      canEdit = false;
    };
    await expect(watch.tick()).rejects.toThrow('revoked');
    expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T13:00:00Z'));
    expect(watch.status().entries[0]!.response?.status).toBe('new-eta');
  });
  it('reporting route drift during audit refuses a stale manager ticket', async () => {
    await watch.tick();
    at += 300001;
    auditHook = async () => {
      employees[0]!.reportsTo = 'missing-manager';
    };
    await expect(watch.tick()).rejects.toThrow('Reporting route changed');
    expect(board.snapshot().issues).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });
  it.each(['off', 'vacation', 'phone'])(
    'pauses reply deadline across %s and restart, never changing actual commitment',
    async (reason) => {
      await watch.tick();
      const deadline = watch.status().entries[0]!.deadline;
      if (reason === 'off') employees[0]!.desiredRunning = false;
      if (reason === 'vacation') employees[0]!.onVacation = true;
      if (reason === 'phone') delivery = false;
      at += 1000;
      await watch.tick();
      watch = create();
      await watch.init();
      at += 3600000;
      employees[0]!.desiredRunning = true;
      employees[0]!.onVacation = false;
      delivery = true;
      await watch.tick();
      expect(watch.status().entries[0]!.deadline).toBe(deadline + 3600000);
      expect(board.snapshot().issues).toHaveLength(1);
      expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T13:00:00Z'));
    }
  );
  it('owner pause resumes reply clock without escalating disabled interval', async () => {
    await watch.tick();
    const deadline = watch.status().entries[0]!.deadline;
    await watch.configure({ ...cfg, enabled: false });
    at += 3600000;
    await watch.configure(cfg);
    await watch.tick();
    expect(watch.status().entries[0]!.deadline).toBe(deadline + 3600000);
    expect(board.snapshot().issues).toHaveLength(1);
  });
  it.each(['deleted', 'edited'])(
    'withdrawn canonical %s reply during slow audit cannot edit ETA or acknowledge',
    async (kind) => {
      await watch.tick();
      reply('New ETA: 2026-10-26T16:00:00Z | dependency');
      auditHook = async () => {
        const m = room.messages.find((m) => m.from.kind === 'agent')!;
        if (kind === 'deleted') m.deleted = { at, by: 'fixture' };
        else {
          m.text = 'On track';
          m.edited = { at };
        }
      };
      await expect(watch.tick()).rejects.toThrow('withdrawn');
      expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T13:00:00Z'));
      expect(posts).toHaveLength(1);
      auditHook = async () => {};
      await watch.tick();
      expect(watch.status().entries[0]!.response?.withdrawn).toBe(true);
      expect(posts).toHaveLength(1);
    }
  );
  it('owner room revocation during audit prevents ETA edit or acknowledgement', async () => {
    await watch.tick();
    reply('New ETA: 2026-10-26T16:00:00Z | dependency');
    auditHook = async () => {
      await watch.configure({ ...cfg, roomIds: ['other'] });
    };
    await expect(watch.tick()).rejects.toThrow('withdrawn');
    expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T13:00:00Z'));
    expect(posts).toHaveLength(1);
  });
  it('reply clock starts at durable prompt time after slow prepublication IO', async () => {
    const initial = at;
    postDelay = 360000;
    await watch.tick();
    const entry = watch.status().entries[0]!;
    expect(entry.createdAt).toBe(initial);
    expect(entry.askedAt).toBe(initial + 360000);
    expect(entry.deadline).toBe(initial + 660000);
    await watch.tick();
    expect(board.snapshot().issues).toHaveLength(1);
  });
  it('withdrawn report after reopen never drives attention/manager/ack or marks planApplied only in memory', async () => {
    await watch.tick();
    reply('New ETA: 2026-10-26T16:00:00Z | dependency');
    auditHook = async () => {
      room.messages.find((m) => m.from.kind === 'agent')!.deleted = { at, by: 'fixture' };
    };
    await expect(watch.tick()).rejects.toThrow('withdrawn');
    const disk = JSON.parse(await fs.readFile(path.join(root, 'watch.json'), 'utf8'));
    expect(watch.status().entries[0]!.response?.planApplied).toBe(false);
    expect(disk.entries[0].response.planApplied).toBe(false);
    auditHook = async () => {};
    watch = create();
    await watch.init();
    await watch.tick();
    await watch.tick();
    expect(watch.status().entries[0]!.response?.withdrawn).toBe(true);
    expect(board.snapshot().issues).toHaveLength(1);
    expect(board.snapshot().issues[0]!.end).toBe(Date.parse('2026-10-26T13:00:00Z'));
    expect(posts).toHaveLength(1);
  });
  it('current reassignment invalidates old response and cancels its check-in', async () => {
    await watch.tick();
    employees[0]!.sessionId = 'new';
    reply('On track');
    await watch.tick();
    expect(watch.status().entries[0]!.phase).toBe('cancelled');
    expect(watch.status().entries[0]!.response).toBeUndefined();
  });
  it('post-commit thrown acknowledgement is reconciled by exact bot marker, no retry', async () => {
    failPost = true;
    await watch.tick();
    expect(watch.status().entries[0]!.phase).toBe('unknown');
    watch = create();
    await watch.init();
    failPost = false;
    await watch.tick();
    expect(posts).toHaveLength(1);
    expect(watch.status().entries[0]!.phase).toBe('asked');
  });
  it('corrupt ledger refuses rather than silently resetting', async () => {
    await fs.writeFile(path.join(root, 'watch.json'), '{}', { mode: 0o600 });
    watch = create();
    await expect(watch.init()).rejects.toThrow('unavailable');
    expect(posts).toHaveLength(0);
  });
  it('genuine completed task resolves linked attention without new reminders', async () => {
    await watch.tick();
    at += 300001;
    await watch.tick();
    await board.update({}, (s) => {
      s.issues[0]!.status = 'done';
    });
    await watch.tick();
    expect(board.snapshot().issues.find((i) => i.tags.includes('assignment-attention'))?.status).toBe('done');
    expect(posts).toHaveLength(2);
  });
});
