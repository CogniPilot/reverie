import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService } from '../src/chatroom-service.js';
import { employeeProfileContext, employeeBriefContext } from '../src/company-types.js';
import { buildBriefing, buildDeliveryLine, MAX_DELIVERY_CHARS, WAKE_LINE } from '../src/chatroom-delivery.js';
import { TURN_SUMMARY_MAX_CHARS } from '../src/chatroom-turn-summary.js';
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
