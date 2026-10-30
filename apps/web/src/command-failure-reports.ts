/** Closed metadata from the protected laptop broker; never command/effect evidence. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
export const FAILURE_REPORT_LIMIT = 64;
export const FAILURE_REPORT_BYTES = 262_144;
export const FailureEmployeeId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
export const FailureReportQuery = z.object({ employeeId: FailureEmployeeId.optional() }).strict();
const count = z.number().int().min(0).max(2 ** 31 - 1);
const group = z.object({
  tool: z.enum(['shell', 'python', 'git', 'zip', 'UNKNOWN_COMMAND']),
  category: z.enum(['COMMAND_NOT_FOUND', 'SIGNAL', 'NONZERO']),
  exit: z.number().int().min(-255).max(255).refine(value => value !== 0),
  count: z.number().int().min(1).max(2048),
}).strict();
const categoryMatches = (row: { exit: number; category: string }) => row.category ===
  (row.exit === 127 ? 'COMMAND_NOT_FOUND' : row.exit < 0 ? 'SIGNAL' : 'NONZERO');
const employee = z.object({
  employee_id: FailureEmployeeId,
  harness: z.literal('hands'),
  status: z.enum(['disabled', 'ready', 'no_data', 'unavailable']),
  counts: z.array(group).max(20),
  truncated: z.boolean(),
  evicted: count, expired: count, dropped: count,
}).strict();
const reportSchema = z.object({
  v: z.literal(1), enabled: z.boolean(), provenance: z.literal('SELF_REPORTED_RESULT'),
  harness_support: z.object({ hands: z.literal('self_reported'), claude: z.literal('unavailable'), codex: z.literal('unavailable') }).strict(),
  employees: z.array(employee).max(FAILURE_REPORT_LIMIT),
  top_repeats: z.array(group.extend({
    count: z.number().int().min(1).max(2048 * FAILURE_REPORT_LIMIT),
    employee_count: z.number().int().min(1).max(FAILURE_REPORT_LIMIT),
  }).strict()).max(20),
  truncated: z.boolean(),
}).strict();
export type CommandFailureReport = z.infer<typeof reportSchema>;

export function parseFailureReport(value: unknown, employees: readonly string[]): CommandFailureReport {
  const report = reportSchema.parse(value);
  if (report.employees.length !== employees.length || new Set(employees).size !== employees.length ||
      !report.employees.every((row, i) => row.employee_id === employees[i]) ||
      report.employees.some(row => row.counts.some(group => !categoryMatches(group)) ||
        new Set(row.counts.map(group => `${group.tool}:${group.exit}`)).size !== row.counts.length ||
        row.counts.reduce((sum, group) => sum + group.count, 0) > 2048 ||
        (report.enabled ? row.status === 'disabled' : row.status !== 'disabled') ||
        (row.status !== 'ready' && (row.counts.length !== 0 || row.truncated || row.evicted || row.expired || row.dropped))) ||
      report.top_repeats.some(row => !categoryMatches(row) || row.employee_count > employees.length || row.count > 2048 * employees.length) ||
      new Set(report.top_repeats.map(row => `${row.tool}:${row.exit}`)).size !== report.top_repeats.length ||
      (!report.enabled && (report.top_repeats.length !== 0 || report.truncated))) {
    throw new Error('Failure metadata is unavailable.');
  }
  return report;
}

/** Fixed argv only. No shell, target pathname, producer or enablement parameters. */
export async function readCommandFailures(employees: readonly string[]): Promise<CommandFailureReport> {
  if (employees.length > FAILURE_REPORT_LIMIT || new Set(employees).size !== employees.length ||
      !employees.every(id => FailureEmployeeId.safeParse(id).success)) {
    throw new Error('Failure metadata is unavailable.');
  }
  const args = ['--command-failure-report', ...employees.flatMap(id => ['--employee-id', id])];
  const { stdout } = await execute('reverie-worker-exec', args, {
    timeout: 3500, maxBuffer: FAILURE_REPORT_BYTES, encoding: 'utf8',
  });
  if (Buffer.byteLength(stdout, 'utf8') > FAILURE_REPORT_BYTES) throw new Error('Failure metadata is unavailable.');
  return parseFailureReport(JSON.parse(stdout) as unknown, employees);
}
