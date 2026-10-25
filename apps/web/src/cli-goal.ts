/**
 * @fileoverview Goal client over the existing scoped office HTTP transport. The
 * broker/server own authentication and custody; this client neither asserts them
 * nor registers routes. No retries, wake, grants or secondary status store.
 */
import { constants, promises as fs } from 'node:fs';
import type { Command } from 'commander';
import { z } from 'zod';
import type { AgentDeps, ApiResponse } from './cli-agent.js';
import {
  GoalId,
  GoalCreateCommand,
  GoalTransitionCommand,
  GoalCommandResult,
  GoalFullRecord,
  GoalMetadata,
  GoalSummary,
  goalSummary,
  closedReceipt,
} from './goal-client-contract.js';

export const GOAL_EXIT = { ok: 0, unavailable: 1, refused: 4, uncertain: 5 } as const;
type FailureCode =
  | 'GOAL_INVALID'
  | 'GOAL_FORBIDDEN'
  | 'GOAL_CONFLICT'
  | 'GOAL_IDEMPOTENCY_REUSE'
  | 'GOAL_NOT_FOUND'
  | 'GOAL_UNAVAILABLE'
  | 'GOAL_RESPONSE_INVALID'
  | 'GOAL_SUBMIT_UNCERTAIN';
const messages: Record<FailureCode, string> = {
  GOAL_INVALID:
    'Goal command is invalid. Supply a bounded regular JSON file with the exact documented fields and a stable idempotency key.',
  GOAL_FORBIDDEN: 'Goal operation refused. Current server authentication, binding and scoped authority are required.',
  GOAL_CONFLICT:
    'Goal generation, binding, state or sequence changed. Inspect authorized current state before preparing a new command.',
  GOAL_IDEMPOTENCY_REUSE:
    'Goal idempotency key was reused with different input. Inspect the original operation before proceeding.',
  GOAL_NOT_FOUND: 'Goal is not available to this caller.',
  GOAL_UNAVAILABLE: 'Goal API is unavailable or not installed. This command does not activate it.',
  GOAL_RESPONSE_INVALID: 'Goal API returned an unsupported response. No private response body was printed.',
  GOAL_SUBMIT_UNCERTAIN:
    'Goal submission is uncertain. Inspect authorized state before manually replaying the unchanged command with the same idempotency key.',
};
function fail(deps: AgentDeps, code: FailureCode, operationId?: string): number {
  const value = { success: false, errorCode: code, error: messages[code], ...(operationId ? { operationId } : {}) };
  if (deps.json) deps.io.out(JSON.stringify(value));
  else deps.io.err(messages[code]);
  return code === 'GOAL_SUBMIT_UNCERTAIN'
    ? GOAL_EXIT.uncertain
    : code === 'GOAL_UNAVAILABLE' || code === 'GOAL_RESPONSE_INVALID'
      ? GOAL_EXIT.unavailable
      : GOAL_EXIT.refused;
}
function rejected(response: ApiResponse, mutation: boolean): FailureCode | undefined {
  if (response.status >= 200 && response.status < 300 && response.json?.success === true) return;
  if (response.status === 401 || response.status === 403) return 'GOAL_FORBIDDEN';
  const code = response.json?.errorCode;
  if (response.status === 409) return code === 'GOAL_IDEMPOTENCY_REUSE' ? code : 'GOAL_CONFLICT';
  if (response.status === 400) return 'GOAL_INVALID';
  if (response.status === 404) return code === 'GOAL_NOT_FOUND' ? code : 'GOAL_UNAVAILABLE';
  if (response.status === 405 || response.status === 501) return 'GOAL_UNAVAILABLE';
  if (response.status === 429) return 'GOAL_FORBIDDEN';
  return mutation ? 'GOAL_SUBMIT_UNCERTAIN' : 'GOAL_UNAVAILABLE';
}
function output(deps: AgentDeps, value: unknown, line: string): number {
  deps.io.out(deps.json ? JSON.stringify(value) : line);
  return GOAL_EXIT.ok;
}
function line(goal: z.infer<typeof GoalSummary>): string {
  return `${goal.id} ${goal.state} generation=${goal.generation} sequence=${goal.transitionSequence}`;
}

