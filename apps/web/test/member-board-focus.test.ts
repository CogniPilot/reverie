/**
 * A member's shown focus follows the Board (card i-453e512d): room views carry each employee member's own 'doing'
 * cards, earliest end first (three, then a count), read from the Board on every view and never stored on the
 * membership. A goal the member set itself still wins; without one, its first 'doing' card stands in. A saved Board
 * write re-announces only the rooms whose members' cards moved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService, FOCUS_CARDS } from '../src/chatroom-service.js';
import { BoardStore } from '../src/board-store.js';
import { agentChatWho, type AgentDeps } from '../src/cli-agent.js';
import { ChatroomChanged } from '../src/web/sse-events.js';
import { createMockSession } from './mocks/index.js';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

type Card = { id: string; title: string; status: string; owner?: string; updatedAt: number; end?: number };
const card = (id: string, owner: string | undefined, status: string, end?: number): Card => ({
  id,
  title: `Card ${id}`,
  status,
  owner,
  updatedAt: 1,
  ...(end !== undefined ? { end } : {}),
});

describe('room views show what each employee member is doing on the Board', () => {
  let directory: string;
  let chatrooms: ChatroomService;
  let issues: Card[];
  let events: Array<{ event: string; data: { roomId?: string } }>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-member-focus-'));
    issues = [];
    events = [];
    const sessions = new Map(['ada-session', 'bob-session', 'temp-session'].map((id) => [id, createMockSession(id)] as const));
    const employees: Record<string, string> = { 'ada-session': 'emp-ada', 'bob-session': 'emp-bob' };
    chatrooms = new ChatroomService({
      file: join(directory, 'chatrooms.json'),
      getSession: (id) => sessions.get(id) as never,
      broadcast: (event: string, data: { roomId?: string }) => void events.push({ event, data }),
      employeeOf: (id) => employees[id],
      boardIssues: () => issues,
    });
    await chatrooms.init();
  });
  afterEach(async () => {
    await chatrooms?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const lab = () => {
    const created = chatrooms.createRoom('Lab', undefined);
    for (const id of ['ada-session', 'bob-session', 'temp-session']) chatrooms.addMember(created.id, id, {});
    return created.id;
  };
  const memberOf = (roomId: string, sessionId: string) =>
    chatrooms.view(chatrooms.room(roomId)!).members.find((m) => m.sessionId === sessionId)!;

  it("carries only the member's own 'doing' cards, earliest end first, three then a count", () => {
    const id = lab();
    issues = [
      card('i-00000001', 'emp-ada', 'doing'), // no end: last
      card('i-00000002', 'emp-ada', 'doing', 300),
      card('i-00000003', 'emp-ada', 'doing', 100),
      card('i-00000004', 'emp-ada', 'doing', 200),
      card('i-00000005', 'emp-ada', 'todo', 50),
      card('i-00000006', 'emp-ada', 'blocked', 50),
      card('i-00000007', 'emp-ada', 'done', 50),
      card('i-00000008', 'emp-bob', 'doing', 10),
      card('i-00000009', undefined, 'doing', 10),
    ];
    const ada = memberOf(id, 'ada-session');
    expect(FOCUS_CARDS).toBe(3);
    expect(ada.focus).toEqual([
      { id: 'i-00000003', title: 'Card i-00000003', end: 100 },
      { id: 'i-00000004', title: 'Card i-00000004', end: 200 },
      { id: 'i-00000002', title: 'Card i-00000002', end: 300 },
    ]);
    expect(ada.focusMore).toBe(1);
    expect(memberOf(id, 'bob-session').focus).toEqual([{ id: 'i-00000008', title: 'Card i-00000008', end: 10 }]);
    expect(memberOf(id, 'bob-session')).not.toHaveProperty('focusMore');
  });

  it('shows nothing for a member with no doing card, a session with no employee record, or an archived room', () => {
    const id = lab();
    issues = [card('i-0000000a', 'emp-bob', 'todo')];
    expect(memberOf(id, 'ada-session')).not.toHaveProperty('focus');
    expect(memberOf(id, 'bob-session')).not.toHaveProperty('focus');
    issues = [card('i-0000000b', 'emp-ada', 'doing')];
    expect(memberOf(id, 'temp-session')).not.toHaveProperty('focus');
    chatrooms.room(id)!.archivedAt = 5;
    expect(memberOf(id, 'ada-session')).not.toHaveProperty('focus');
  });

  it('is a view only: the stored membership and a goal the member set stay as they were', () => {
    const id = lab();
    chatrooms.setStatus(id, 'ada-session', { goal: 'my own goal' });
    issues = [card('i-0000000c', 'emp-ada', 'doing')];
    const ada = memberOf(id, 'ada-session');
    expect(ada.goal).toBe('my own goal');
    expect(ada.focus?.[0]?.id).toBe('i-0000000c');
    const stored = chatrooms.room(id)!.members.find((m) => m.sessionId === 'ada-session')!;
    expect(stored).not.toHaveProperty('focus');
    expect(stored.goal).toBe('my own goal');
  });

  it('cuts a long card title for the line', () => {
    const id = lab();
    issues = [{ ...card('i-0000000d', 'emp-ada', 'doing'), title: '🌱'.repeat(300) }];
    const title = memberOf(id, 'ada-session').focus![0].title;
    expect(Array.from(title)).toHaveLength(120);
    expect(title).toBe(`${'🌱'.repeat(119)}…`);
  });

  it("a Board change re-announces only the rooms whose members' cards moved", () => {
    const first = lab();
    const other = chatrooms.createRoom('Other', undefined).id;
    chatrooms.addMember(other, 'temp-session', {});
    chatrooms.view(chatrooms.room(first)!);
    chatrooms.view(chatrooms.room(other)!);
    const changed = () => events.filter((e) => e.event === ChatroomChanged).map((e) => e.data.roomId);
    events.length = 0;
    chatrooms.noteBoardChanged(); // nothing moved
    expect(changed()).toEqual([]);
    issues = [card('i-0000000e', 'emp-ada', 'doing')];
    chatrooms.noteBoardChanged();
    expect(changed()).toEqual([first]);
    events.length = 0;
    chatrooms.noteBoardChanged(); // already announced
    issues = [card('i-0000000e', 'emp-ada', 'doing'), card('i-0000000f', 'emp-ada', 'todo')];
    chatrooms.noteBoardChanged(); // a todo card does not move the line
    expect(changed()).toEqual([]);
    issues = [];
    chatrooms.noteBoardChanged();
    expect(changed()).toEqual([first]);
  });
});

describe('BoardStore.onChange', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-board-change-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('calls listeners after each committed write only, and a throwing listener never undoes it', async () => {
    const store = new BoardStore(join(directory, 'board.json'));
    await store.init();
    const seen: number[] = [];
    store.onChange(() => {
      throw new Error('listener failed');
    });
    store.onChange((rev) => void seen.push(rev));
    expect(store.rev).toBe(0);
    await store.update({}, () => undefined);
    expect(seen).toEqual([1]);
    expect(store.rev).toBe(1);
    await expect(store.update({ ifRev: 0 }, () => undefined)).rejects.toThrow(/board changed/);
    await expect(
      store.update({ beforeSave: async () => Promise.reject(new Error('no audit')) }, () => undefined)
    ).rejects.toThrow('no audit');
    expect(seen).toEqual([1]);
    expect(store.rev).toBe(1);
  });
});

describe('agent chat who shows the Board focus', () => {
  const who = async (members: unknown[]) => {
    const out: string[] = [];
    const d: AgentDeps = {
      ctx: { apiUrl: 'http://127.0.0.1:1', selfId: 'me-session' },
      json: false,
      io: { out: (l) => void out.push(l), err: () => undefined },
      request: async () => ({ status: 200, text: '', json: { success: true, data: { rooms: [{ id: 'room-aaaa', name: 'Lab', members }] } } }),
    };
    expect(await agentChatWho(d, { room: 'Lab' })).toBe(0);
    return out.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  };

  it('stands in for an unset goal, never replaces a set one, and lists the doing cards', async () => {
    const focus = [
      { id: 'i-00000001', title: 'Sync goals', end: 1 },
      { id: 'i-00000002', title: 'Fix composer', end: 2 },
    ];
    const text = await who([
      { sessionId: 'me-session', name: 'Ada', role: 'agent', goal: '', progress: '', focus, focusMore: 2 },
      { sessionId: 'other-session', name: 'Bob', role: 'agent', goal: 'Review #132', progress: '', focus: [focus[1]] },
      { sessionId: 'third-session', name: 'Cy', role: 'agent', goal: '', progress: '' },
    ]);
    expect(text).toContain('    goal: "i-00000001 Sync goals" (from the Board)\n    doing: "i-00000001 Sync goals"; "i-00000002 Fix composer" (+2 more)');
    expect(text).toContain('    goal: "Review #132"\n    doing: "i-00000002 Fix composer"\n');
    expect(text).toMatch(/"Cy"[^\n]*\n {4}goal: -\n {4}progress: -/);
    expect(text.match(/doing: /g)).toHaveLength(2);
  });
});

describe('the web member views show the Board focus', () => {
  const A = '00000026-002d-4000-8000-00000000003c';
  const sessions = [{ id: A, name: 'alpha', mode: 'claude' }];
  const focus = [
    { id: 'i-00000001', title: 'Sync goals', end: 1 },
    { id: 'i-00000002', title: 'Fix composer', end: 2 },
  ];

  it('the member line falls back to the doing cards, and the profile lists them under Doing', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha', { focus, focusMore: 1 })], {})] });
    expect(h.document.querySelector('.ca-member[aria-label^="alpha,"] .ca-member-sub')?.textContent).toBe(
      'i-00000001 Sync goals · i-00000002 Fix composer · +1 more (from the Board)'
    );
    (h.document.querySelector('.ca-member') as HTMLElement).click();
    const rows = [...h.document.querySelectorAll('.ca-profile-technical > .ca-kv')].map((r) => r.textContent);
    expect(rows).toContain('Doingi-00000001 Sync goals · i-00000002 Fix composer · +1 more');
    expect(rows.some((r) => r?.startsWith('Goal'))).toBe(false);
  });

  it('a goal or progress the member set still comes first on the line', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'General', [member(A, 'alpha', { goal: 'ship it', focus })], {})],
    });
    expect(h.document.querySelector('.ca-member[aria-label^="alpha,"] .ca-member-sub')?.textContent).toBe('ship it');
  });

  it('the panel member card shows the first card as the goal only when none is set, and a Doing row', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    const synopsis = (m: unknown) =>
      [...(h.app as unknown as { _chatMemberCard(m: unknown): HTMLElement })._chatMemberCard(m).querySelectorAll('.chatroom-synopsis')].map(
        (r) => r.textContent
      );
    const base = member(A, 'alpha', { alive: true });
    expect(synopsis({ ...base, focus, focusMore: 1 })).toEqual([
      'Goali-00000001 Sync goals (from the Board)',
      'Doingi-00000001 Sync goals · i-00000002 Fix composer · +1 more',
      expect.stringMatching(/^Progress–/),
    ]);
    expect(synopsis({ ...base, goal: 'ship it', focus })[0]).toBe('Goalship it');
    expect(synopsis(base)).toEqual(['Goal–', expect.stringMatching(/^Progress–/)]);
  });
});
