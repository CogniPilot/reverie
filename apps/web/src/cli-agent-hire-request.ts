/**
 * @fileoverview `reverie agent hire-request`: a listed hire delegate asks the owner for a full hire (template, harness,
 * account, name, position, reporting line, rooms, reason). Nothing is hired until the owner approves it in Company; the
 * server re-runs every hire check then. This client only sends and formats.
 */
import type { Command } from 'commander';
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT } from './agent-exit-codes.js';
import type { ExpertHireRequest } from './experts.js';

const bounds = { maxBytes: 256 * 1024, deadlineMs: 15_000 };
const repeat = (value: string, all: string[] = []) => [...all, value];

export interface HireRequestOptions {
  workingDir: string;
  reason: string;
  mode?: string;
  model?: string;
  effort?: string;
  account?: string;
  name?: string;
  position?: string;
  reportsTo?: string;
  room?: string[];
  budgetPlan?: string;
  budgetPercent?: string;
}

async function call(deps: AgentDeps, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) {
  const response = await deps.request(deps.ctx, { method, path, ...(body ? { body } : {}), bounds });
  const envelope = response.json as { success?: boolean; data?: unknown; error?: string } | undefined;
  return { ok: response.status === 200 && envelope?.success === true, status: response.status, data: envelope?.data,
    error: envelope?.error ?? `hire request failed (${response.status})` };
}

function refused(deps: AgentDeps, error: string): number {
  if (deps.json) deps.io.out(JSON.stringify({ success: false, error }));
  else deps.io.err(error);
  return AGENT_EXIT.refused;
}

const line = (r: ExpertHireRequest) =>
  `${r.id} ${r.status} template ${r.templateId}${r.fields.name ? ` as ${r.fields.name}` : ''} (${new Date(r.requestedAt).toISOString()})` +
  (r.note ? ` note: ${r.note}` : '');

export async function agentHireRequest(deps: AgentDeps, templateId: string, options: HireRequestOptions): Promise<number> {
  if ((options.budgetPlan === undefined) !== (options.budgetPercent === undefined))
    return refused(deps, 'Give --budget-plan and --budget-percent together, or neither.');
  const body: Record<string, unknown> = { workingDir: options.workingDir, reason: options.reason };
  if (options.mode) body.mode = options.mode;
  if (options.model) body.model = options.model;
  if (options.effort) body.effort = options.effort;
  if (options.account) body.accountProfileId = options.account;
  if (options.name) body.name = options.name;
  if (options.position) body.position = options.position;
  if (options.reportsTo) body.reportsTo = options.reportsTo;
  if (options.room?.length) body.rooms = options.room;
  if (options.budgetPlan !== undefined) body.budgetStop = { planId: options.budgetPlan, weeklyPercent: Number(options.budgetPercent) };
  try {
    const result = await call(deps, 'POST', `/api/experts/${encodeURIComponent(templateId)}/hire-requests`, body);
    if (!result.ok) return refused(deps, result.error);
    const request = (result.data as { request: ExpertHireRequest }).request;
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data: { request } }));
    else deps.io.out(`Asked the owner: request ${request.id} (template ${request.templateId}). Nothing is hired until the owner approves it in Company.`);
    return AGENT_EXIT.ok;
  } catch {
    // The request may or may not have been saved: `list` shows it if it was.
    return refused(deps, 'Hire request outcome unknown; check `reverie agent hire-request list` before asking again.');
  }
}

export async function agentHireRequestList(deps: AgentDeps): Promise<number> {
  try {
    const result = await call(deps, 'GET', '/api/experts-hire-requests');
    if (!result.ok) return refused(deps, result.error);
    const requests = (result.data as { requests: ExpertHireRequest[] }).requests;
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data: { requests } }));
    else deps.io.out(requests.length ? requests.map(line).join('\n') : 'No hire requests.');
    return AGENT_EXIT.ok;
  } catch {
    return refused(deps, 'Hire requests unavailable.');
  }
}

export async function agentHireRequestWithdraw(deps: AgentDeps, requestId: string): Promise<number> {
  try {
    const result = await call(deps, 'POST', `/api/experts-hire-requests/${encodeURIComponent(requestId)}/withdraw`, {});
    if (!result.ok) return refused(deps, result.error);
    const request = (result.data as { request: ExpertHireRequest }).request;
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data: { request } }));
    else deps.io.out(`Withdrew hire request ${request.id}.`);
    return AGENT_EXIT.ok;
  } catch {
    return refused(deps, 'Withdraw outcome unknown; check `reverie agent hire-request list`.');
  }
}

export function registerHireRequestCommands(
  agent: Command,
  run: (json: boolean, verb: (deps: AgentDeps) => Promise<number>) => Promise<void>
): void {
  const hire = agent.command('hire-request')
    .description('As a listed hire delegate, ask the owner to hire an expert; only the owner\'s approval in Company hires');
  hire.command('submit <template-id>').description('Ask for a full hire from an expert template; the owner approves or declines it')
    .requiredOption('--working-dir <path>', 'Absolute working directory for the new expert')
    .requiredOption('--reason <why>', 'Why this hire, 3-500 characters (shown to the owner)')
    .option('--mode <harness>', 'Harness, e.g. claude or codex (default: the template\'s)')
    .option('--model <id>', 'Model (default: the template\'s)')
    .option('--effort <level>', 'Effort level')
    .option('--account <profile-id>', 'Account profile, i.e. the plan the expert runs on')
    .option('--name <name>', 'Name in the company (default: the template\'s)')
    .option('--position <role>', 'Position (default: the template\'s role)')
    .option('--reports-to <employee-id>', 'Employee id the new expert reports to')
    .option('--room <room-id>', 'Room to join instead of the template\'s rooms (repeat)', repeat)
    .option('--budget-plan <plan-id>', 'Budget stop: plan to watch (with --budget-percent)')
    .option('--budget-percent <n>', 'Budget stop: weekly percent at which the expert is asked to hand off and is retired')
    .option('--json', 'Machine-readable request')
    .action((templateId: string, options: HireRequestOptions & { json?: boolean }) =>
      run(Boolean(options.json), deps => agentHireRequest(deps, templateId, options)));
  hire.command('list').description('Your hire requests and their status').option('--json', 'Machine-readable requests')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentHireRequestList));
  hire.command('withdraw <request-id>').description('Take back your own pending hire request').option('--json', 'Machine-readable request')
    .action((requestId: string, options: { json?: boolean }) => run(Boolean(options.json), deps => agentHireRequestWithdraw(deps, requestId)));
}