/** The only local input is a user-selected bounded regular file; it is never retained or echoed. */
export async function readGoalCommand(file: string): Promise<unknown> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('Invalid Goal input');
    const bytes = Buffer.alloc(65537);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 65536) throw new Error('Invalid Goal input');
    const raw = bytes.subarray(0, bytesRead);
    const text = raw.toString('utf8');
    if (!Buffer.from(text).equals(raw)) throw new Error('Invalid Goal input');
    return JSON.parse(text) as unknown;
  } finally {
    await handle.close();
  }
}

export async function agentGoalList(deps: AgentDeps): Promise<number> {
  try {
    const response = await deps.request(deps.ctx, { method: 'GET', path: '/api/goals' });
    const error = rejected(response, false);
    if (error) return fail(deps, error);
    const parsed = z.array(GoalFullRecord).max(128).safeParse(response.json?.data);
    if (!parsed.success) return fail(deps, 'GOAL_RESPONSE_INVALID');
    const summaries = parsed.data.map(goalSummary);
    return output(deps, summaries, parsed.data.map(line).join('\n') || '(no visible Goals)');
  } catch {
    return fail(deps, 'GOAL_UNAVAILABLE');
  }
}
export async function agentGoalRead(deps: AgentDeps, id: string, full = false): Promise<number> {
  if (!GoalId.safeParse(id).success) return fail(deps, 'GOAL_INVALID');
  try {
    const response = await deps.request(deps.ctx, { method: 'GET', path: `/api/goals/${id}` });
    const error = rejected(response, false);
    if (error) return fail(deps, error);
    const parsed = GoalFullRecord.safeParse(response.json?.data);
    if (!parsed.success || parsed.data.id !== id) return fail(deps, 'GOAL_RESPONSE_INVALID');
    return output(
      deps,
      full ? parsed.data : goalSummary(parsed.data),
      full ? JSON.stringify(parsed.data, null, 2) : line(parsed.data)
    );
  } catch {
    return fail(deps, 'GOAL_UNAVAILABLE');
  }
}
export async function agentGoalMetadata(deps: AgentDeps, employeeId: string, grantId?: string): Promise<number> {
  if (!GoalId.safeParse(employeeId).success || (grantId !== undefined && !GoalId.safeParse(grantId).success))
    return fail(deps, 'GOAL_INVALID');
  try {
    const response = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/goal-metadata/${employeeId}`,
      ...(grantId === undefined ? {} : { query: { grantId } }),
    });
    const error = rejected(response, false);
    if (error) return fail(deps, error);
    const parsed = z.array(GoalMetadata).max(128).safeParse(response.json?.data);
    if (!parsed.success || parsed.data.some((goal) => goal.employeeId !== employeeId))
      return fail(deps, 'GOAL_RESPONSE_INVALID');
    return output(deps, parsed.data, parsed.data.map(line).join('\n') || '(no visible Goal metadata)');
  } catch {
    return fail(deps, 'GOAL_UNAVAILABLE');
  }
}

/** Caller supplies the stable createId; transport uncertainty never generates another command. */
export async function agentGoalCreate(deps: AgentDeps, raw: unknown): Promise<number> {
  const input = GoalCreateCommand.safeParse(raw);
  if (!input.success) return fail(deps, 'GOAL_INVALID');
  const command = input.data;
  try {
    const response = await deps.request(deps.ctx, { method: 'POST', path: '/api/goals', body: command });
    const error = rejected(response, true);
    if (error) return fail(deps, error, command.createId);
    const parsed = GoalFullRecord.safeParse(response.json?.data);
    if (
      !parsed.success ||
      parsed.data.createId !== command.createId ||
      parsed.data.employeeId !== command.employeeId ||
      parsed.data.sessionId !== command.sessionId ||
      parsed.data.sessionGeneration !== command.sessionGeneration ||
      parsed.data.generation !== 1 ||
      parsed.data.state !== 'READY' ||
      parsed.data.transitionSequence !== 0
    )
      return fail(deps, 'GOAL_SUBMIT_UNCERTAIN', command.createId);
    return output(deps, { createId: command.createId, goal: goalSummary(parsed.data) }, line(parsed.data));
  } catch {
    return fail(deps, 'GOAL_SUBMIT_UNCERTAIN', command.createId);
  }
}
export async function agentGoalTransition(deps: AgentDeps, id: string, raw: unknown): Promise<number> {
  const input = GoalTransitionCommand.safeParse(raw);
  if (!GoalId.safeParse(id).success || !input.success) return fail(deps, 'GOAL_INVALID');
  const command = input.data;
  try {
    const response = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/goals/${id}/transitions`,
      body: command,
    });
    const error = rejected(response, true);
    if (error) return fail(deps, error, command.transitionId);
    const parsed = GoalCommandResult.safeParse(response.json?.data);
    const expectedGeneration =
      command.generation + (['DONE', 'NO_GO', 'CANCELLED'].includes(command.expectedState) ? 1 : 0);
    if (!parsed.success) return fail(deps, 'GOAL_SUBMIT_UNCERTAIN', command.transitionId);
    const { goal, receipt } = parsed.data;
    if (
      goal.id !== id ||
      goal.generation !== expectedGeneration ||
      receipt.generation !== goal.generation ||
      goal.sessionId !== command.sessionId ||
      goal.sessionGeneration !== command.sessionGeneration ||
      goal.state !== command.to ||
      receipt.to !== command.to ||
      receipt.from !== command.expectedState ||
      goal.transitionSequence !== command.expectedSequence + 1 ||
      receipt.sequence !== goal.transitionSequence ||
      receipt.transitionId !== command.transitionId ||
      receipt.operation !== 'TRANSITION' ||
      receipt.at !== goal.updatedAt
    )
      return fail(deps, 'GOAL_SUBMIT_UNCERTAIN', command.transitionId);
    // A verifier result is already closed; preserve its discriminant and exact shape.
    const value =
      parsed.data.visibility === 'verification'
        ? parsed.data
        : { visibility: 'summary', goal: goalSummary(goal), receipt: closedReceipt(receipt) };
    return output(deps, value, `${line(goal)} receipt=${receipt.transitionId} visibility=${parsed.data.visibility}`);
  } catch {
    return fail(deps, 'GOAL_SUBMIT_UNCERTAIN', command.transitionId);
  }
}

