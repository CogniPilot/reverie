/**
 * @fileoverview `reverie agent model <employee-id> [model]`: read or choose an employee's Claude model.
 *
 * A client of `GET`/`PUT /api/company/employees/:id/model`. The server owns every check: the caller
 * needs the owner-set manageModels grant to choose (for a colleague or itself), and reads its own
 * model without one. The server types `/model` only into an idle, empty composer, so a reply of
 * `pending` is normal: the choice is kept and applied at the employee's next idle moment.
 *
 * @module cli-agent-model
 */
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT as EXIT } from './agent-exit-codes.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._\-[\]]*$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

interface ModelStatus {
  employeeId?: string;
  name?: string;
  supported?: boolean;
  preferred?: { model?: string; effort?: string; by?: string };
  live?: string;
  target?: string;
  state?: string;
  reason?: string;
  fallback?: { from?: string; to?: string; family?: string; restore?: string; restoreAt?: number };
}

const fail = (deps: AgentDeps, message: string, code: number = EXIT.error): number => {
  deps.io.err(message);
  return code;
};

/** One line a person can read. */
export function describeModelStatus(status: ModelStatus): string {
  const name = status.name ?? status.employeeId ?? 'Employee';
  if (status.supported === false) return `${name}: this employee's CLI does not take a model this way.`;
  const parts = [`${name}: running ${status.live ?? 'an unreported model'}`];
  if (status.preferred?.model)
    parts.push(
      `chosen ${status.preferred.model}${status.preferred.effort ? ` (effort ${status.preferred.effort})` : ''} by ${status.preferred.by ?? 'unknown'}`
    );
  if (status.fallback?.to)
    parts.push(
      `on ${status.fallback.to} after the ${status.fallback.family ?? 'model'} limit, back to ${status.fallback.restore ?? 'nothing named'} after ${status.fallback.restoreAt ? new Date(status.fallback.restoreAt).toISOString() : 'the reset'}`
    );
  if (status.target && status.state) parts.push(`${status.state}${status.reason ? `: ${status.reason}` : ''}`);
  return parts.join('; ') + '.';
}

export async function agentEmployeeModel(
  deps: AgentDeps,
  options: { employeeId: string; model?: string; effort?: string }
): Promise<number> {
  const { employeeId, model, effort } = options;
  if (!UUID.test(employeeId))
    return fail(deps, 'Use a full canonical employee UUID, not a name, session ID or PID.', EXIT.refused);
  if (model !== undefined && (model.length > 100 || !MODEL.test(model)))
    return fail(
      deps,
      'Give a Claude model id such as claude-opus-5-5 (letters, digits, . _ - [ ] only).',
      EXIT.refused
    );
  if (effort !== undefined && (model === undefined || !EFFORTS.includes(effort)))
    return fail(deps, `--effort needs a model and one of ${EFFORTS.join(', ')}.`, EXIT.refused);
  const path = `/api/company/employees/${employeeId}/model`;
  let response;
  try {
    response = await deps.request(
      deps.ctx,
      model === undefined
        ? { method: 'GET', path }
        : { method: 'PUT', path, body: { model, ...(effort ? { effort } : {}) } }
    );
  } catch {
    return fail(
      deps,
      model === undefined
        ? 'The model could not be read.'
        : 'The outcome is unconfirmed. It was not retried; read the model before choosing again.'
    );
  }
  if (!response.json?.success || response.status < 200 || response.status >= 300)
    return fail(
      deps,
      response.json?.error || 'Refused.',
      [400, 401, 403, 404, 409].includes(response.status) ? EXIT.refused : EXIT.error
    );
  const status = response.json.data as ModelStatus;
  deps.io.out(deps.json ? JSON.stringify(status) : describeModelStatus(status));
  return status.state === 'failed' ? EXIT.error : EXIT.ok;
}
