/** CI-only fixed permission observation in the actual fake SDK process. This is
 * the production worker identity reader and HTTP transport, never owner auth. */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { resolveAgentContext, httpRequest, type ApiRequest } from '../../src/cli-agent.js';
const uuid = z.string().uuid();
export const PlanOfficePermissionProbe = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-team-permission-probe-v1'),
    id: uuid,
    scope: z.enum(['team-request', 'team-pending']),
    callerEmployeeId: uuid,
    callerSessionId: uuid,
    employeeId: uuid,
    sessionId: uuid,
    toAccount: z.literal('ci-plan-b'),
  })
  .strict()
  .refine((v) => v.callerEmployeeId !== v.employeeId && v.callerSessionId !== v.sessionId);
export type PlanOfficePermissionProbe = z.infer<typeof PlanOfficePermissionProbe>;
export const PlanOfficePermissionReceipt = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-team-permission-receipt-v1'),
    id: uuid,
    scope: z.enum(['team-request', 'team-pending']),
    callerEmployeeId: uuid,
    callerSessionId: uuid,
    employeeId: uuid,
    sessionId: uuid,
    namespacePid: z.number().int().min(2),
    status: z.number().int().min(100).max(599),
    code: z.enum(['FORBIDDEN']).nullable(),
    success: z.boolean(),
  })
  .strict();
export async function runPlanOfficePermissionProbe(
  unchecked: unknown,
  callerEmployeeId: string,
  record: (kind: 'intent' | 'returned', value: unknown) => void,
  env: NodeJS.ProcessEnv = process.env,
  request: ApiRequest = httpRequest
) {
  const input = PlanOfficePermissionProbe.parse(unchecked);
  assert.equal(env.HOME, '/home/agent');
  assert.equal(input.callerEmployeeId, callerEmployeeId);
  assert.ok(env.REVERIE_WORKER_IDENTITY_FILE, 'SDK probe never selects a human credential fallback');
  const context = resolveAgentContext(env);
  assert.ok(context.workerIdentity, 'Actual SDK protected worker credential required');
  assert.equal(context.auth, undefined);
  assert.equal(context.selfId, input.callerSessionId);
  record('intent', input); // exclusive durable publication precedes even the binding GET
  const company = await request(context, {
    method: 'GET',
    path: '/api/company',
    bounds: { maxBytes: 65536, deadlineMs: 10000 },
  });
  assert.equal(company.status, 200);
  const body = z
    .object({
      success: z.literal(true),
      data: z.object({ employees: z.array(z.object({ id: uuid, sessionId: uuid }).passthrough()) }).passthrough(),
    })
    .passthrough()
    .parse(company.json);
  for (const [id, sessionId] of [
    [input.callerEmployeeId, input.callerSessionId],
    [input.employeeId, input.sessionId],
  ]) {
    const rows = body.data.employees.filter((e) => e.id === id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sessionId, sessionId);
  }
  const result = await request(context, {
    method: 'POST',
    path: '/api/plans/agent-requests' + (input.scope === 'team-pending' ? '/pending' : ''),
    body:
      input.scope === 'team-pending'
        ? { employeeId: input.employeeId }
        : { id: input.id, employeeId: input.employeeId, sessionId: input.sessionId, toAccount: input.toAccount },
    bounds: { maxBytes: 65536, deadlineMs: 10000 },
  });
  assert.equal(typeof result.json?.success, 'boolean', 'Unknown response cannot establish a denial');
  const receipt = PlanOfficePermissionReceipt.parse({
    version: 1,
    purpose: 'reverie-ci-team-permission-receipt-v1',
    id: input.id,
    scope: input.scope,
    callerEmployeeId: input.callerEmployeeId,
    callerSessionId: input.callerSessionId,
    employeeId: input.employeeId,
    sessionId: input.sessionId,
    namespacePid: process.pid,
    status: result.status,
    success: result.json!.success,
    code: result.json?.errorCode === 'FORBIDDEN' ? 'FORBIDDEN' : null,
  });
  record('returned', receipt);
  return receipt;
}
