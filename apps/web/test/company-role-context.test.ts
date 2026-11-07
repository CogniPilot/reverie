import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService } from '../src/chatroom-service.js';
import { employeeProfileContext, employeeBriefContext } from '../src/company-types.js';
import { buildBriefing, buildDeliveryLine, MAX_DELIVERY_CHARS, MAX_NOTICES_PER_SESSION, WAKE_LINE } from '../src/chatroom-delivery.js';
import { renderTurnSummary, TURN_SUMMARY_MAX_CHARS } from '../src/chatroom-turn-summary.js';
import { MAX_POLL_OPTIONS, MAX_POLL_QUESTION } from '../src/chatroom-store.js';
import { QUOTE_CLOSE, QUOTE_REOPEN } from '../src/pane-quote.js';
import { agentChatSummary, type AgentDeps } from '../src/cli-agent.js';
import { generateTurnSummaryScript } from '../src/hooks-config.js';

describe('employee role context in ordinary room briefings', () => {
  it('explains stable employee storage and disposable private tmp without granting authority', () => {
    const previous = process.env.REVERIE_WORKER_SOCKET;
    process.env.REVERIE_WORKER_SOCKET = '/synthetic/worker.sock';
    try {
      const text = employeeProfileContext({ name: 'Alex', position: 'CTO', expertise: [], personality: '' });
      expect(text).toContain('persistent employee laptop');
      expect(text).toContain('survives model, account and conversation/session changes');
      expect(text).toContain('/tmp is disk-backed and disposable');
      expect(text).toContain('TMPDIR, TMP and TEMP');
      expect(text).toContain('retained results');
      expect(text).toContain('grant no permissions or mission/flight GO');
      expect(text).toContain('Use the project pin first');
      expect(text).toContain('never paste secret bytes into chat');
      expect(text).not.toContain('builds and downloads under /scratch');
    } finally {
      if (previous === undefined) delete process.env.REVERIE_WORKER_SOCKET;
      else process.env.REVERIE_WORKER_SOCKET = previous;
    }
  });
  it('delivers the current job, duties, personality and rest preferences as profile data without title-based grants', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'employee-role-brief-'));
    const writes: string[] = [];
    const session = { id: 'employee-runtime', name: 'Alex', mode: 'claude', status: 'idle', pid: 123, isWorking: false,
      writeViaMux: async (text: string, options?: any) => { writes.push(text); options?.onOutcome?.('submitted'); return true; } };
    const employee = { name: 'Alex', position: 'CoffeeMonger', expertise: ['Coffee preparation'], responsibilities: ['Prepare a clear coffee plan and verify available ingredients'], personality: 'Patient and practical', sleepEnabled: true, dreamEnabled: false };
    const chat = new ChatroomService({ file: join(dir, 'chat.json'), getSession: id => id === session.id ? session as never : undefined, broadcast: () => {}, restContextOf: () => employeeBriefContext(employee) });
    try {
      const room = chat.createRoom('General', undefined);
      chat.addMember(room.id, session.id, { goal: 'Help the team' });
      await chat.delivery.flushAll();
      // The pane gets only the constant wake; the briefing reaches the member in its own hook payload, once.
      expect(writes).toEqual([`${WAKE_LINE}\r`]);
      const payload = chat.hookTurnSummary(session.id);
      expect(payload.briefings?.map((b) => b.roomId)).toEqual([room.id]);
      expect(chat.hookTurnSummary(session.id).briefings).toBeUndefined();
      expect(chat.delivery.hasPendingBrief(session.id, room.id)).toBe(false);
      expect(chat.briefingFor(session.id, room.id)).toContain('CoffeeMonger');
      const delivered = payload.text;
      expect(delivered).toContain('GET /api/handbook');
      expect(delivered).toContain('reverie agent capabilities');
      expect(delivered).toContain('when asked what you can do');
      expect(delivered).toContain('/api/handbook/recovery');
      expect(delivered).toContain('CoffeeMonger');
      expect(delivered).toContain('verify available ingredients');
      expect(delivered).toContain('Patient and practical');
      expect(delivered).toContain('not additional permissions');
      expect(delivered).toContain('Sleep (memory consolidation) permitted');
      expect(delivered).toContain('Dream (creative exploration) not permitted');
      expect(delivered).toContain('not instructions to sleep or dream now');
      expect(delivered).toContain('grant no hiring');
    } finally { await chat.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('keeps a briefing pending after its wake is typed and submitted, until the hook payload includes it, and never retypes it', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'employee-brief-hook-'));
    const writes: string[] = [];
    const session = { id: 'employee-runtime', name: 'Alex', mode: 'claude', status: 'idle', pid: 123, isWorking: false,
      writeViaMux: async (text: string, options?: any) => { writes.push(text); options?.onOutcome?.('submitted'); return true; } };
    const chat = new ChatroomService({ file: join(dir, 'chat.json'), getSession: id => id === session.id ? session as never : undefined, broadcast: () => {} });
    try {
      const room = chat.createRoom('General', undefined);
      chat.addMember(room.id, session.id, { goal: `Help the team ${'with a very long goal '.repeat(200)}` });
      await chat.delivery.flushAll();
      expect(writes).toEqual([`${WAKE_LINE}\r`]);
      // A submitted wake is not the briefing reaching the member: it stays pending, and wakes nobody again.
      expect(chat.delivery.hasPendingBrief(session.id, room.id)).toBe(true);
      expect(chat.delivery.pendingFor(session.id)).toBe(0);
      (chat.delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear();
      await chat.delivery.flushAll();
      expect(writes).toHaveLength(1);
      // An internal summary (the digest's) does not consume it; only the member's own hook payload does.
      expect(chat.turnSummary(session.id).briefings).toBeUndefined();
      expect(chat.delivery.hasPendingBrief(session.id, room.id)).toBe(true);
      const payload = chat.hookTurnSummary(session.id);
      const [briefing] = payload.briefings ?? [];
      expect(briefing?.roomId).toBe(room.id);
      expect(payload.text.startsWith(`Reverie room briefing for ${briefing!.room}`)).toBe(true);
      expect(payload.text.length).toBeLessThanOrEqual(TURN_SUMMARY_MAX_CHARS);
      // With nothing else pending, the briefing takes the payload and arrives whole, within the cap.
      expect(briefing!.truncated).toBe(false);
      expect(chat.delivery.hasPendingBrief(session.id, room.id)).toBe(false);
      expect(chat.hookTurnSummary(session.id).briefings).toBeUndefined();
      // The read path always has the whole current briefing.
      expect(chat.briefingFor(session.id, room.id)).toContain('Help the team');
      expect(() => chat.briefingFor('someone-else', room.id)).toThrow('Not a member');
    } finally { await chat.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('an OpenCode member (no verified composer glyph) gets nothing typed but still gets its briefing through the hook', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'employee-brief-opencode-'));
    const writes: string[] = [];
    const session = { id: 'employee-runtime', name: 'Alex', mode: 'opencode', status: 'idle', pid: 123, isWorking: false,
      writeViaMux: async (text: string, options?: any) => { writes.push(text); options?.onOutcome?.('submitted'); return true; } };
    const chat = new ChatroomService({ file: join(dir, 'chat.json'), getSession: id => id === session.id ? session as never : undefined, broadcast: () => {} });
    try {
      const room = chat.createRoom('General', undefined);
      chat.addMember(room.id, session.id, { goal: 'Help the team' });
      chat.post(room.id, { kind: 'user', name: 'Owner' }, 'welcome aboard', [session.id]);
      await chat.delivery.flushAll();
      expect(writes).toEqual([]);
      // The message is dropped from the pane queue (it stays in the room history); the briefing waits for the hook.
      expect(chat.delivery.pendingFor(session.id)).toBe(0);
      expect(chat.delivery.hasPendingBrief(session.id, room.id)).toBe(true);
      const payload = chat.hookTurnSummary(session.id);
      expect(payload.briefings?.map((b) => b.roomId)).toEqual([room.id]);
      expect(payload.text).toContain('Help the team');
      expect(chat.delivery.hasPendingBrief(session.id, room.id)).toBe(false);
    } finally { await chat.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('keeps the whole hook payload within the client cap: a long briefing is cut, busy messages are compressed, and the hook emits it', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'employee-brief-cap-'));
    const session = { id: 'employee-runtime', name: 'Alex', mode: 'claude', status: 'idle', pid: 123, isWorking: true,
      writeViaMux: async () => true };
    const chat = new ChatroomService({ file: join(dir, 'chat.json'), getSession: id => id === session.id ? session as never : undefined, broadcast: () => {} });
    try {
      const room = chat.createRoom('General', undefined);
      chat.addMember(room.id, session.id, {});
      for (let i = 0; i < 12; i++) chat.post(room.id, { kind: 'user', name: 'Owner' }, `request ${i} ${'detail '.repeat(30)}`, [session.id]);
      const shown = vi.spyOn(chat.delivery, 'briefShown');
      const pending = vi.spyOn(chat.delivery, 'pendingBriefs').mockReturnValue([{ roomId: room.id, roomName: 'General', text: 'x'.repeat(5000) }]);
      const payload = chat.hookTurnSummary(session.id);
      expect(payload.text.length).toBeLessThanOrEqual(TURN_SUMMARY_MAX_CHARS);
      expect(payload.briefings?.[0]).toMatchObject({ roomId: room.id, truncated: true });
      expect(payload.text).toContain(`the whole briefing: GET /api/chatrooms/${room.id}/briefing`);
      expect(payload.text).toContain('Reverie pending messages');
      expect(shown).toHaveBeenCalledWith(session.id, [room.id]);
      // Through the real CLI hook client: it emits the payload instead of refusing it as oversized.
      pending.mockReturnValue([{ roomId: room.id, roomName: 'General', text: 'y'.repeat(5000) }]);
      const out: string[] = [];
      const deps: AgentDeps = { ctx: { apiUrl: 'http://fixture', selfId: session.id }, json: false,
        io: { out: (text) => out.push(text), err: () => {} },
        request: async () => ({ status: 200, text: '', json: { success: true, data: chat.hookTurnSummary(session.id) } }) };
      expect(await agentChatSummary(deps, 'UserPromptSubmit')).toBe(0);
      const context = JSON.parse(out[0]!).hookSpecificOutput.additionalContext as string;
      expect(context.length).toBeLessThanOrEqual(TURN_SUMMARY_MAX_CHARS);
      expect(context.startsWith('Reverie room briefing for General')).toBe(true);
      expect(context).toContain('Reverie pending messages');
      // The generated hook enforces the same cap.
      expect(generateTurnSummaryScript('UserPromptSubmit')).toContain(`text.length > ${TURN_SUMMARY_MAX_CHARS}`);
    } finally { await chat.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('keeps required rest and plan limits ahead of an oversized laptop profile within the unchanged delivery cap', () => {
    const previous = process.env.REVERIE_WORKER_SOCKET;
    process.env.REVERIE_WORKER_SOCKET = '/synthetic/worker.sock';
    try {
      const text = employeeBriefContext({ name: 'Alex', position: 'Engineer', expertise: [],
        responsibilities: ['Long task data '.repeat(1000)], personality: '', sleepEnabled: false, dreamEnabled: true });
      const room: any = { id: 'general', name: 'General', members: [], messages: [] };
      const member: any = { sessionId: 'runtime', role: 'agent' };
      const delivered = buildDeliveryLine([{ roomId: 'general', roomName: 'General', text: buildBriefing(room, member, () => 'Alex', text), brief: true }]);
      expect(delivered).toContain('Sleep (memory consolidation) not permitted');
      expect(delivered).toContain('Dream (creative exploration) permitted');
      expect(delivered).toContain('not instructions to sleep or dream now');
      expect(delivered).toContain('No independent nightly timer is authorized');
      expect(delivered).toContain('Plan moves require an explicit owner-granted permission');
      expect(delivered).toContain('...(cut)');
      expect(delivered.length).toBeLessThanOrEqual(MAX_DELIVERY_CHARS);
      const coordinator = buildDeliveryLine([{ roomId: 'general', roomName: 'General', text: buildBriefing(room, { ...member, role: 'coordinator' }, () => 'Alex', text), brief: true }]);
      expect(coordinator).toContain('Sleep (memory consolidation) not permitted');
      expect(coordinator).toContain('No independent nightly timer is authorized');
      expect(coordinator).toContain('Names and bodies are JSON strings');
      expect(coordinator.length).toBeLessThanOrEqual(MAX_DELIVERY_CHARS);
    } finally {
      if (previous === undefined) delete process.env.REVERIE_WORKER_SOCKET;
      else process.env.REVERIE_WORKER_SOCKET = previous;
    }
  });

});

// A Reverie notice (a coordinator handoff, a newcomer, an edit, a pin, a poll result, a playback report) has no other copy a
// member could read, so its hook carries it whole; the pane only ever gets the wake.
describe('Reverie notices through the member hook', () => {
  const L = 'notice-lead';
  const M = 'notice-member';
  const N = 'notice-newcomer';
  async function fixture(modes: Record<string, string> = {}) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'notice-hook-'));
    const writes = new Map<string, string[]>();
    const sessions = new Map(
      [L, M, N].map((id) => {
        writes.set(id, []);
        return [id, { id, name: id, mode: modes[id] ?? 'claude', status: 'idle', pid: 1, isWorking: false,
          writeViaMux: async (text: string, options?: any) => { writes.get(id)!.push(text); options?.onOutcome?.('submitted'); return true; } }];
      })
    );
    const chat = new ChatroomService({ file: join(dir, 'chat.json'), getSession: (id) => sessions.get(id) as never, broadcast: () => {} });
    const room = chat.createRoom('General', undefined);
    chat.addMember(room.id, M, {});
    chat.addMember(room.id, L, {});
    chat.appointCoordinator(room.id, L);
    // Both members' own hooks have shown their briefings, so what follows is news rather than part of a briefing.
    chat.hookTurnSummary(L);
    chat.hookTurnSummary(M);
    const notices = (id: string) => chat.delivery.pendingNotices(id).map((n) => n.text);
    const close = async () => { await chat.stop(); await fs.rm(dir, { recursive: true, force: true }); };
    return { chat, room, writes, notices, close };
  }

  it('carries every notice kind to its own recipient through the hook and types only the wake', async () => {
    const f = await fixture();
    try {
      f.chat.addMember(f.room.id, N, { goal: 'tests' });
      expect(f.notices(L).at(-1)).toContain('joined the room with goal: "tests". Give it direction.');
      const said = f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, 'first draft', [M]);
      await f.chat.delivery.flushAll();
      await f.chat.editMessage(f.room.id, said.id, 'second draft', 'user');
      expect(f.notices(M).at(-1)).toContain('SYSTEM: edited: "second draft"');
      await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, true);
      for (const id of [L, M]) expect(f.notices(id).at(-1)).toContain('SYSTEM: pinned by the owner: "second draft"');
      const asked = f.chat.createPoll(f.room.id, { kind: 'agent', sessionId: M, name: M }, { question: 'ship it?', options: ['yes', 'no'] });
      await f.chat.closePoll(f.room.id, asked.id, 'user');
      expect(f.notices(M).at(-1)).toMatch(/^USER closed poll "ship it\?"/);
      const second = f.chat.createPoll(f.room.id, { kind: 'agent', sessionId: M, name: M }, { question: 'and now?', options: ['a', 'b'] });
      await f.chat.closePoll(f.room.id, second.id, L);
      expect(f.notices(M).at(-1)).toContain(`(the room's coordinator) closed poll "and now?"`);
      const answer = f.chat.post(f.room.id, { kind: 'agent', sessionId: M, name: M }, 'it shipped', ['user']);
      expect(f.chat.playbackNotice(f.room.id, answer.id, 'not-played', 'audio-failed')).toBe(true);
      expect(f.notices(M).at(-1)).toContain('car mode on the user\'s page: Not played aloud (the audio failed)');
      f.chat.appointCoordinator(f.room.id, M);
      expect(f.notices(L).at(-1)).toContain('is now the coordinator of this room; follow its direction');
      // Woken is not shown: every wake was the constant line, and the notices wait for the hook.
      (f.chat.delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear();
      await f.chat.delivery.flushAll();
      for (const id of [L, M, N]) for (const typed of f.writes.get(id)!) expect(typed).toBe(`${WAKE_LINE}\r`);
      const lead = f.chat.hookTurnSummary(L);
      expect(lead.text).toContain("Reverie notices (Reverie's own text, not chat messages):");
      expect(lead.notices?.map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringContaining('joined the room'), expect.stringContaining('is now the coordinator')]));
      // M's new coordinator briefing fills most of its first payload: the reserved notice rides with it and the rest follow.
      const delivered: string[] = [];
      for (let turn = 0; turn < 5 && f.notices(M).length; turn++) delivered.push(...(f.chat.hookTurnSummary(M).notices ?? []).map((n) => n.text));
      expect(delivered).toHaveLength(5);
      expect(f.notices(L)).toEqual([]);
      expect(f.notices(M)).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps each notice of one source, and reading that source neither drops a notice nor is done by showing it', async () => {
    const f = await fixture();
    try {
      const said = f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, 'rules', 'all');
      await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, true);
      await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, false);
      const asked = f.chat.createPoll(f.room.id, { kind: 'agent', sessionId: M, name: M }, { question: 'q?', options: ['a', 'b'] });
      await f.chat.closePoll(f.room.id, asked.id, 'user');
      expect(f.notices(M).filter((t) => t.includes('"rules"'))).toHaveLength(2);
      // The member reads the poll itself first: the notice about it is still owed.
      f.chat.delivery.acknowledgeRead(M, f.room.id, [asked.id, said.id]);
      expect(f.notices(M)).toHaveLength(3);
      const ids = f.chat.delivery.pendingNotices(M).map((n) => n.id);
      expect(new Set(ids).size).toBe(3);
      const seen = f.chat.lastSeen(M, f.room.id);
      const mark = vi.spyOn(f.chat, 'markSeen');
      const ack = vi.spyOn(f.chat.delivery, 'acknowledgeRead');
      expect(f.chat.hookTurnSummary(M).notices).toHaveLength(3);
      expect(mark).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(f.chat.lastSeen(M, f.room.id)).toEqual(seen);
    } finally { await f.close(); }
  });

  it('a member with no verified composer glyph gets nothing typed and still gets its notices through the hook', async () => {
    const f = await fixture({ [M]: 'opencode' });
    try {
      const said = f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, 'rules', 'all');
      await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, true);
      await f.chat.delivery.flushAll();
      expect(f.writes.get(M)).toEqual([]);
      expect(f.notices(M)).toHaveLength(1);
      expect(f.chat.hookTurnSummary(M).text).toContain('SYSTEM: pinned by the owner: "rules"');
    } finally { await f.close(); }
  });

  it('bounds the notices it keeps and says how many older ones were dropped', async () => {
    const f = await fixture();
    try {
      const said = f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, 'rules', 'all');
      for (let i = 0; i < MAX_NOTICES_PER_SESSION + 5; i++) await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, i % 2 === 0);
      expect(f.notices(M)).toHaveLength(MAX_NOTICES_PER_SESSION);
      expect(f.chat.hookTurnSummary(M).text).toContain('; 5 older ones were dropped):');
    } finally { await f.close(); }
  });

  it('reserves a whole notice beside a long briefing and busy messages within the client cap, keeps later notices, and the hook emits it', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 12; i++) f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, `request ${i} ${'detail '.repeat(30)}`, [M]);
      const said = f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, 'rules', 'all');
      for (let i = 0; i < 8; i++) await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, i % 2 === 0);
      const pending = vi.spyOn(f.chat.delivery, 'pendingBriefs').mockReturnValue([{ roomId: f.room.id, roomName: 'General', text: 'x'.repeat(5000) }]);
      const out: string[] = [];
      const deps: AgentDeps = { ctx: { apiUrl: 'http://fixture', selfId: M }, json: false,
        io: { out: (text) => out.push(text), err: () => {} },
        request: async () => ({ status: 200, text: '', json: { success: true, data: f.chat.hookTurnSummary(M) } }) };
      expect(await agentChatSummary(deps, 'UserPromptSubmit')).toBe(0);
      const context = JSON.parse(out[0]!).hookSpecificOutput.additionalContext as string;
      expect(context.length).toBeLessThanOrEqual(TURN_SUMMARY_MAX_CHARS);
      expect(context.startsWith('Reverie room briefing for General')).toBe(true);
      expect(context).toContain('the whole briefing: GET /api/chatrooms/');
      expect(context).toContain('SYSTEM: pinned by the owner: "rules"');
      expect(context).toContain('Reverie pending messages');
      // Only whole notices were shown; the ones that did not fit wait for the next turn.
      const left = f.notices(M).length;
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(8);
      pending.mockReturnValue([]);
      expect(f.chat.hookTurnSummary(M).notices).toHaveLength(left);
    } finally { await f.close(); }
  });

  /** One hook call through the CLI client, as a seat runs it: what it emits, and the summary it came from. */
  async function hook(chat: ChatroomService, id: string) {
    const out: string[] = [];
    let summary: ReturnType<ChatroomService['hookTurnSummary']> | undefined;
    const deps: AgentDeps = { ctx: { apiUrl: 'http://fixture', selfId: id }, json: false,
      io: { out: (text) => out.push(text), err: () => {} },
      request: async () => { summary = chat.hookTurnSummary(id); return { status: 200, text: '', json: { success: true, data: summary } }; } };
    expect(await agentChatSummary(deps, 'UserPromptSubmit')).toBe(0);
    const context = out.length ? (JSON.parse(out[0]!).hookSpecificOutput.additionalContext as string) : '';
    expect(context.length).toBeLessThanOrEqual(TURN_SUMMARY_MAX_CHARS);
    return { context, summary: summary! };
  }
  /** Quotes that are not escaped: a fragment that keeps user text quoted has an even number of them. */
  const bareQuotes = (text: string) => { let n = 0; for (let i = 0; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') n++; } return n; };
  // Each label quotes to six characters per zero-width space, so the closed poll's notice is far longer than the whole payload.
  const wideLabels = Array.from({ length: MAX_POLL_OPTIONS }, (_, i) => `${i}${'​"'.repeat(49)}`);

  it('keeps a maximal escaped poll a whole entry within the cap, its options given way to the exact message read', async () => {
    const f = await fixture();
    try {
      const asked = f.chat.createPoll(f.room.id, { kind: 'user', name: 'Owner' }, { question: '"'.repeat(MAX_POLL_QUESTION), options: wideLabels }, [M]);
      const { context, summary } = await hook(f.chat, M);
      const entry = summary.messages.find((m) => m.messageId === asked.id);
      expect(entry).toBeDefined();
      expect(entry!.poll).toBeUndefined();
      expect(entry!.detail).toBe(`reverie agent chat read -r ${f.room.id} --message ${asked.id}`);
      for (const line of context.split('\n').filter((l) => l.startsWith('{'))) expect(() => JSON.parse(line)).not.toThrow();
      expect(context).toContain(`--message ${asked.id}`);
    } finally { await f.close(); }
  });

  it('never leaves a dropped entry in the text: at the floor only the count remains', () => {
    const entry = { roomId: 'r', room: 'General', messageId: 'm1', sender: 'Owner', role: 'owner', at: 1, excerpt: 'x', state: 'unread' as const,
      priority: 6, poll: 'p'.repeat(5000) };
    const fit = renderTurnSummary('ring', [{ ...entry }], undefined, undefined, 1, 1200);
    expect(fit.text.length).toBeLessThanOrEqual(1200);
    expect(fit.messages[0]?.detail).toBe('reverie agent chat read -r r --message m1');
    const floor = renderTurnSummary('ring', [{ ...entry }], undefined, undefined, 1, 0);
    expect(floor.messages).toEqual([]);
    expect(floor.text).toMatch(/1 not shown \(agent chat pending lists them\)\.$/);
    expect(floor.text).not.toContain('ppp');
  });

  it('delivers a notice longer than the whole payload in quoted parts under one identity, then the notice behind it', async () => {
    const f = await fixture();
    try {
      const asked = f.chat.createPoll(f.room.id, { kind: 'agent', sessionId: M, name: M }, { question: '"'.repeat(MAX_POLL_QUESTION), options: wideLabels });
      await f.chat.closePoll(f.room.id, asked.id, 'user');
      const said = f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, 'rules', 'all');
      await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, true);
      const [long, next] = f.chat.delivery.pendingNotices(M);
      expect(long.text.length).toBeGreaterThan(TURN_SUMMARY_MAX_CHARS);
      expect(next.text).toContain('"rules"');
      const parts: NonNullable<ReturnType<ChatroomService['hookTurnSummary']>['notices']> = [];
      let after = false;
      for (let turn = 0; turn < 12 && f.notices(M).length; turn++) {
        const { context, summary } = await hook(f.chat, M);
        for (const n of summary.notices ?? []) {
          if (n.text.includes('"rules"')) { after = true; continue; }
          expect(after).toBe(false); // nothing overtakes the notice still in parts
          parts.push(n);
          expect(context).toContain(n.text);
          expect(bareQuotes(n.text) % 2).toBe(0);
        }
        // While parts are owed the notice keeps its one identity at the head of the queue.
        if (parts.at(-1)?.more) expect(f.chat.delivery.pendingNotices(M)[0].id).toBe(long.id);
      }
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.slice(0, -1).every((n) => n.more)).toBe(true);
      expect(parts.at(-1)!.more).toBeUndefined();
      expect(parts.slice(1).every((n) => n.continued)).toBe(true);
      let joined = '';
      for (const n of parts) {
        let text = n.text;
        if (joined.endsWith(QUOTE_CLOSE) && text.startsWith(QUOTE_REOPEN)) { joined = joined.slice(0, -QUOTE_CLOSE.length); text = text.slice(QUOTE_REOPEN.length); }
        joined += text;
      }
      expect(joined).toBe(long.text);
      expect(after).toBe(true);
      expect(f.notices(M)).toEqual([]);
    } finally { await f.close(); }
  });

  it('reserves no more than a part of a long notice beside a long briefing, so neither slice goes negative', async () => {
    const f = await fixture();
    try {
      const asked = f.chat.createPoll(f.room.id, { kind: 'agent', sessionId: M, name: M }, { question: '"'.repeat(MAX_POLL_QUESTION), options: wideLabels });
      await f.chat.closePoll(f.room.id, asked.id, 'user');
      vi.spyOn(f.chat.delivery, 'pendingBriefs').mockReturnValue([{ roomId: f.room.id, roomName: 'General', text: 'x'.repeat(5000) }]);
      const { context, summary } = await hook(f.chat, M);
      expect(context.startsWith('Reverie room briefing for General')).toBe(true);
      expect(summary.briefings?.[0].text).toMatch(/^x+…$/);
      expect(summary.notices).toHaveLength(1);
      expect(summary.notices![0].more).toBe(true);
      expect(context).toContain(' (continued in your next turn)');
    } finally { await f.close(); }
  });

  it('withdraws hook fragments for a room the member can no longer see, and never shows a member another\'s notices', async () => {
    const f = await fixture();
    try {
      f.chat.addMember(f.room.id, N, { goal: 'tests' });
      expect(f.notices(L).some((t) => t.includes('joined the room'))).toBe(true);
      expect(f.notices(M).some((t) => t.includes('joined the room'))).toBe(false);
      const said = f.chat.post(f.room.id, { kind: 'user', name: 'Owner' }, 'rules', 'all');
      await f.chat.pinMessage(f.room.id, said.id, { name: 'user', kind: 'user' }, true);
      expect(f.notices(M)).toHaveLength(1);
      f.chat.archiveRoom(f.room.id, true);
      const { context, summary } = await hook(f.chat, M);
      expect(summary.notices).toBeUndefined();
      expect(context).not.toContain('pinned by the owner');
      expect(f.notices(M)).toEqual([]);
      const other = f.chat.createRoom('Other', undefined);
      f.chat.addMember(other.id, M, {});
      await hook(f.chat, M); // its briefing
      const there = f.chat.post(other.id, { kind: 'user', name: 'Owner' }, 'house', 'all');
      await f.chat.pinMessage(other.id, there.id, { name: 'user', kind: 'user' }, true);
      expect(f.notices(M)).toHaveLength(1);
      f.chat.removeMember(other.id, M);
      expect((await hook(f.chat, M)).summary.notices).toBeUndefined();
      expect(f.notices(M)).toEqual([]);
    } finally { await f.close(); }
  });
});

