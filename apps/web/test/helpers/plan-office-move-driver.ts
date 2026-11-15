/** CI-only thin plan consumer. No physical adapter or entrypoint is enabled here.
 * Native/source/principal/composer verification belongs to the qualified office
 * adapter; a fake SDK report and a completed API record are never that proof. */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { PlanRequestSchema } from '../../src/plan-request.js';
const uuid = z.string().uuid(),
  account = z.enum(['ci-plan-a', 'ci-plan-b']);
export const PlanOfficeMoveScenario = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-plan-move-scenario-v1'),
    kind: z.enum(['owner-cooperative', 'self', 'team', 'owner-force']),
    id: uuid,
    employeeId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    fromAccount: account,
    toAccount: account,
  })
  .strict()
  .refine((value) => value.fromAccount !== value.toAccount);
export type PlanOfficeMoveScenario = z.infer<typeof PlanOfficeMoveScenario>;
export const PlanOfficeSelfAcceptance = z.enum(['ordinary-self', 'self-roundtrip']);
export type PlanOfficeSelfAcceptance = z.infer<typeof PlanOfficeSelfAcceptance>;
type ApiRecord = Record<string, unknown>;
export interface PlanOfficeSelfCompletion {
  scenario: PlanOfficeMoveScenario;
  /** Returned only after runPlanOfficeMoveScenario's independent physical verifier succeeds. */
  record: ApiRecord;
}
export type PlanOfficeSelfLeg = 'first' | 'return';
export function planOfficeSelfDirection(leg: PlanOfficeSelfLeg) {
  z.enum(['first', 'return']).parse(leg);
  return leg === 'first'
    ? { fromAccount: 'ci-plan-a' as const, toAccount: 'ci-plan-b' as const }
    : { fromAccount: 'ci-plan-b' as const, toAccount: 'ci-plan-a' as const };
}
/** The return callback (including its new-ID allocation) is unreachable until
 * the first move has returned from its full physical verification and receipt. */
export async function runPlanOfficeSelfSequence(
  selection: PlanOfficeSelfAcceptance,
  move: (leg: PlanOfficeSelfLeg, previous?: PlanOfficeSelfCompletion) => Promise<PlanOfficeSelfCompletion>
) {
  PlanOfficeSelfAcceptance.parse(selection);
  const validate = (value: PlanOfficeSelfCompletion, leg: PlanOfficeSelfLeg) => {
    const scenario = PlanOfficeMoveScenario.parse(value.scenario);
    assert.equal(scenario.kind, 'self');
    assert.equal(scenario.fromAccount, planOfficeSelfDirection(leg).fromAccount);
    assert.equal(scenario.toAccount, planOfficeSelfDirection(leg).toAccount);
    const record = planOfficeMoveRecord(value.record, scenario);
    assert.equal(record.phase, 'completed', 'A subsequent self move requires known physical completion');
    return { scenario, record };
  };
  const first = validate(await move('first'), 'first');
  if (selection === 'ordinary-self') return { first };
  const returned = validate(await move('return', first), 'return');
  assert.notEqual(returned.scenario.id, first.scenario.id);
  assert.equal(returned.scenario.employeeId, first.scenario.employeeId);
  assert.equal(returned.scenario.sessionId, first.record.newSession);
  assert.equal(returned.scenario.sessionGeneration, first.scenario.sessionGeneration + 1);
  assert.notEqual(returned.record.newSession, first.scenario.sessionId);
  return { first, returned };
}
export interface PlanOfficeMovePorts {
  /** Fresh owned control + genuine owner/caller context. IDs alone confer no authority. */
  assertCurrent(): Promise<void>;
  /** Same-origin ordinary owner API; this module only selects the fixed routes below. */
  ownerPost(path: string, body: ApiRecord): Promise<Response>;
  /** Exact fixed capsule in the actual interactive fixture SDK context, no shell/header override. */
  capsule(args: readonly string[]): Promise<{ exitCode: number | null; signal: string | null; stdout: string }>;
  /** Durable private wx+fsync+consuming-close completion before the request. */
  record(name: string, value: unknown): void;
  pause(): Promise<void>;
  /** Must physically prove original closure, same employee/thread/material, real
   * selected account principal and target composer. No fake/native DTO substitute. */
  verifyCompleted(scenario: PlanOfficeMoveScenario, record: ApiRecord): Promise<void>;
}
const MoveRecord = z
  .object({
    id: uuid,
    employeeId: uuid,
    oldSession: uuid,
    newSession: uuid.optional(),
    fromAccount: account,
    toAccount: account,
    phase: z.enum([
      'waiting',
      'creating',
      'starting',
      'checking',
      'stopping',
      'completed',
      'failed',
      'recovery-required',
    ]),
  })
  .passthrough();
