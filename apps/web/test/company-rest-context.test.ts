import { describe, expect, it } from 'vitest';
import { EmployeeSchema, employeeRestContext } from '../src/company-types.js';

describe('sleep and dream owner eligibility', () => {
  it('parses legacy experts with both options off without changing research', () => {
    const employee = EmployeeSchema.parse({ id: 'one', name: 'Expert', icon: 'E', position: 'CTO', expertise: ['systems'], sessionId: 'session', createdAt: 1 });
    expect(employee).toMatchObject({ sleepEnabled: false, dreamEnabled: false, researchEnabled: true });
    expect(employeeRestContext(employee)).toContain('Sleep (memory consolidation) not permitted');
  });
  it('explains opt-in scheduling without title authority or a nightly timer', () => {
    const context = employeeRestContext({ sleepEnabled: true, dreamEnabled: true });
    expect(context).toContain('Sleep (memory consolidation) permitted');
    expect(context).toContain('Dream (creative exploration) permitted');
    expect(context).toContain('explicitly authorized');
    expect(context).toContain('Gantt task');
    expect(context).toContain('ideas, not facts');
    expect(context).toContain('No independent nightly timer');
  });
});
