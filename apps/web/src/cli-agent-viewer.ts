/** Viewer-only recovery through the current authenticated office context. */
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT as EXIT } from './agent-exit-codes.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface ViewerRecoveryStatus {
  state: 'idle' | 'connecting' | 'connected' | 'blocked';
  reason: string;
  attempts: number;
  retryAfterMs: number;
}

export function viewerRecoveryStatus(value: unknown): ViewerRecoveryStatus | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as ViewerRecoveryStatus;
  if (
    !['idle', 'connecting', 'connected', 'blocked'].includes(v.state) ||
    typeof v.reason !== 'string' ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(v.reason) ||
    !Number.isSafeInteger(v.attempts) ||
    v.attempts < 0 ||
    v.attempts > 1000 ||
    !Number.isSafeInteger(v.retryAfterMs) ||
    v.retryAfterMs < 0 ||
    v.retryAfterMs > 60_000
  )
    return;
  return { state: v.state, reason: v.reason, attempts: v.attempts, retryAfterMs: v.retryAfterMs };
}

export async function agentViewerRecovery(
  deps: AgentDeps,
  options: { employeeId: string; statusOnly?: boolean }
): Promise<number> {
  const fail = (message: string, code: number = EXIT.error) => {
    deps.io.err(message);
    return code;
  };
  const id = options.employeeId;
  if (!UUID.test(id)) return fail('Use a full canonical employee UUID, not a session ID, name or PID.', EXIT.refused);
  let company;
  try {
    company = await deps.request(deps.ctx, { method: 'GET', path: '/api/company' });
  } catch {
    return fail('Current company bindings could not be read. Nothing was requested.');
  }
  const employees = (
    company.json?.data as
      | { employees?: Array<{ id?: unknown; sessionId?: unknown; sessionGeneration?: unknown }> }
      | undefined
  )?.employees;
  if (!company.json?.success || company.status < 200 || company.status >= 300)
    return fail(
      'Current company bindings could not be verified.',
      [401, 403].includes(company.status) ? EXIT.refused : EXIT.error
    );
  const matches = Array.isArray(employees) ? employees.filter((e) => e.id === id) : [];
  const target = matches[0];
  if (
    matches.length !== 1 ||
    typeof target?.sessionId !== 'string' ||
    !UUID.test(target.sessionId) ||
    !Number.isSafeInteger(target.sessionGeneration) ||
    Number(target.sessionGeneration) < 1
  )
    return fail(
      'A unique current employee/session/generation binding could not be confirmed. Nothing was requested.',
      EXIT.refused
    );
  const path = `/api/company/employees/${id}/reconnect${options.statusOnly ? '/status' : ''}`;
  let response;
  try {
    response = await deps.request(deps.ctx, {
      method: 'POST',
      path,
      body: { sessionId: target.sessionId, sessionGeneration: target.sessionGeneration },
    });
  } catch {
    return fail(
      options.statusOnly
        ? 'Viewer status is unavailable.'
        : 'Viewer recovery outcome is unconfirmed. It was not retried; inspect viewer-status before another action.'
    );
  }
  const data = response.json?.data as { state?: unknown; reconnect?: unknown } | undefined;
  const status = viewerRecoveryStatus(
    data?.reconnect ?? (response.json as { reconnect?: unknown } | undefined)?.reconnect
  );
  const ok =
    response.status >= 200 &&
    response.status < 300 &&
    response.json?.success &&
    !!status &&
    (options.statusOnly || (data?.state === 'viewer-connected' && status.state === 'connected'));
  if (deps.json && status)
    deps.io.out(
      JSON.stringify({ ...(ok && !options.statusOnly ? { state: 'viewer-connected' } : {}), reconnect: status })
    );
  else if (status)
    deps.io.out(
      `Viewer ${status.state}: ${status.reason}; attempts ${status.attempts}; retry after ${status.retryAfterMs} ms.`
    );
  if (!ok)
    return fail(
      status
        ? 'Viewer recovery was not confirmed; no replacement was requested by this client.'
        : 'Viewer recovery/status response is unconfirmed. It was not retried.',
      [401, 403, 409].includes(response.status) ? EXIT.refused : EXIT.error
    );
  if (!deps.json && !options.statusOnly)
    deps.io.out('Viewer connected. Provider continuity and chat acceptance require their own readback.');
  return EXIT.ok;
}