export function planOfficeMoveRecord(value: unknown, scenario: PlanOfficeMoveScenario) {
  const record = scenario.kind === 'owner-force' ? MoveRecord.parse(value) : PlanRequestSchema.parse(value);
  assert.equal(record.id, scenario.id);
  assert.equal(record.employeeId, scenario.employeeId);
  assert.equal('oldSession' in record ? record.oldSession : record.sessionId, scenario.sessionId);
  assert.equal(record.fromAccount, scenario.fromAccount);
  assert.equal(record.toAccount, scenario.toAccount);
  for (const key of ['nonceHash', 'dockerReplacement', 'dockerSettlementBudget'])
    assert.equal((record as ApiRecord)[key], undefined, 'Private plan data must not be returned by status');
  if (record.phase === 'completed') {
    uuid.parse(record.newSession);
    assert.notEqual(record.newSession, scenario.sessionId);
  }
  return record as ApiRecord;
}
async function responseData(response: Response) {
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 65536);
  const value = z.object({ success: z.boolean(), data: z.unknown().optional() }).passthrough().parse(JSON.parse(text));
  return { status: response.status, value };
}
/** One original business request, then only exact original status. No resolve,
 * reauthorize, retry or new ID is inferred from any HTTP status or absent record. */
export async function runPlanOfficeMoveScenario(unchecked: unknown, ports: PlanOfficeMovePorts) {
  const scenario = PlanOfficeMoveScenario.parse(unchecked);
  await ports.assertCurrent();
  const path = scenario.kind === 'owner-force' ? '/api/plans/moves/force' : '/api/plans/requests';
  const body = {
    id: scenario.id,
    employeeId: scenario.employeeId,
    sessionId: scenario.sessionId,
    toAccount: scenario.toAccount,
    ...(scenario.kind === 'owner-force'
      ? {
          sessionGeneration: scenario.sessionGeneration,
          handoff:
            'Synthetic isolated CI move ' +
            scenario.id +
            '. Preserve the original work and unknown outcomes; no paid model work.',
        }
      : {}),
  };
  const args = [
    'agent',
    'plan-move',
    'request',
    scenario.toAccount,
    '--id',
    scenario.id,
    ...(scenario.kind === 'team' ? ['--employee', scenario.employeeId] : []),
    '--json',
  ];
  ports.record('request-' + scenario.id + '-intent', {
    scenario,
    ...(scenario.kind === 'self' || scenario.kind === 'team' ? { args } : { path, body }),
  });
  // Failure of this check is known before the callback can dispatch.
  await ports.assertCurrent();
  try {
    if (scenario.kind === 'self' || scenario.kind === 'team') {
      const reply = await ports.capsule(args);
      assert.equal(reply.exitCode, 0);
      assert.equal(reply.signal, null);
      assert.ok(Buffer.byteLength(reply.stdout) <= 65536);
      const value = z
        .object({ success: z.literal(true), id: z.literal(scenario.id), phase: PlanRequestSchema.shape.phase })
        .passthrough()
        .parse(JSON.parse(reply.stdout));
      ports.record('request-' + scenario.id + '-returned', { channel: 'real-capsule', phase: value.phase });
    } else {
      const reply = await responseData(await ports.ownerPost(path, body));
      assert.equal(reply.status, 202);
      assert.equal(reply.value.success, true);
      ports.record('request-' + scenario.id + '-returned', planOfficeMoveRecord(reply.value.data, scenario));
    }
  } catch (error) {
    ports.record('request-' + scenario.id + '-unknown', {
      id: scenario.id,
      errorType: error instanceof Error ? error.name : 'unknown',
      noRetry: true,
    });
  }
  await ports.assertCurrent();
  const statusPath =
    '/api/plans/' + (scenario.kind === 'owner-force' ? 'moves' : 'requests') + '/' + scenario.id + '/status';
  for (let index = 0; index < 180; index++) {
    await ports.assertCurrent();
    let reply: Awaited<ReturnType<typeof responseData>>;
    try {
      reply = await responseData(await ports.ownerPost(statusPath, {}));
    } catch (error) {
      if (!(error instanceof Error) || !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      ports.record('status-' + scenario.id + '-timeout-' + index, { id: scenario.id, readOnly: true });
      await ports.pause();
      continue;
    }
    await ports.assertCurrent();
    if (reply.status === 404) {
      // A delayed original publication can still follow an absent read.
      ports.record('status-' + scenario.id + '-absent-' + index, {
        id: scenario.id,
        originalOutcome: 'unknown',
        noRetry: true,
      });
      await ports.pause();
      continue;
    }
    assert.equal(reply.status, 200, 'Exact original status unavailable');
    assert.equal(reply.value.success, true);
    const record = planOfficeMoveRecord(reply.value.data, scenario);
    ports.record('status-' + scenario.id + '-' + index, record);
    if (record.phase === 'completed') {
      await ports.verifyCompleted(scenario, record);
      await ports.assertCurrent();
      ports.record('completed-' + scenario.id, { id: scenario.id, newSession: record.newSession, originalOnly: true });
      return record;
    }
    if (
      ['failed', 'recovery-required', 'rejected', 'cancelled', 'expired', 'reauthorize-required'].includes(
        record.phase as string
      )
    )
      throw Error('Original plan move held; inspect its exact ID, never request another automatically');
    await ports.pause();
  }
  throw Error('Original plan move outcome unconfirmed; inspect ' + scenario.id + ' without replay');
}
