/** Explicit company permissions authorize a bounded migration, never general session creation. */
import type { FastifyRequest } from 'fastify';
import type { PlanRequestExecution } from './plan-request.js';
import type { PlanMoveRuntime } from './plan-move-runtime.js';
import { planMoveExecutor } from './plan-move-runtime.js';
import { PlanMoveError } from './plan-move.js';
import { ownerFor, resolveParentSessionId } from './web/route-helpers.js';
import { isMultiUserMode } from './config/multiuser.js';
import { withDelegatedSessionCreate, withDelegatedSessionStart } from './owner-auth/delegated-session-create.js';

export interface AgentPlanInput {
  employeeId: string;
  sessionId: string;
}
export function agentPlanRequestExecution(
  request: FastifyRequest,
  input: AgentPlanInput,
  runtime: Omit<PlanMoveRuntime, 'authorized' | 'request'>,
  invoke: PlanMoveRuntime['request'] // transport retains the authenticated caller's credentials
): PlanRequestExecution | undefined {
  // Shared provider accounts have no per-user ownership model yet. Never turn a member login into account authority.
  if (isMultiUserMode()) return undefined;
  const owner = ownerFor(request);
  const callerId = resolveParentSessionId({ sessions: runtime.sessions }, request, undefined, owner);
  if (!callerId || request.headers['x-reverie-parent-session'] !== callerId) return undefined;
  const caller = runtime.sessions.get(callerId);
  const source = runtime.sessions.get(input.sessionId);
  const employees = () => runtime.company.view(owner).employees;
  const delegate = employees().find((employee) => employee.sessionId === callerId);
  const target = employees().find(
    (employee) => employee.id === input.employeeId && employee.sessionId === input.sessionId
  );
  if (
    !caller ||
    !source ||
    !delegate ||
    !target ||
    caller.owner !== owner ||
    source.owner !== owner ||
    target.onVacation
  )
    return undefined;
  let candidate: string | undefined;
  let candidateSession: typeof source | undefined;
  let sourceStopped = false;
  const deadline = Date.now() + 30 * 60_000;
  const authorized = () => {
    const current = employees().find((employee) => employee.id === delegate.id);
    const employee = employees().find((employee) => employee.id === target.id);
    const validBinding = (id: string | undefined) => id === input.sessionId || (!!candidate && id === candidate);
    return (
      Date.now() < deadline &&
      caller.owner === owner && source.owner === owner &&
      (delegate.id === target.id && sourceStopped
        ? runtime.sessions.get(callerId) === undefined
        : runtime.sessions.get(callerId) === caller) &&
      (sourceStopped ? runtime.sessions.get(input.sessionId) === undefined : runtime.sessions.get(input.sessionId) === source) &&
      (!candidate || (!!candidateSession && runtime.sessions.get(candidate) === candidateSession && candidateSession.owner === owner)) &&
      !!current &&
      !!employee &&
      current.owner === owner &&
      employee.owner === owner &&
      !current.onVacation &&
      !employee.onVacation &&
      current.desiredRunning !== false &&
      employee.desiredRunning !== false &&
      validBinding(employee.sessionId) &&
      (delegate.id === target.id
        ? validBinding(current.sessionId) && (current.permissions.moveOwnPlan || current.permissions.managePlans)
        : current.sessionId === callerId && current.permissions.managePlans)
    );
  };
  if (!authorized()) return undefined;
  const executor = planMoveExecutor(
    {
      ...runtime,
      authorized,
      actor: callerId,
      cleanup: async (id, killMux, reason) => {
        if (id !== input.sessionId && id !== candidate)
          throw new PlanMoveError('Cleanup is outside the approved plan move', 403);
        if (id === candidate && runtime.sessions.get(id) !== candidateSession)
          throw new PlanMoveError('The candidate identity changed; cleanup requires inspection');
        if (id !== input.sessionId) return runtime.cleanup(id, killMux, reason);
        if (!candidate || killMux !== true || reason !== 'plan_move' || !authorized())
          throw new PlanMoveError('The approved source cleanup is no longer authorized', 403);
        await runtime.cleanup(id, killMux, reason);
        if (runtime.sessions.has(id)) throw new PlanMoveError('The source session was not removed by its approved cleanup');
        // Only this exact successful cleanup may retire the original transport.
        // The approved employee and fresh permissions remain the authority;
        // missing/replaced registry entries alone can never establish this proof.
        sourceStopped = true;
      },
      request: async (method, url, payload) => {
        if (!authorized()) throw new PlanMoveError('The agent’s plan permission or employee binding changed', 403);
        if (method === 'POST' && url === '/api/sessions' && !candidate) {
          const body: Record<string, unknown> = {
            ...(payload as Record<string, unknown>),
            parentSessionId: input.sessionId,
          };
          if (body.employeeId !== input.employeeId) throw new PlanMoveError('The move targets another employee', 403);
          const response = await withDelegatedSessionCreate(
            { sessionId: input.sessionId, owner, payload: body, authorized },
            () => invoke(method, url, body)
          );
          const id = (response as { data?: { session?: { id?: unknown } } })?.data?.session?.id;
          const created = typeof id === 'string' ? runtime.sessions.get(id) : undefined;
          if (typeof id !== 'string' || id === input.sessionId || !created || created.owner !== owner)
            throw new PlanMoveError('The move did not create an owned candidate');
          candidate = id;
          candidateSession = created;
          return response;
        }
        if (candidate && method === 'POST' && url === `/api/sessions/${encodeURIComponent(candidate)}/interactive`)
          return withDelegatedSessionStart(
            { sessionId: input.sessionId, owner, targetSessionId: candidate, authorized },
            () => invoke(method, url, payload)
          );
        if (
          candidate &&
          method === 'GET' &&
          url.startsWith(`/api/sessions/${encodeURIComponent(candidate)}/wait-output?`)
        )
          return invoke(method, url, payload);
        throw new PlanMoveError('This request is outside the approved plan move', 403);
      },
    },
    owner
  );
  return { executor, authorized, requestedBy: callerId };
}
