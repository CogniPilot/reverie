/** CI-only SDK consumer. The packaged CLI and real API retain every effect decision. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveAgentContext } from '../../src/cli-agent.js';
import { planOfficeMoveRecord } from './plan-office-move-driver.js';
import { PlanOfficeForceChild, planOfficeForceChildArgs } from './plan-office-force-child.js';
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PlanOfficeAgentForceInput = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-sdk-agent-force-v1'),
    id: uuid,
    employeeId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    fromAccount: z.literal('ci-plan-b'),
    toAccount: z.literal('ci-plan-a'),
  })
  .strict();
export type PlanOfficeAgentForceInput = z.infer<typeof PlanOfficeAgentForceInput>;
export const PlanOfficeAgentForceReceipt = PlanOfficeAgentForceInput.extend({
  kind: z.enum(['prepared', 'issued', 'returned']),
  namespacePid: z.number().int().min(2),
  nativeBirthTicks: z.string().regex(/^[1-9][0-9]{0,19}$/),
  identityFileDigest: hash,
  handoffDigest: hash,
  inheritedMuxPresent: z.boolean(),
  childMuxAbsent: z.literal(true),
  capabilitiesCheckedAt: z.number().int().nonnegative().safe(),
  moveOwnPlan: z.literal(true),
  managePlans: z.literal(false),
}).strict();
export type PlanOfficeAgentForceReceipt = z.infer<typeof PlanOfficeAgentForceReceipt>;
export const PlanOfficeAgentForceSpawn = PlanOfficeAgentForceReceipt.extend({
  kind: z.literal('spawned'),
  child: PlanOfficeForceChild,
}).strict();
export const PlanOfficeAgentForceClosed = z
  .object({
    version: z.literal(1),
    purpose: z.literal('sdk-force-child-proof-after-close-v1'),
    id: uuid,
    proofDigest: hash,
  })
  .strict();
export const planOfficeForceDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export function planOfficeForceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = { ...env };
  delete inherited.REVERIE_MUX;
  return inherited;
}
export function planOfficeForceHandoff(input: PlanOfficeAgentForceInput): string {
  PlanOfficeAgentForceInput.parse(input);
  return `Synthetic isolated SDK force ${input.id}, employee ${input.employeeId}, source ${input.sessionId} generation ${input.sessionGeneration}, ci-plan-b to ci-plan-a. No paid work was performed. Preserve the home, workspace, thread, memories and unknown outcomes; never replay an uncertain request.`;
}
export function planOfficeForceHandoffFile(id: string) {
  uuid.parse(id);
  return '/home/agent/.fixture/plan-force-handoff-' + id + '.txt';
}
export function planOfficeAgentForceArgs(input: PlanOfficeAgentForceInput) {
  PlanOfficeAgentForceInput.parse(input);
  return [
    'agent',
    'plan-move',
    'force',
    input.toAccount,
    '--employee',
    input.employeeId,
    '--id',
    input.id,
    '--handoff-file',
    planOfficeForceHandoffFile(input.id),
    '--json',
  ];
}
export interface PlanOfficeAgentForceFiles {
  writeForceHandoff(id: string, text: string): void;
  readForceHandoff(id: string): string;
  forcePrepared(id: string): unknown;
  forceRecord(kind: PlanOfficeAgentForceReceipt['kind'], receipt: PlanOfficeAgentForceReceipt): void;
  forceChild(receipt: z.infer<typeof PlanOfficeAgentForceSpawn>): void;
}
export type PlanOfficeAgentForceCli = (
  args: readonly string[],
  input?: string,
  context?: 'sdk-without-mux',
  observed?: (child: z.infer<typeof PlanOfficeForceChild>) => void
) => Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
}>;
function actualContext(input: PlanOfficeAgentForceInput, employeeId: string, env: NodeJS.ProcessEnv) {
  assert.equal(input.employeeId, employeeId);
  assert.equal(env.HOME, '/home/agent');
  assert.ok(env.REVERIE_WORKER_IDENTITY_FILE, 'Actual SDK protected identity required');
  const context = resolveAgentContext(planOfficeForceEnvironment(env));
  assert.ok(context.workerIdentity);
  assert.equal(context.auth, undefined);
  assert.equal(context.selfId, input.sessionId);
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  assert.equal(Number(stat.slice(0, stat.indexOf(' '))), process.pid);
  const nativeBirthTicks = z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .parse(
      stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)[19]
    );
  return {
    namespacePid: process.pid,
    nativeBirthTicks,
    identityFileDigest: planOfficeForceDigest(env.REVERIE_WORKER_IDENTITY_FILE),
    inheritedMuxPresent: env.REVERIE_MUX !== undefined,
  };
}
async function capabilities(input: PlanOfficeAgentForceInput, cli: PlanOfficeAgentForceCli) {
  const reply = await cli(['agent', 'capabilities', '--json'], undefined, 'sdk-without-mux');
  assert.equal(reply.exitCode, 0);
  assert.equal(reply.signal, null);
  assert.ok(Buffer.byteLength(reply.stdout) <= 65536);
  const report = z
    .object({
      checkedAt: z.number().int().nonnegative().safe(),
      identity: z
        .object({
          kind: z.literal('agent'),
          employeeId: z.literal(input.employeeId),
          sessionId: z.literal(input.sessionId),
        })
        .passthrough(),
      company: z.object({ moveOwnPlan: z.literal(true), managePlans: z.literal(false) }).passthrough(),
    })
    .passthrough()
    .parse(JSON.parse(reply.stdout));
  const age = Date.now() - report.checkedAt;
  assert.ok(age >= 0 && age <= 10000, 'Current SDK capabilities required');
  return report.checkedAt;
}
export async function preparePlanOfficeAgentForce(
  unchecked: unknown,
  employeeId: string,
  files: PlanOfficeAgentForceFiles,
  cli: PlanOfficeAgentForceCli,
  env = process.env
) {
  const input = PlanOfficeAgentForceInput.parse(unchecked),
    actual = actualContext(input, employeeId, env);
  const capabilitiesCheckedAt = await capabilities(input, cli),
    handoff = planOfficeForceHandoff(input);
  assert.deepEqual(actualContext(input, employeeId, env), actual);
  files.writeForceHandoff(input.id, handoff);
  assert.equal(files.readForceHandoff(input.id), handoff);
  const receipt = PlanOfficeAgentForceReceipt.parse({
    ...input,
    ...actual,
    kind: 'prepared',
    handoffDigest: planOfficeForceDigest(handoff),
    capabilitiesCheckedAt,
    childMuxAbsent: true,
    moveOwnPlan: true,
    managePlans: false,
  });
  files.forceRecord('prepared', receipt);
  return receipt;
}
export async function executePlanOfficeAgentForce(
  unchecked: unknown,
  employeeId: string,
  files: PlanOfficeAgentForceFiles,
  cli: PlanOfficeAgentForceCli,
  env = process.env
) {
  const input = PlanOfficeAgentForceInput.parse(unchecked),
    actual = actualContext(input, employeeId, env),
    prepared = PlanOfficeAgentForceReceipt.parse(files.forcePrepared(input.id));
  assert.equal(prepared.kind, 'prepared');
  assert.deepEqual(PlanOfficeAgentForceInput.strip().parse(prepared), input);
  for (const key of ['namespacePid', 'nativeBirthTicks', 'identityFileDigest', 'inheritedMuxPresent'] as const)
    assert.equal(actual[key], prepared[key]);
  const handoff = files.readForceHandoff(input.id);
  assert.equal(handoff, planOfficeForceHandoff(input));
  assert.equal(planOfficeForceDigest(handoff), prepared.handoffDigest);
  const capabilitiesCheckedAt = await capabilities(input, cli);
  assert.deepEqual(actualContext(input, employeeId, env), actual);
  const issued = PlanOfficeAgentForceReceipt.parse({ ...prepared, kind: 'issued', capabilitiesCheckedAt });
  files.forceRecord('issued', issued); // exclusive, consuming-close publication before the sole business request
  const args = planOfficeAgentForceArgs(input);
  let childObserved = false;
  const reply = await cli(args, undefined, 'sdk-without-mux', (child) => {
    assert.equal(child.parentPid, issued.namespacePid);
    assert.equal(child.sessionId, issued.sessionId);
    assert.equal(child.identityFileDigest, issued.identityFileDigest);
    assert.equal(child.argsDigest, planOfficeForceDigest(JSON.stringify(planOfficeForceChildArgs(args))));
    files.forceChild({ ...issued, kind: 'spawned', child });
    childObserved = true;
  });
  assert.equal(reply.exitCode, 0);
  assert.equal(reply.signal, null);
  assert.equal(childObserved, true, 'Actual CLI child observation missing');
  assert.ok(Buffer.byteLength(reply.stdout) <= 65536);
  planOfficeMoveRecord(JSON.parse(reply.stdout), {
    ...input,
    purpose: 'reverie-ci-plan-move-scenario-v1',
    kind: 'agent-force',
  });
  files.forceRecord('returned', { ...issued, kind: 'returned' });
}
