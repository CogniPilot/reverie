/**
 * The conversation shell's pure data shaping: unread badges, the sidebar and rail models, feed
 * grouping with day dividers, member sections, the quick switcher and which view to open.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({});
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.js'), 'utf8'), context);
const fn = <T>(name: string) => vm.runInContext(name, context) as T;

type Room = {
  id: string;
  name: string;
  unread?: number;
  mentions?: number;
  workspace?: string;
  category?: string;
  archivedAt?: number;
  kind?: string;
  dm?: string[];
  members?: Array<{ sessionId: string; name: string }>;
  lastMessageAt?: number;
};
type Item = {
  type: string;
  key: string;
  id?: string;
  label: string;
  depth?: number;
  folded?: boolean;
  unread: number;
  mentions: number;
  active?: boolean;
};
const room = (id: string, unread = 0, mentions = 0, extra: Partial<Room> = {}): Room => ({
  id,
  name: id,
  unread,
  mentions,
  members: [],
  ...extra,
});

const chatBadgeFor = fn<(u: number, m: number) => { kind: string; dot: boolean; text: string }>('chatBadgeFor');
const caChannelItems = fn<(r: Room[], ws: string, c: Record<string, boolean>, active?: string) => Item[]>('caChannelItems');
const caByPosition = fn<(r: Array<{ id: string; position?: number }>) => Array<{ id: string }>>('caByPosition');
const caMoveWithin = fn<(ids: string[], id: string, step: number, cat: (id: string) => string) => string[]>('caMoveWithin');
const caMoveBeside = fn<(ids: string[], id: string, target: string, after: boolean) => string[]>('caMoveBeside');
const caDmItems = fn<(r: Room[], active?: string) => Item[]>('caDmItems');
const caDmItems4 = fn<(r: Room[], active?: string, closed?: Record<string, number>, employeeOf?: Map<string, string>) => Item[]>('caDmItems');
const caFoldedUnreadIds = fn<(r: Room[], open: string, closed: Record<string, number>, employeeOf: Map<string, string>) => string[]>('caFoldedUnreadIds');
const caWorkspaceItems = fn<(r: Room[], name: string) => Array<Item & { key: string; home?: boolean }>>('caWorkspaceItems');
const caWorkspaceOf = fn<(r?: Room) => string>('caWorkspaceOf');
const caTotals = fn<(r: Room[]) => { unread: number; mentions: number }>('caTotals');
const chatCountsAfterMessage = fn<(r: unknown, m: unknown, owner?: string[]) => { unread: number; mentions: number }>('chatCountsAfterMessage');
const chatStaleRoomIds = fn<(r: Room[], seen: Record<string, number>) => string[]>('chatStaleRoomIds');
type Msg = { id: string; at: number; from: { kind: string; name: string; sessionId?: string }; to: string | string[]; text: string };
const caFeedItems = fn<(m: Msg[], readAt?: number) => Array<{ type: string; head?: boolean; label?: string; m?: Msg }>>('caFeedItems');
const caContinues = fn<(a: Msg, b: Msg) => boolean>('caContinues');
const caMemberSections = fn<(m: unknown[]) => Array<{ key: string; label: string; members: unknown[] }>>('caMemberSections');
const caSwitcherResults = fn<(r: Room[], a: Array<{ id: string; name: string }>, q: string, limit?: number) => Array<{ type: string; id: string; label: string }>>('caSwitcherResults');
const caInitialView = fn<(o: { stored?: string; solo?: boolean; hasSessionLink?: boolean; legacy?: boolean }) => string>('caInitialView');
const caRoomLabel = fn<(r: Room) => string>('caRoomLabel');

describe('badges, the Discord way', () => {
  it('any unread is a dot; only mentions get a number; a mention beats a plain unread', () => {
    expect(chatBadgeFor(5, 2)).toEqual({ kind: 'mention', dot: true, text: '2' });
    expect(chatBadgeFor(5, 0)).toEqual({ kind: 'unread', dot: true, text: '' });
    expect(chatBadgeFor(0, 0)).toEqual({ kind: '', dot: false, text: '' });
    expect(chatBadgeFor(500, 120).text).toBe('99+');
    expect(chatBadgeFor(40, 0).text).toBe(''); // agent chatter never produces a count
  });
});

describe('sidebar model', () => {
  const rooms = [
    room('plain', 0, 0),
    room('build', 2, 1, { category: 'Build' }),
    room('review', 3, 0, { category: 'Build' }),
    room('quiet', 0, 0, { category: 'Build' }),
    room('ops', 0, 0, { category: 'Ops' }),
    room('other', 4, 0, { workspace: 'Rumoca' }),
    room('dm', 9, 9, { kind: 'dm' }),
    room('old', 5, 5, { archivedAt: 1, category: 'Build' }),
  ];
  const keys = (items: Item[]) => items.map((i) => i.key);

  it('lists uncategorised rooms first, then each category with its rooms', () => {
    expect(keys(caChannelItems(rooms, '', {}))).toEqual([
      'room:plain',
      'cat:/Build',
      'room:build',
      'room:review',
      'room:quiet',
      'cat:/Ops',
      'room:ops',
      'cat:/\u0000archived',
    ]);
  });

  it('keeps direct messages and other workspaces out of a workspace', () => {
    const ids = caChannelItems(rooms, '', {}).map((i) => i.id);
    expect(ids).not.toContain('dm');
    expect(ids).not.toContain('other');
    expect(caChannelItems(rooms, 'Rumoza', {})).toEqual([]);
    expect(keys(caChannelItems(rooms, 'Rumoca', {}))).toEqual(['room:other']);
  });

  it('rolls a category\'s dot and mention number up onto its header', () => {
    const cat = caChannelItems(rooms, '', {}).find((i) => i.key === 'cat:/Build')!;
    expect([cat.unread, cat.mentions]).toEqual([5, 1]);
    const ops = caChannelItems(rooms, '', {}).find((i) => i.key === 'cat:/Ops')!;
    expect([ops.unread, ops.mentions]).toEqual([0, 0]);
  });

  it('a folded category still shows the open room and anything unread, never a quiet room', () => {
    const folded = caChannelItems(rooms, '', { 'cat:/Build': true }, 'quiet');
    expect(keys(folded)).toEqual([
      'room:plain',
      'cat:/Build',
      'room:build',
      'room:review',
      'room:quiet',
      'cat:/Ops',
      'room:ops',
      'cat:/\u0000archived',
    ]);
    const quietFold = caChannelItems(rooms, '', { 'cat:/Build': true });
    expect(keys(quietFold)).not.toContain('room:quiet');
    expect(quietFold.find((i) => i.key === 'cat:/Build')).toMatchObject({ folded: true, unread: 5, mentions: 1 });
  });

  it('puts archived rooms in a folded trailing group with no notifications', () => {
    const items = caChannelItems(rooms, '', {});
    const group = items.find((i) => i.label === 'Archived')!;
    expect(group).toMatchObject({ folded: true, unread: 0, mentions: 0 });
    expect(keys(items)).not.toContain('room:old');
    const open = caChannelItems(rooms, '', { [group.key]: false });
    expect(open.find((i) => i.key === 'room:old')).toMatchObject({ unread: 0, mentions: 0 });
  });

  it('marks the active room and survives garbage', () => {
    expect(caChannelItems([room('a')], '', {}, 'a')[0].active).toBe(true);
    expect(caChannelItems(undefined as never, '', undefined as never)).toEqual([]);
    expect(caChannelItems([null as never], '', {})).toEqual([]);
  });
});

describe('direct messages and the workspace rail', () => {
  const dm = (id: string, peer: string, extra: Partial<Room> = {}) =>
    room(id, 0, 0, { name: '', kind: 'dm', dm: ['user', peer], members: [{ sessionId: peer, name: peer }], ...extra });

  it('lists conversations newest first, labelled by the other person', () => {
    const items = caDmItems([dm('d1', 'alpha', { lastMessageAt: 5 }), dm('d2', 'bravo', { lastMessageAt: 9 }), room('r')]);
    expect(items.map((i) => i.label)).toEqual(['bravo', 'alpha']);
    expect(caRoomLabel(dm('d3', 'charlie'))).toBe('charlie');
    expect(caRoomLabel(room('x', 0, 0, { name: 'Named' }))).toBe('Named');
  });

  it('shows each person once: chats with ended sessions fold into the live one and keep their unread', () => {
    const peer = (sid: string, alive: boolean, name = 'Jinx') => ({ sessionId: sid, name, alive }) as never;
    const jinx = (id: string, sid: string, alive: boolean, extra: Partial<Room> = {}) =>
      dm(id, sid, { members: [peer(sid, alive)], ...extra });
    const rooms = [
      jinx('old1', 's1', false, { lastMessageAt: 3, unread: 2, mentions: 1 }),
      jinx('live', 's3', true, { lastMessageAt: 9, unread: 1 }),
      jinx('old2', 's2', false, { lastMessageAt: 6 }),
      dm('bob', 'sb', { lastMessageAt: 1 }),
    ];
    const items = caDmItems(rooms);
    expect(items.map((i) => i.id)).toEqual(['live', 'bob']);
    const folded = items[0] as Item & { earlier: Item[] };
    expect(folded.earlier.map((e) => e.id)).toEqual(['old2', 'old1']);
    expect([folded.unread, folded.mentions]).toEqual([3, 1]);
  });

  it('prefers the live chat even when an ended one is newer, and folds nothing while both are live', () => {
    const peer = (sid: string, alive: boolean) => ({ sessionId: sid, name: 'Jinx', alive }) as never;
    const mk = (id: string, sid: string, alive: boolean, at: number) => dm(id, sid, { members: [peer(sid, alive)], lastMessageAt: at });
    expect(caDmItems([mk('gone', 's1', false, 9), mk('live', 's2', true, 1)]).map((i) => i.id)).toEqual(['live']);
    expect(caDmItems([mk('a', 's1', true, 9), mk('b', 's2', true, 1)]).map((i) => i.id)).toEqual(['a', 'b']);
    // A different person with the same name is never folded into a group chat.
    const group = room('g', 0, 0, { kind: 'dm', dm: ['user', 's1', 's9'], members: [peer('s1', false)], lastMessageAt: 5 });
    expect(caDmItems([group, mk('live', 's2', true, 1)]).map((i) => i.id)).toEqual(['g', 'live']);
  });

  it('folds by employee id when both sessions have one, and by name only when an id is missing', () => {
    const peer = (sid: string, alive: boolean) => ({ sessionId: sid, name: 'Stan', alive }) as never;
    const mk = (id: string, sid: string, alive: boolean, at: number) => dm(id, sid, { members: [peer(sid, alive)], lastMessageAt: at });
    const employeeOf = new Map([['s-live', 'e1'], ['s-old-same', 'e1'], ['s-old-other', 'e2']]);
    const rooms = [mk('live', 's-live', true, 9), mk('same', 's-old-same', false, 5), mk('other', 's-old-other', false, 4), mk('noid', 's-old-none', false, 3)];
    const items = caDmItems4(rooms, undefined, {}, employeeOf);
    // Another employee that reused the name stays its own row; an ended session with no employee folds by name.
    expect(items.map((i) => i.id)).toEqual(['live', 'other']);
    expect((items[0] as Item & { earlier: Item[] }).earlier.map((e) => e.id)).toEqual(['same', 'noid']);
  });

  it('opening the main row reads the folded chats too, so the one badge clears', () => {
    const peer = (sid: string, alive: boolean) => ({ sessionId: sid, name: 'Jinx', alive }) as never;
    const mk = (id: string, sid: string, alive: boolean, extra: Partial<Room>) => dm(id, sid, { members: [peer(sid, alive)], ...extra });
    const rooms = [mk('live', 's2', true, { lastMessageAt: 9, unread: 1 }), mk('old', 's1', false, { lastMessageAt: 3, unread: 4, mentions: 2 }), mk('quiet', 's0', false, { lastMessageAt: 1 })];
    expect(caDmItems4(rooms, 'live', {}, new Map())[0]).toMatchObject({ unread: 5, mentions: 2 });
    const ids = caFoldedUnreadIds(rooms, 'live', {}, new Map());
    expect(ids).toEqual(['old']);
    // The server marks those read; the same list then shows no badge on the main row once its own chat is read too.
    for (const r of rooms) { r.unread = 0; r.mentions = 0; }
    expect(caDmItems4(rooms, 'live', {}, new Map())[0]).toMatchObject({ unread: 0, mentions: 0 });
    expect(caFoldedUnreadIds(rooms, 'live', {}, new Map())).toEqual([]);
    // Nothing is read for a chat that is not the open one.
    expect(caFoldedUnreadIds([mk('live', 's2', true, { unread: 0 }), mk('old', 's1', false, { unread: 4 })], 'old', {}, new Map())).toEqual([]);
  });

  it('rolls the rail up: Home carries direct messages, each workspace its rooms, archived excluded', () => {
    const items = caWorkspaceItems(
      [
        room('a', 2, 1),
        room('b', 1, 0, { workspace: 'Rumoca' }),
        room('c', 8, 8, { workspace: 'Rumoca', archivedAt: 1 }),
        dm('d', 'x', { unread: 3, mentions: 3 }),
      ],
      'Reverie'
    );
    expect(items.map((i) => [i.key, i.label, i.unread, i.mentions])).toEqual([
      ['home', 'Direct messages', 3, 3],
      ['', 'Reverie', 2, 1],
      ['Rumoca', 'Rumoca', 1, 0],
    ]);
    expect(caWorkspaceItems([], 'Reverie').map((i) => i.label)).toEqual(['Direct messages', 'Reverie']);
    expect(caWorkspaceOf(dm('d', 'x'))).toBe('home');
    expect(caWorkspaceOf(room('r', 0, 0, { workspace: 'W' }))).toBe('W');
    expect(caWorkspaceOf(room('r'))).toBe('');
  });

  it('totals everything the user is notified about', () => {
    expect(caTotals([room('a', 1, 0), room('b', 2, 1), dm('d', 'x', { unread: 3, mentions: 3 }), room('z', 9, 9, { archivedAt: 1 })])).toEqual({ unread: 6, mentions: 4 });
  });
});

describe('counts while a message arrives', () => {
  const agent = { from: { kind: 'agent' } };
  it('counts only an agent, a mention only when addressed to the user', () => {
    const r = room('r', 2, 1);
    expect(chatCountsAfterMessage(r, { ...agent, to: 'all' })).toEqual({ unread: 3, mentions: 1 });
    expect(chatCountsAfterMessage(r, { ...agent, to: ['user'] })).toEqual({ unread: 3, mentions: 2 });
    expect(chatCountsAfterMessage(r, { from: { kind: 'user' }, to: 'all' })).toEqual({ unread: 2, mentions: 1 });
    expect(chatCountsAfterMessage(r, { from: { kind: 'system' }, to: 'all' })).toEqual({ unread: 2, mentions: 1 });
    expect(chatCountsAfterMessage(room('old', 0, 0, { archivedAt: 1 }), { ...agent, to: 'all' }).unread).toBe(0);
  });
  it('every agent message in a direct message with the user is a mention; between agents it is not theirs', () => {
    expect(chatCountsAfterMessage(room('d', 0, 0, { kind: 'dm', dm: ['user', 'x'] }), { ...agent, to: 'all' })).toEqual({ unread: 1, mentions: 1 });
    expect(chatCountsAfterMessage(room('d', 0, 0, { kind: 'dm', dm: ['x', 'y'] }), { ...agent, to: 'all' })).toEqual({ unread: 0, mentions: 0 });
  });
  it('flags a snapshot older than a message already seen, so a refetch repeats', () => {
    const rooms = [room('a', 0, 0, { lastMessageAt: 100 }), room('b', 0, 0, { lastMessageAt: 50 })];
    expect(chatStaleRoomIds(rooms, { a: 100, b: 80 })).toEqual(['b']);
    expect(chatStaleRoomIds(rooms, {})).toEqual([]);
    expect(chatStaleRoomIds(undefined as never, undefined as never)).toEqual([]);
  });
});

describe('feed grouping', () => {
  const MIN = 60_000;
  const day = (d: number, h = 12) => new Date(2026, 9, d, h, 0, 0).getTime();
  const m = (id: string, at: number, who = 'alpha', kind = 'agent', to: string | string[] = 'all'): Msg => ({
    id,
    at,
    from: { kind, name: who, sessionId: kind === 'agent' ? who : undefined },
    to,
    text: id,
  });

  it('groups a sender\'s consecutive messages, breaking on another sender, a gap or a different addressee', () => {
    const base = day(11);
    const items = caFeedItems([
      m('1', base),
      m('2', base + MIN),
      m('3', base + 2 * MIN, 'bravo'),
      m('4', base + 3 * MIN, 'bravo'),
      m('5', base + 20 * MIN, 'bravo'),
      m('6', base + 21 * MIN, 'bravo', 'agent', ['user']),
    ]);
    expect(items.filter((i) => i.type === 'message').map((i) => [i.m!.id, i.head])).toEqual([
      ['1', true],
      ['2', false],
      ['3', true],
      ['4', false],
      ['5', true],
      ['6', true],
    ]);
  });

  it('draws a divider for each new day and starts a new group after it', () => {
    const items = caFeedItems([m('1', day(10, 23)), m('2', day(11, 0)), m('3', day(11, 0) + 2 * MIN)]);
    expect(items.map((i) => i.type)).toEqual(['day', 'message', 'day', 'message', 'message']);
    expect(items[0].label).toBe('October 10, 2026');
    expect(items[2].label).toBe('October 11, 2026');
    expect((items[3] as { head: boolean }).head).toBe(true);
    expect((items[4] as { head: boolean }).head).toBe(false);
  });

  it('puts a NEW divider before the first unread agent message only', () => {
    const base = day(11);
    const items = caFeedItems([m('1', base), m('2', base + 1000, 'alpha'), m('3', base + 2000, 'user', 'user')], base);
    expect(items.map((i) => i.type)).toEqual(['day', 'message', 'new', 'message', 'message']);
    expect((items[3] as { head: boolean }).head).toBe(true);
    expect(caFeedItems([m('1', base)], 0).some((i) => i.type === 'new')).toBe(false);
    expect(caFeedItems([m('1', base)], base).some((i) => i.type === 'new')).toBe(false);
  });

  it('never merges a system line into a group, and tolerates an empty feed', () => {
    const sys = m('s', day(11), 'system', 'system');
    expect(caContinues(m('1', day(11)), sys)).toBe(false);
    expect(caContinues(sys, m('1', day(11)))).toBe(false);
    expect(caContinues(undefined as never, m('1', 1))).toBe(false);
    expect(caFeedItems([], 0)).toEqual([]);
    expect(caFeedItems(undefined as never, 0)).toEqual([]);
  });
});

describe('member sections', () => {
  const member = (id: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, name: id, role: 'agent', alive: true, working: false, ...extra });
  it('lists the coordinator, then who is online (working included), then who is offline', () => {
    const sections = caMemberSections([
      member('off', { alive: false }),
      member('busy', { working: true }),
      member('lead', { role: 'coordinator' }),
      member('idle'),
    ]);
    expect(sections.map((s) => [s.key, s.label, s.members.length])).toEqual([
      ['coordinator', 'Admin', 1],
      ['online', 'Online', 2],
      ['offline', 'Offline', 1],
    ]);
    expect(caMemberSections([])).toEqual([]);
    expect(caMemberSections(undefined as never)).toEqual([]);
  });
});

describe('quick switcher', () => {
  const rooms = [
    room('r1', 0, 0, { name: 'Release work' }),
    room('r2', 0, 0, { name: 'Ops', archivedAt: 1 }),
    room('d1', 0, 0, { name: '', kind: 'dm', dm: ['user', 'a1'], members: [{ sessionId: 'a1', name: 'alpha' }] }),
  ];
  const agents = [
    { id: 'a1', name: 'alpha' },
    { id: 'b1', name: 'bravo' },
  ];
  it('finds rooms, direct messages and agents, case-insensitively, rooms first and archived last', () => {
    expect(caSwitcherResults(rooms, agents, '').map((r) => [r.type, r.label])).toEqual([
      ['room', 'Release work'],
      ['dm', 'alpha'],
      ['agent', 'bravo'],
      ['room', 'Ops'],
    ]);
    expect(caSwitcherResults(rooms, agents, 'REL').map((r) => r.id)).toEqual(['r1']);
  });
  it('offers to start a conversation only with an agent that has none yet', () => {
    const labels = caSwitcherResults(rooms, agents, 'a').filter((r) => r.type === 'agent').map((r) => r.label);
    expect(labels).toEqual(['bravo']);
  });
  it('is bounded and tolerates garbage', () => {
    expect(caSwitcherResults(rooms, agents, '', 2)).toHaveLength(2);
    expect(caSwitcherResults(undefined as never, undefined as never, undefined as never)).toEqual([]);
  });
});

describe('which view to open', () => {
  it('is the conversation unless a terminal was asked for', () => {
    expect(caInitialView({})).toBe('chat');
    expect(caInitialView({ stored: 'chat' })).toBe('chat');
    expect(caInitialView({ stored: 'debug' })).toBe('debug');
    expect(caInitialView({ solo: true })).toBe('debug');
    expect(caInitialView({ hasSessionLink: true })).toBe('debug');
    expect(caInitialView({ legacy: true })).toBe('debug');
  });
});

describe('@mentions', () => {
  const members = [
    { sessionId: 's1', name: 'Alpha', role: 'coordinator', alive: true },
    { sessionId: 's2', name: 'Bravo', alive: false },
    { sessionId: 's3', name: 'Albert', alive: true },
  ];
  const query = fn<(v: string, c?: number) => { start: number; query: string } | null>('caMentionQuery');
  const candidates = fn<(m: unknown, q: string) => { kind: string; insert: string }[]>('caMentionCandidates');

  it('finds the @query at the caret, only at a word start', () => {
    expect(query('hi @al', 6)).toEqual({ start: 3, query: 'al' });
    expect(query('@', 1)).toEqual({ start: 0, query: '' });
    expect(query('mail me@al', 10)).toBeNull();
    expect(query('hi @al there', 6)).toEqual({ start: 3, query: 'al' });
    expect(query('hi @al there', 12)).toBeNull();
  });

  it('lists matching members, prefix first, then @everyone', () => {
    expect(candidates(members, '').map((c) => c.insert)).toEqual(['Alpha', 'Bravo', 'Albert', 'everyone']);
    expect(candidates(members, 'al').map((c) => c.insert)).toEqual(['Alpha', 'Albert']);
    expect(candidates(members, 'ra').map((c) => c.insert)).toEqual(['Bravo']);
    expect(candidates(members, 'ev').map((c) => c.insert)).toEqual(['everyone']);
    expect(candidates(members, 'zzz')).toEqual([]);
  });
});

describe('replies', () => {
  it('quotes one short line', () => {
    const snippet = fn<(t: string, n?: number) => string>('caSnippet');
    expect(snippet('  line one\n\nline   two ')).toBe('line one line two');
    expect(snippet('x'.repeat(200)).length).toBe(90);
    expect(snippet('')).toBe('(attachment)');
  });
});

describe('profile', () => {
  const profile = fn<(raw: unknown) => { name: string; pronouns: string; status: string; icon: string; hue: number | null }>('caProfile');
  it('cleans what was stored', () => {
    expect(profile('not json')).toEqual({ name: '', pronouns: '', status: '', icon: '', image: '', hue: null });
    expect(profile(JSON.stringify({ name: '  Sam\nQ ', icon: '\u{1F980}\u{1F980}\u{1F980}', hue: 160, pronouns: 'x'.repeat(50) }))).toMatchObject({
      name: 'Sam Q',
      icon: '\u{1F980}\u{1F980}',
      hue: 160,
    });
    expect(profile({ hue: 7 }).hue).toBeNull();
    expect(profile({ pronouns: 'x'.repeat(50) }).pronouns.length).toBe(24);
  });
});

describe('member state (the same states as the terminal UI dots)', () => {
  const state = fn<(m: unknown, s?: unknown, h?: Set<string>) => string>('caMemberState');
  const alive = { alive: true };
  it('ranks a blocking approval over an error over waiting over working over idle, and a gone session is gone', () => {
    expect(state(undefined)).toBe('gone');
    expect(state({ alive: false })).toBe('gone');
    expect(state(alive)).toBe('idle');
    expect(state(alive, { status: 'busy' })).toBe('working');
    expect(state({ alive: true, working: true })).toBe('working');
    expect(state(alive, { status: 'busy' }, new Set(['idle_prompt']))).toBe('waiting');
    expect(state(alive, { status: 'error' }, new Set(['idle_prompt']))).toBe('error');
    expect(state(alive, { status: 'error' }, new Set(['permission_prompt']))).toBe('needs');
    expect(state(alive, {}, new Set(['elicitation_dialog']))).toBe('needs');
    expect(state(alive, { status: 'stopped' })).toBe('gone');
    expect(state(alive, undefined, new Set())).toBe('idle');
  });
});

describe('agent facts', () => {
  const facts = fn<(s: unknown) => { headline: string[][]; runtime: string[][]; usage: string[][] }>('caAgentFacts');
  const count = fn<(n: unknown) => string>('caCount');
  it('shows only what the session has', () => {
    expect(facts(undefined)).toEqual({ headline: [], runtime: [], usage: [] });
    expect(
      facts({
        mode: 'codex',
        codexConfig: { model: 'gpt-5', reasoningEffort: 'high' },
        workingDir: '/work',
        inputTokens: 12345,
        outputTokens: 2_500_000,
        totalCost: 1.234,
      })
    ).toEqual({
      headline: [['Model', 'gpt-5'], ['Effort', 'high']],
      runtime: [['Backend', 'Codex'], ['Directory', '/work']],
      usage: [['Input tokens', '12.3k'], ['Output tokens', '2.5M'], ['Cost', '$1.23']],
    });
    expect(facts({ mode: 'claude', cliModel: 'claude-opus-5-5' }).headline).toEqual([['Model', 'claude-opus-5-5'], ['Effort', 'default']]);
    expect(count(0)).toBe('');
    expect(count(999)).toBe('999');
  });

  it('shows the model the CLI reports it is running, and says when it is only what it was launched with', () => {
    // reported by the running CLI: plain, and it wins over the launch setting (/model in the session changes it)
    expect(facts({ mode: 'claude', model: 'opus', displayModel: { model: 'Opus 5.5', source: 'statusline' } }).headline).toEqual([
      ['Model', 'Opus 5.5'],
      ['Effort', 'default'],
    ]);
    expect(facts({ mode: 'opencode', displayModel: { model: 'screen-model', source: 'screen' } }).headline).toEqual([['Model', 'screen-model']]);
    // launch and config settings are not a report
    expect(
      facts({ mode: 'opencode', openCodeConfig: { model: 'local_agent/qwen' }, displayModel: { model: 'local_agent/qwen', source: 'launch' } }).headline
    ).toEqual([['Model', 'local_agent/qwen (set at launch)']]);
    expect(facts({ mode: 'opencode', displayModel: { model: 'm', source: 'config' } }).headline).toEqual([['Model', 'm (from its config)']]);
    // an older server without displayModel falls back to the model fields
    expect(facts({ mode: 'claude', model: 'claude-sonnet-5-5' }).headline[0]).toEqual(['Model', 'claude-sonnet-5-5']);
  });

  it('shows the effort a session was started with, "default" for Claude without one, and nothing for a CLI that has none', () => {
    expect(facts({ mode: 'claude', effort: 'high' }).headline).toEqual([['Effort', 'high']]);
    expect(facts({ mode: 'claude' }).headline).toEqual([['Effort', 'default']]);
    expect(facts({ mode: 'opencode' }).headline).toEqual([]);
    expect(facts({ mode: 'codex', codexConfig: { reasoningEffort: 'low' } }).headline).toEqual([['Effort', 'low']]);
  });

  it('cleans what it shows: control characters and escape sequences are dropped, length is capped, a non-string is ignored', () => {
    const h = facts({ mode: 'claude', displayModel: { model: 'Opus\u001b[31m 5.5\u0007\n' + 'x'.repeat(100), source: 'statusline' } }).headline;
    expect(h[0][1].length).toBeLessThanOrEqual(64);
    expect(h[0][1]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(facts({ mode: 'claude', displayModel: { model: { toString: 'x' }, source: 'statusline' }, model: 'opus' }).headline[0]).toEqual(['Model', 'opus']);
    expect(facts({ mode: 'claude', effort: { x: 1 } }).headline).toEqual([['Effort', 'default']]);
  });
});

describe('org chart tree: former workers', () => {
  type Node = { name: string; kind: string; title: string; available?: boolean; children: Node[] };
  const tree = fn<(c: unknown, live?: Set<string>) => Node>('caOrgTree');
  const company = {
    settings: { ownerName: 'Pat', ctoId: 'c' },
    employees: [{ id: 'c', name: 'Chief', position: 'CTO', sessionId: 's1' }],
    temporaryAgents: [
      { sessionId: 'live', name: 'Here', icon: '' },
      { sessionId: 'old1', name: 'Old', icon: '' },
      { sessionId: 'old2', name: 'Older', icon: '' },
    ],
  };
  it('a session that is also an employee\u2019s is drawn once, as the employee', () => {
    const t = tree({ ...company, employees: [...company.employees, { id: 'j', name: 'Rebound', position: 'Agent', sessionId: 'live' }] }, new Set(['s1', 'live']));
    const names: string[] = [];
    const walk = (n: Node) => { names.push(n.name); n.children.forEach(walk); };
    walk(t);
    expect(names.filter((n) => n === 'Rebound')).toHaveLength(1);
    expect(names).not.toContain('Here');
  });
  it('without the set of live sessions nothing changes', () => {
    const t = tree(company);
    expect(t.children[0].children.map((n) => n.name)).toEqual(['Here', 'Old', 'Older']);
    expect(t.children.some((n) => n.kind === 'former')).toBe(false);
  });
  it('with it, the sessions that are gone are grouped last under one node, and marked former and not available', () => {
    const t = tree(company, new Set(['s1', 'live']));
    expect(t.children[0].children.map((n) => n.name)).toEqual(['Here']);
    const former = t.children.at(-1)!;
    expect(former).toMatchObject({ kind: 'former', name: 'Former workers' });
    expect(former.children.map((n) => [n.name, n.title, n.available])).toEqual([['Old', 'Former worker', false], ['Older', 'Former worker', false]]);
    // everyone running: no group at all
    expect(tree(company, new Set(['live', 'old1', 'old2'])).children.some((n) => n.kind === 'former')).toBe(false);
  });
  it('a pinned agent that is only stopped (marked kept) stays among the workers as paused, never in the former group', () => {
    const kept = { ...company, temporaryAgents: [...company.temporaryAgents, { sessionId: 'pinned1', name: 'Paused', icon: '', kept: true }] };
    const t = tree(kept, new Set(['s1', 'live']));
    const former = t.children.at(-1)!;
    expect(former.children.map((n) => n.name)).toEqual(['Old', 'Older']);
    const paused = t.children[0].children.find((n) => n.name === 'Paused')!;
    expect(paused).toMatchObject({ title: 'Paused (pinned)', available: false });
    // once it runs again it is an ordinary temporary worker
    const running = tree(kept, new Set(['s1', 'live', 'pinned1'])).children[0].children.find((n) => n.name === 'Paused')!;
    expect(running).toMatchObject({ title: 'Temporary worker', available: true });
  });
});

describe('org chart tree', () => {
  type Node = { name: string; kind: string; children: Node[] };
  const tree = fn<(c: unknown) => Node>('caOrgTree');
  const names = (n: Node): unknown => (n.children.length ? [n.name, n.children.map(names)] : n.name);

  it('puts the CTO under the owner (from the settings), reports under who they name, temporaries under the CTO', () => {
    const t = tree({
      settings: { ownerName: 'Pat', ownerTitle: 'Owner', ctoId: 'c' },
      employees: [
        { id: 'c', name: 'Cto', position: 'CTO', sessionId: 's1' },
        { id: 'a', name: 'Ann', reportsTo: 'c' },
        { id: 'b', name: 'Bo', reportsTo: 'a' },
        { id: 'x', name: 'Xi' },
      ],
      temporaryAgents: [
        { sessionId: 't1', name: 'Temp', parentSessionId: 's1' },
        { sessionId: 't2', name: 'Stray', parentSessionId: 'nobody' },
      ],
    });
    expect(t.name).toBe('Pat');
    expect(names(t)).toEqual(['Pat', [['Cto', [['Ann', ['Bo']], 'Xi', 'Temp', 'Stray']]]]);
  });

  it('survives a reporting cycle and an empty company', () => {
    const t = tree({ employees: [{ id: 'a', name: 'A', reportsTo: 'b' }, { id: 'b', name: 'B', reportsTo: 'a' }] });
    expect(t.children.length).toBeGreaterThan(0);
    const all = JSON.stringify(t);
    expect(all).toContain('"A"');
    expect(all).toContain('"B"');
    expect(tree(undefined)).toMatchObject({ name: 'Owner', children: [] });
  });
});

describe('voice channels', () => {
  const isVoice = fn<(r: unknown) => boolean>('caIsVoice');
  it('are ordinary rooms with a voice member', () => {
    expect(isVoice({ members: [{ voice: true }] })).toBe(true);
    expect(isVoice({ members: [{}] })).toBe(false);
    expect(isVoice({ kind: 'dm', dm: ['user', 'a'], members: [{ voice: true }] })).toBe(false);
    expect(isVoice(null)).toBe(false);
  });
});

describe('agent profile from the runtime', () => {
  const prof = fn<(d: unknown) => { persona: { name: string; role: string; text: string } | null; personaError: string; sections: { title: string; rows: string[][] }[]; switchInfo: { available: boolean; reason: string; current: string; backends: { name: string; enabled: boolean }[] } | null }>('caAgentProfile');
  const data = {
    session: { status: 'busy', alive: true, created_at: 1_700_000_000_000, working_dir: '/work' },
    backend: { mode: 'claude', model: 'claude-opus-5-5', display_model: 'Opus 5.5' },
    effort: { configured: 'high', observed: { level: 'medium', at: 1_700_000_100_000 } },
    usage: { input_tokens: 1500, output_tokens: 20, total_tokens: 1520, cost: 2.5, messages: 12, scope: 'this session' },
    employee: { position: 'CTO', expertise: ['Planning', 'Review'] },
    rooms: [{ id: 'r1', name: 'General', role: 'coordinator' }],
    runtime: { supervised: true, backend: 'claude', phase: 'working', backends: [{ name: 'claude', mode: 'claude', model: 'opus', enabled: true }, { name: 'local', mode: 'opencode', model: 'qwen', enabled: false }], switch: { available: false, reason: 'Owner authentication is not set up yet.' } },
    persona: { agent_name: 'Alpha', role: 'Planner', kind: 'expert', persona: 'Careful and curious.', source: '.fleet-instance' },
  };
  it('turns the runtime payload into labelled sections, and keeps the switch reason', () => {
    const p = prof(data);
    expect(p.persona).toMatchObject({ name: 'Alpha', role: 'Planner', text: 'Careful and curious.' });
    const by = Object.fromEntries(p.sections.map((s) => [s.title, Object.fromEntries(s.rows)]));
    expect(by.Role).toEqual({ Position: 'CTO', Expertise: 'Planning, Review' });
    expect(by.Runtime).toMatchObject({ Backend: 'Claude', 'Runtime model': 'Opus 5.5', 'Configured effort': 'high', Phase: 'working' });
    // the card's headline has Model and Effort; this section's rows carry their own labels, so the two cannot read as a contradiction
    expect(by.Runtime.Model).toBeUndefined();
    expect(by.Runtime.Effort).toBeUndefined();
    expect(by.Runtime['Default effort']).toBeUndefined();
    expect(by.Runtime['Last turn effort']).toMatch(/^medium \(/);
    expect(by.Usage).toMatchObject({ 'Input tokens': '1.5k', 'Total tokens': '1.5k', Messages: '12', Cost: '$2.50', Counted: 'this session' });
    expect(by.Channels).toEqual({ General: 'coordinator' });
    expect(p.switchInfo).toMatchObject({ available: false, reason: 'Owner authentication is not set up yet.', current: 'claude' });
    expect(p.switchInfo!.backends.map((b) => [b.name, b.enabled])).toEqual([['claude', true], ['local', false]]);
  });
  it('copes with nothing, a persona error, and seconds timestamps', () => {
    expect(prof(undefined)).toEqual({ persona: null, personaError: '', sections: [], switchInfo: null });
    expect(prof({ persona: { error: 'no instance config', source: 'x' } }).personaError).toBe('no instance config');
    expect(prof({ session: { created_at: 1_700_000_000 } }).sections[0].rows[0][1]).toMatch(/2023/);
  });
});

describe('notification settings', () => {
  const prefs = fn<(raw: unknown) => Record<string, { level: string; until: number }>>('caNotifyPrefs');
  const muted = fn<(p: unknown, now: number) => boolean>('caIsMuted');
  const view = fn<(rooms: unknown, p: unknown, now: number) => { id: string; unread: number; mentions: number; muted?: boolean }[]>('caViewRooms');
  const rooms = [
    { id: 'a', unread: 5, mentions: 2 },
    { id: 'b', unread: 3, mentions: 0 },
    { id: 'c', unread: 4, mentions: 1 },
    { id: 'd', unread: 1, mentions: 1 },
  ];

  it('cleans what was stored', () => {
    expect(prefs('nope')).toEqual({});
    expect(prefs({ a: { level: 'mentions' }, b: { level: 'weird', until: -1 }, c: { level: 'default', until: 0 }, __proto__: { level: 'none' } })).toEqual({
      a: { level: 'mentions', until: 0 },
      b: { level: 'default', until: -1 },
    });
  });

  it('knows when a mute is on', () => {
    expect(muted({ until: -1 }, 10)).toBe(true);
    expect(muted({ until: 20 }, 10)).toBe(true);
    expect(muted({ until: 5 }, 10)).toBe(false);
    expect(muted(undefined, 10)).toBe(false);
  });

  it('shows a muted channel nothing, "only @mentions" just the mentions, "nothing" nothing, and leaves the rest', () => {
    const out = view(rooms, { a: { level: 'mentions', until: 0 }, b: { level: 'default', until: 100 }, c: { level: 'none', until: 0 } }, 50);
    expect(out.map((r) => [r.id, r.unread, r.mentions, !!r.muted])).toEqual([
      ['a', 2, 2, false],
      ['b', 0, 0, true],
      ['c', 0, 0, false],
      ['d', 1, 1, false],
    ]);
    // an ended mute no longer hides anything
    expect(view(rooms, { b: { level: 'default', until: 100 } }, 200)[1]).toMatchObject({ unread: 3 });
  });
});

describe('workspace notification defaults', () => {
  const view = fn<(rooms: unknown, p: unknown, now: number) => { id: string; unread: number; mentions: number; muted?: boolean }[]>('caViewRooms');
  const rooms = [
    { id: 'a', workspace: 'W', unread: 3, mentions: 1 },
    { id: 'b', workspace: 'W', unread: 2, mentions: 0 },
    { id: 'c', workspace: '', unread: 4, mentions: 0 },
  ];
  it('applies a workspace choice to channels with none of their own, and lets a channel override it', () => {
    const prefs = { 'ws:W': { level: 'mentions', until: 0 }, b: { level: 'all', until: 0 } };
    const out = view(rooms, prefs, 1);
    expect(out.map((r) => [r.id, r.unread, r.mentions])).toEqual([['a', 1, 1], ['b', 2, 0], ['c', 4, 0]]);
    const muted = view(rooms, { 'ws:W': { level: 'default', until: -1 } }, 1);
    expect(muted.map((r) => [r.id, r.unread, !!r.muted])).toEqual([['a', 0, true], ['b', 0, true], ['c', 4, false]]);
  });
});

describe('closed direct messages', () => {
  const dms = fn<(rooms: unknown, active: string | null, closed?: Record<string, number>) => { id: string }[]>('caDmItems');
  const clean = fn<(raw: unknown) => Record<string, number>>('caClosedDms');
  const rooms = [
    { id: 'a', kind: 'dm', dm: ['user', 'x'], members: [{ sessionId: 'x', name: 'x' }], lastMessageAt: 100 },
    { id: 'b', kind: 'dm', dm: ['user', 'y'], members: [{ sessionId: 'y', name: 'y' }], lastMessageAt: 50 },
  ];
  it('hides a closed one until it is the open one or something newer arrived', () => {
    expect(dms(rooms, null, { b: 60 }).map((r) => r.id)).toEqual(['a']);
    expect(dms(rooms, 'b', { b: 60 }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(dms(rooms, null, { b: 40 }).map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('cleans what was stored', () => {
    expect(clean('nope')).toEqual({});
    expect(clean({ a: 5, b: 'x', c: -1, __proto__: 1 })).toEqual({ a: 5 });
  });
});

describe('profile icons', () => {
  const icons = fn<(c: unknown) => Map<string, string>>('caProfileIcons');
  it('takes the employee icon before a temporary agent\'s, and ignores records without a session or an icon', () => {
    const m = icons({
      employees: [{ sessionId: 's1', icon: '\u{1F989}' }, { sessionId: '', icon: 'x' }, { sessionId: 's2', icon: ' ' }],
      temporaryAgents: [{ sessionId: 's1', icon: 'T' }, { sessionId: 's3', icon: '\u{1F9ED}' }],
    });
    expect([...m]).toEqual([['s1', '\u{1F989}'], ['s3', '\u{1F9ED}']]);
    expect(icons(undefined).size).toBe(0);
  });
});

describe('image icons', () => {
  const image = fn<(icon: unknown, urlFn?: (p: string) => string) => string>('caIconImage');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const profile = fn<(raw: unknown) => { image: string }>('caProfile');
  it('accepts a raster data URL and an /api path, and nothing else', () => {
    expect(image(png)).toBe(png);
    expect(image('data:image/webp;base64,AAAA')).toContain('webp');
    expect(image('img:/api/v1/avatars/abc-123')).toBe('/api/v1/avatars/abc-123');
    expect(image('img:/api/v1/avatars/abc', (p) => `/base${p}`)).toBe('/base/api/v1/avatars/abc');
    for (const bad of [
      'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'javascript:alert(1)', 'http://x/y.png', 'https://x/y.png',
      'img:http://x/y.png', 'img://evil/x', 'img:/other/x', 'img:/api/../etc', 'img:/api/a b', 'data:image/png;base64,AAAA"onerror=x', '\u{1F989}', '', undefined, 42,
      `data:image/png;base64,${'A'.repeat(170000)}`,
    ]) expect(image(bad), String(bad).slice(0, 40)).toBe('');
  });
  it('keeps a stored profile picture only if it is a data URL image', () => {
    expect(profile({ image: png }).image).toBe(png);
    expect(profile({ image: 'img:/api/v1/avatars/x' }).image).toBe('');
    expect(profile({ image: 'http://x/y.png' }).image).toBe('');
  });
});

describe('agent avatars from the server', () => {
  const image = fn<(icon: unknown) => string>('caIconImage');
  const avatars = fn<(c: unknown) => Map<string, string>>('caProfileAvatars');
  it('accepts the stored-avatar URL (with a version) and nothing that points elsewhere', () => {
    expect(image('/api/avatars/abc-123?v=7')).toBe('/api/avatars/abc-123?v=7');
    expect(image('/api/v1/avatars/abc')).toBe('/api/v1/avatars/abc');
    // The server versions an upload with Date.now() (13 digits).
    expect(image('/api/avatars/abc-123?v=1760500000000')).toBe('/api/avatars/abc-123?v=1760500000000');
    for (const bad of ['/api/avatars/../x', '/api/avatars/a?v=x', '/api/avatars/a?v=1&x=2', '/api/other/a', '//evil/api/avatars/a', 'https://h/api/avatars/a']) expect(image(bad), bad).toBe('');
  });
  it('reads the avatar off employee and temporary records, employee first', () => {
    const m = avatars({
      employees: [{ sessionId: 's1', avatar: '/api/avatars/s1?v=2' }, { sessionId: 's2', avatar: 'http://x/y.png' }],
      temporaryAgents: [{ sessionId: 's1', avatar: '/api/avatars/other' }, { sessionId: 's3', avatar: '/api/avatars/s3' }],
    });
    expect([...m]).toEqual([['s1', '/api/avatars/s1?v=2'], ['s3', '/api/avatars/s3']]);
  });
});

describe('notification inheritance after a timed mute ends', () => {
  const view = fn<(rooms: unknown, p: unknown, now: number) => { id: string; unread: number; muted?: boolean }[]>('caViewRooms');
  it('a channel whose own timed mute has expired follows its workspace again', () => {
    const rooms = [{ id: 'a', workspace: 'W', unread: 3, mentions: 0 }];
    const prefs = { a: { level: 'default', until: 100 }, 'ws:W': { level: 'default', until: -1 } };
    expect(view(rooms, prefs, 50)[0]).toMatchObject({ unread: 0, muted: true });
    expect(view(rooms, prefs, 500)[0]).toMatchObject({ unread: 0, muted: true });
  });
});

describe('machine load readout', () => {
  const view = fn<(s: unknown) => { key: string; label: string; value: number; title: string; level: string }[]>('caStatsView');
  it('lists CPU and memory, adds the GPU only when there is one, and colours by load', () => {
    const v = view({ cpu: 8, memory: { usedMB: 17704, totalMB: 64204, percent: 28 } });
    expect(v.map((x) => [x.key, x.value, x.level])).toEqual([['cpu', 8, 'ok'], ['mem', 28, 'ok']]);
    expect(v[1].title).toBe('Memory 28% (17.3 GB of 62.7 GB)');
    const g = view({ cpu: 75.4, memory: { percent: 95 }, gpu: { available: true, utilization: 91, memoryUsedMb: 8192, memoryTotalMb: 24576 } });
    expect(g.map((x) => [x.key, x.value, x.level])).toEqual([['cpu', 75, 'warn'], ['mem', 95, 'high'], ['gpu', 91, 'high']]);
    expect(g[2].title).toBe('GPU 91%, memory 8.0 GB of 24.0 GB');
    expect(view({ cpu: 5, gpu: { available: false, utilization: 50 } }).map((x) => x.key)).toEqual(['cpu']);
  });
  it('copes with nothing, junk and out-of-range numbers', () => {
    expect(view(undefined)).toEqual([]);
    expect(view({ cpu: 'x', memory: { percent: null } })).toEqual([]);
    expect(view({ cpu: 250 })[0].value).toBe(100);
    expect(view({ cpu: -5 })[0].value).toBe(0);
  });
});

describe('caPollView', () => {
  const view = fn<(poll: unknown, now?: number, me?: string) => { open: boolean; total: number; multi: boolean; closesAt: number; rows: Array<{ id: string; count: number; pct: number; mine: boolean; rec: boolean; leading: boolean; voters: string[] }> }>('caPollView');
  const poll = (extra: Record<string, unknown> = {}) => ({
    question: 'q',
    options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }, { id: 'o3', label: 'C' }],
    recommended: 'o2',
    votes: { user: ['o1'], s1: ['o1'], s2: ['o2'] },
    ...extra,
  });

  it('counts, shares, your choice, the recommendation and the leader', () => {
    const v = view(poll(), 5);
    expect(v.open).toBe(true);
    expect(v.total).toBe(3);
    expect(v.rows.map((r) => [r.count, r.pct, r.mine, r.rec, r.leading])).toEqual([
      [2, 67, true, false, true],
      [1, 33, false, true, false],
      [0, 0, false, false, false],
    ]);
    expect(v.rows[0].voters).toEqual(['user', 's1']);
  });

  it('is closed when closed early or past its closing time, and tolerates missing votes', () => {
    expect(view(poll({ closed: { at: 1, by: 'user' } })).open).toBe(false);
    expect(view(poll({ closesAt: 100 }), 99).open).toBe(true);
    expect(view(poll({ closesAt: 100 }), 100).open).toBe(false);
    const empty = view({ question: 'q', options: [{ id: 'o1', label: 'A' }] });
    expect(empty.total).toBe(0);
    expect(empty.rows[0]).toMatchObject({ count: 0, pct: 0, leading: false });
  });
});

describe('caTypingText', () => {
  const text = fn<(names: string[]) => string>('caTypingText');
  it('says who is typing, for one, two, three and many', () => {
    expect(text(['Acme'])).toBe('Acme is typing\u2026');
    expect(text(['Acme', 'Pat'])).toBe('Acme and Pat are typing\u2026');
    expect(text(['Acme', 'Pat', 'Quinn'])).toBe('Acme, Pat and Quinn are typing\u2026');
    expect(text(['Acme', 'Pat', 'Quinn', 'Rae', 'Sam'])).toBe('Acme, Pat and 3 others are typing\u2026');
  });
});

describe('chatCountsAfterMessage and a mention of the owner', () => {
  const room = { id: 'r', unread: 0, mentions: 0 };
  const post = (text: string) => ({ from: { kind: 'agent' }, to: 'all', text });
  const counted = (text: string, owner: string[] = ['Pat']) => chatCountsAfterMessage(room, post(text), owner).mentions;

  it('counts @user, @owner, the owner\u2019s name, @everyone, @all and @here, in any case', () => {
    for (const t of ['@user look', '@OWNER look', 'hi @pat, look', '@Pat', 'ok @everyone', '@all hands', 'now @here']) expect(counted(t), t).toBe(1);
  });

  it('does not count part of a word or an address, another name, or the owner\u2019s name when none is known', () => {
    for (const t of ['pat@user.io', '@users', '@patrick', '@allies', 'me@here.com', 'no names']) expect(counted(t), t).toBe(0);
    expect(counted('@Pat', [])).toBe(0);
    expect(counted('@user', [])).toBe(1);
  });

  it('still counts an older message addressed to the user, and every message of a direct message with them', () => {
    expect(chatCountsAfterMessage(room, { from: { kind: 'agent' }, to: ['user'], text: 'x' }, ['Pat']).mentions).toBe(1);
    expect(chatCountsAfterMessage({ ...room, kind: 'dm', dm: ['user', 'a'] }, post('plain'), []).mentions).toBe(1);
  });
});

describe('the owner\'s channel order', () => {
  it('places the channels with a position first, by position, and the rest after in the order given', () => {
    const list = [{ id: 'a' }, { id: 'b', position: 2 }, { id: 'c' }, { id: 'd', position: 1 }, { id: 'e', position: 0 }];
    expect(caByPosition(list).map((r) => r.id)).toEqual(['d', 'b', 'a', 'c', 'e']);
    expect(caByPosition([]).length).toBe(0);
  });

  it('shows the placed order in the sidebar, within each category', () => {
    const rooms = [
      room('a', 0, 0, { position: 2 }),
      room('b', 0, 0, { position: 1 }),
      room('c', 0, 0, { category: 'Eng', position: 2 }),
      room('d', 0, 0, { category: 'Eng', position: 1 }),
    ];
    expect(caChannelItems(rooms, '', {}).filter((i) => i.type === 'room').map((i) => i.id)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('moves a channel one step among those of its category, and not past the edge', () => {
    const cat = (id: string) => (id === 'x' || id === 'y' ? 'Eng' : '');
    expect(caMoveWithin(['a', 'x', 'b', 'y'], 'b', -1, cat)).toEqual(['b', 'x', 'a', 'y']);
    expect(caMoveWithin(['a', 'x', 'b', 'y'], 'x', 1, cat)).toEqual(['a', 'y', 'b', 'x']);
    const same = ['a', 'x', 'b', 'y'];
    expect(caMoveWithin(same, 'a', -1, cat)).toBe(same);
    expect(caMoveWithin(same, 'y', 1, cat)).toBe(same);
    expect(caMoveWithin(same, 'nope', 1, cat)).toBe(same);
  });

  it('moves a channel before or after another', () => {
    expect(caMoveBeside(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b']);
    expect(caMoveBeside(['a', 'b', 'c'], 'a', 'c', true)).toEqual(['b', 'c', 'a']);
    const same = ['a', 'b', 'c'];
    expect(caMoveBeside(same, 'a', 'a', true)).toBe(same);
    expect(caMoveBeside(same, 'a', 'zz', true)).toBe(same);
  });
});

