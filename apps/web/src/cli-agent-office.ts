/** Explicit employee attendance/restart client. The server owns all authority and startup guards. */
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT as EXIT } from './agent-exit-codes.js';

type Options = { employeeId: string; action: 'in' | 'out' | 'restart'; forceRestart?: boolean };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (deps: AgentDeps, message: string, code: number = EXIT.error): number => { deps.io.err(message); return code; };

export async function agentEmployeeOffice(deps: AgentDeps, options: Options): Promise<number> {
  const id = options.employeeId;
  if (!UUID.test(id)) return fail(deps, 'Use a full canonical employee UUID, not a name, session ID or PID.', EXIT.refused);
  if (!['in', 'out', 'restart'].includes(options.action) || (options.forceRestart && options.action !== 'restart'))
    return fail(deps, 'Choose exactly one explicit office or restart action.', EXIT.refused);
  let response;
  try { response = await deps.request(deps.ctx, { method: 'GET', path: '/api/company' }); }
  catch { return fail(deps, 'Current company bindings could not be read. Nothing was requested.'); }
  if (!response.json?.success || response.status < 200 || response.status >= 300)
    return fail(deps, response.json?.error || 'Current company bindings could not be read.', [401, 403].includes(response.status) ? EXIT.refused : EXIT.error);
  const employees = (response.json.data as { employees?: Array<{ id?: unknown; sessionId?: unknown; sessionGeneration?: unknown }> } | undefined)?.employees;
  const matches = Array.isArray(employees) ? employees.filter(employee => employee?.id === id) : [];
  const target = matches[0];
  if (matches.length !== 1 || typeof target?.sessionId !== 'string' || !UUID.test(target.sessionId) ||
      !Number.isSafeInteger(target.sessionGeneration) || Number(target.sessionGeneration) < 1)
    return fail(deps, 'A unique current employee/session/generation binding could not be confirmed. Nothing was requested.', EXIT.refused);
  const restart = options.action === 'restart';
  const body = restart ? (options.forceRestart ? { forceRestart: true, confirmSessionId: target.sessionId } : {}) : { enabled: options.action === 'out' };
  try {
    response = await deps.request(deps.ctx, { method: 'POST', path: `/api/company/employees/${id}/${restart ? 'restart' : 'vacation'}`, body });
  } catch { return fail(deps, 'Employee operation outcome is unconfirmed. It was not retried; read current status before another action.'); }
  if (!response.json?.success || response.status < 200 || response.status >= 300)
    return fail(deps, response.json?.error || 'Employee operation was refused or unconfirmed.', [401, 403, 409].includes(response.status) ? EXIT.refused : EXIT.error);
  const data = response.json.data as { employee?: { id?: unknown; sessionId?: unknown; sessionGeneration?: unknown; onVacation?: unknown; desiredRunning?: unknown }; sessionId?: unknown; recovery?: unknown; startup?: { state?: unknown; reason?: unknown } } | undefined;
  const saved = data?.employee;
  if (saved?.id !== id || saved.sessionId !== target.sessionId || saved.sessionGeneration !== target.sessionGeneration)
    return fail(deps, 'Employee operation result does not confirm the selected binding. Do not retry without reading current status.');
  if (restart) {
    if (data?.sessionId !== target.sessionId || data.recovery !== 'normal-launch-requested')
      return fail(deps, 'Restart result is unconfirmed. It was not retried; inspect current status.');
  } else if (saved.onVacation !== (options.action === 'out') || saved.desiredRunning !== (options.action === 'in')) {
    return fail(deps, 'Office attendance result is unconfirmed. It was not retried; inspect current status.');
  }
  if (options.action === 'in' && !['started', 'blocked', 'already-running'].includes(String(data?.startup?.state)))
    return fail(deps, 'Office attendance was saved, but startup status is unconfirmed. It was not retried.');
  if (deps.json) deps.io.out(JSON.stringify(data));
  else deps.io.out(restart ? `Normal restart requested for employee ${id}; native readiness is not proved by this reply.`
    : options.action === 'out' ? `Employee ${id} is out of office.`
      : `Employee ${id} is in office; startup ${String(data?.startup?.state)}. Check native status before assigning work.`);
  return options.action === 'in' && data?.startup?.state === 'blocked' ? EXIT.refused : EXIT.ok;
}