export function registerGoalCommands(
  agent: Command,
  run: (json: boolean, verb: (deps: AgentDeps) => Promise<number>) => Promise<void>
): void {
  const goal = agent
    .command('goal')
    .description('Canonical Goals through the scoped office API (requires installed server support)');
  goal
    .command('list')
    .option('--json', 'Closed state summaries as JSON')
    .action((options: { json?: boolean }) => run(!!options.json, agentGoalList));
  goal
    .command('read <id>')
    .option('--full', 'Explicit authorized full private record')
    .option('--json', 'JSON output')
    .action((id: string, options: { json?: boolean; full?: boolean }) =>
      run(!!options.json, (deps) => agentGoalRead(deps, id, !!options.full))
    );
  goal
    .command('metadata <employee-id>')
    .option('--grant <id>', 'Existing owner-issued metadata-read grant ID')
    .option('--json', 'Closed projection as JSON')
    .action((id: string, options: { json?: boolean; grant?: string }) =>
      run(!!options.json, (deps) => agentGoalMetadata(deps, id, options.grant))
    );
  for (const verb of ['create', 'transition'] as const) {
    goal
      .command(verb === 'create' ? 'create' : 'transition <id>')
      .requiredOption(
        '--input <path>',
        'Bounded JSON command file, including stable createId/transitionId and exact CAS fields'
      )
      .option('--json', 'Closed state/receipt output')
      .action((...args: unknown[]) => {
        const id = verb === 'transition' ? (args[0] as string) : undefined;
        const options = args[verb === 'transition' ? 1 : 0] as { input: string; json?: boolean };
        return run(!!options.json, async (deps) => {
          let raw: unknown;
          try {
            raw = await readGoalCommand(options.input);
          } catch {
            return fail(deps, 'GOAL_INVALID');
          }
          return verb === 'create' ? agentGoalCreate(deps, raw) : agentGoalTransition(deps, id!, raw);
        });
      });
  }
}
