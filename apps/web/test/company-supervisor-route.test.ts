/**
 * GET /api/company carries the office supervisor's reading of each employee: the condition, one sentence, what it
 * last did, what it will do next and what it needs from a person. It is attached only to the binding it was read for.
 */
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import type { CompanyService } from '../src/company-service.js';
import { EmployeeSchema, CompanySettingsSchema } from '../src/company-types.js';
import type { SupervisorReport } from '../src/employee-supervisor.js';
import { registerCompanyRoutes } from '../src/web/routes/company-routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const employee = (id: string, sessionGeneration = 1) => ({
  ...EmployeeSchema.parse({
    id,
    name: id.toUpperCase(),
    icon: '🌱',
    position: 'Engineer',
    expertise: ['systems'],
    sessionId: 'session-' + id,
    sessionGeneration,
    createdAt: 1,
    desiredRunning: true,
  }),
  available: true,
  runtimeHealth: 'unknown',
});

async function company(reports: SupervisorReport[] | undefined) {
  const employees = [employee('a'), employee('b', 2), employee('c')];
  const view = () => ({
    employees,
    settings: CompanySettingsSchema.parse({}),
    cycles: [],
    memories: [],
    temporaryAgents: [],
    retired: [],
  });
  const app = Fastify();
  apps.push(app);
  const asked: Array<string | undefined> = [];
  registerCompanyRoutes(app, {} as SessionPort, { view } as unknown as CompanyService, undefined, undefined, undefined, {
    ...(reports
      ? {
          employeeSupervisor: (owner) => {
            asked.push(owner);
            return reports;
          },
        }
      : {}),
  });
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api/company' });
  return { body: response.json() as { data: { employees: Array<Record<string, unknown>> } }, asked };
}

it('shows what the supervisor found, did and will do for each employee', async () => {
  const report: SupervisorReport = {
    employeeId: 'a',
    sessionId: 'session-a',
    sessionGeneration: 1,
    condition: 'held-retryable',
    sentence: "Setting the resource limits of A's laptop was interrupted by a process that ended. That is harmless.",
    code: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING',
    since: 1000,
    checkedAt: 5000,
    last: { action: 'resend-continuation', at: 4000, outcome: 'refused', detail: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING' },
    next: { action: 'resend-continuation', at: 124_000 },
  };
  const { body, asked } = await company([
    report,
    // A reading of an earlier binding of B, and one of an employee who is not in this company.
    { ...report, employeeId: 'b', sessionId: 'session-b', sessionGeneration: 1 },
    { ...report, employeeId: 'zz' },
  ]);
  expect(asked).toEqual([undefined]);
  const [a, b, c] = body.data.employees;
  expect(a!.supervisor).toEqual({
    condition: 'held-retryable',
    sentence: report.sentence,
    code: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING',
    since: 1000,
    checkedAt: 5000,
    last: report.last,
    next: report.next,
  });
  expect(b).not.toHaveProperty('supervisor');
  expect(c).not.toHaveProperty('supervisor');
});

it('says what a person has to do when the supervisor will not', async () => {
  const { body } = await company([
    {
      employeeId: 'c',
      sessionId: 'session-c',
      sessionGeneration: 1,
      condition: 'needs-sign-in',
      sentence: "C is waiting at Claude's sign-in screen.",
      checkedAt: 1,
      needsHuman: 'Sign in the plan “Max” at the office (Plans), or in the laptop terminal.',
    },
  ]);
  expect(body.data.employees[2]!.supervisor).toMatchObject({
    condition: 'needs-sign-in',
    needsHuman: expect.stringContaining('Sign in the plan “Max”'),
  });
});

it('leaves the answer unchanged for an office without a supervisor', async () => {
  const { body } = await company(undefined);
  for (const row of body.data.employees) expect(row).not.toHaveProperty('supervisor');
});
