import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService } from '../src/chatroom-service.js';
import { employeeProfileContext, employeeBriefContext } from '../src/company-types.js';
import { buildBriefing, buildDeliveryLine, MAX_DELIVERY_CHARS } from '../src/chatroom-delivery.js';

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
      const delivered = writes.join('\n');
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
