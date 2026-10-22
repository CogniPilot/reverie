import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService } from '../src/chatroom-service.js';
import { employeeProfileContext, employeeRestContext } from '../src/company-types.js';

describe('employee role context in ordinary room briefings', () => {
  it('delivers the current job, duties, personality and rest preferences as profile data without title-based grants', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'employee-role-brief-'));
    const writes: string[] = [];
    const session = { id: 'employee-runtime', name: 'Alex', mode: 'claude', status: 'idle', pid: 123, isWorking: false,
      writeViaMux: async (text: string, options?: any) => { writes.push(text); options?.onOutcome?.('submitted'); return true; } };
    const employee = { name: 'Alex', position: 'CoffeeMonger', expertise: ['Coffee preparation'], responsibilities: ['Prepare a clear coffee plan and verify available ingredients'], personality: 'Patient and practical', sleepEnabled: true, dreamEnabled: false };
    const chat = new ChatroomService({ file: join(dir, 'chat.json'), getSession: id => id === session.id ? session as never : undefined, broadcast: () => {}, restContextOf: () => employeeProfileContext(employee) + ' ' + employeeRestContext(employee) });
    try {
      const room = chat.createRoom('General', undefined);
      chat.addMember(room.id, session.id, { goal: 'Help the team' });
      await chat.delivery.flushAll();
      const delivered = writes.join('\n');
      expect(delivered).toContain('CoffeeMonger');
      expect(delivered).toContain('verify available ingredients');
      expect(delivered).toContain('Patient and practical');
      expect(delivered).toContain('not additional permissions');
      expect(delivered).toContain('Sleep (memory consolidation) permitted');
      expect(delivered).toContain('grant no hiring');
    } finally { await chat.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});
