/** Explicit PAT grants: server metadata stays public-to-owner; material is released only to its current employee. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import {
  PUBLICATION_TOKEN_ID, PublicationCredentialVault, PublicationVaultError,
} from '../../publication-credentials.js';
import { ownerFor, resolveParentSessionId } from '../route-helpers.js';
import type { SessionPort } from '../ports/session-port.js';
import { ownCredentialStatus } from '../../publication-credential-status.js';

export interface PublicationEmployee {
  id: string;
  sessionId: string;
  sessionGeneration?: number;
  desiredRunning?: boolean;
  onVacation: boolean;
  bindingMigration?: unknown;
  permissions?: { publicationTokenIds?: string[] };
}
export interface PublicationRouteDeps {
  vault: PublicationCredentialVault;
  verifiedOwner: OwnerVerifier;
  /** Must classify the actual caller, not just echo a header. Owners and services return undefined. */
  agentSession: (request: FastifyRequest) => string | undefined;
  company: (owner: string | undefined) => { employees: readonly PublicationEmployee[] };
}

function privateResponse(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.header('X-Content-Type-Options', 'nosniff');
}
function failure(reply: FastifyReply, error: unknown) {
  privateResponse(reply);
  const safe = error instanceof PublicationVaultError ? error : new PublicationVaultError();
  return reply.code(safe.status).send({ success: false, error: safe.message, errorCode: safe.code });
}

export function registerPublicationRoutes(
  app: FastifyInstance,
  ctx: Pick<SessionPort, 'sessions'>,
  deps: PublicationRouteDeps
): void {
  const owner = (request: FastifyRequest) => {
    if (!deps.verifiedOwner(request)) throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
    return ownerFor(request);
  };
  const currentAgent = (request: FastifyRequest) => {
    const owner = ownerFor(request);
    const sessionId = deps.agentSession(request);
    const raw = request.headers['x-reverie-parent-session'];
    if (!sessionId || raw !== sessionId || request.headers['x-reverie-service-token'] !== undefined ||
        resolveParentSessionId(ctx, request, undefined, owner) !== sessionId)
      throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
    const session = ctx.sessions.get(sessionId);
    if (!session || typeof session.pid !== 'number' || session.pid <= 0 || session.paneExit !== undefined)
      throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
    const employees = deps.company(owner).employees;
    const matches = employees.filter(employee => employee.sessionId === sessionId);
    const employee = matches[0];
    if (matches.length !== 1 || !employee || employees.filter(row => row.id === employee.id).length !== 1 ||
        employee.desiredRunning === false || employee.onVacation !== false || employee.bindingMigration != null)
      throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
    const ids = employee.permissions?.publicationTokenIds ?? [];
    if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string' || !PUBLICATION_TOKEN_ID.test(id)))
      throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
    return { owner, employeeId: employee.id, sessionId, sessionGeneration: employee.sessionGeneration, ids };
  };
  const sameActor = (first: ReturnType<typeof currentAgent>, current: ReturnType<typeof currentAgent>) => {
    if (current.owner !== first.owner || current.employeeId !== first.employeeId || current.sessionId !== first.sessionId ||
        current.sessionGeneration !== first.sessionGeneration) throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
  };
  const options = {
    bodyLimit: 32768,
    // Parsing/schema errors must not echo any submitted PAT or filesystem detail.
    errorHandler: (_error: unknown, _request: FastifyRequest, reply: FastifyReply) =>
      failure(reply, new PublicationVaultError('PUBLICATION_INVALID')),
  };

  app.get('/api/publication/tokens', options, async (request, reply) => {
    privateResponse(reply);
    try {
      const selected = owner(request);
      const tokens = await deps.vault.metadata(selected);
      if (owner(request) !== selected) throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
      return { success: true, data: { tokens } };
    } catch (error) { return failure(reply, error); }
  });
  app.post('/api/publication/tokens', options, async (request, reply) => {
    privateResponse(reply);
    try {
      const selected = owner(request);
      const validate = () => { if (owner(request) !== selected) throw new PublicationVaultError('PUBLICATION_FORBIDDEN'); };
      const token = await deps.vault.create(selected, request.body, validate);
      return { success: true, data: { token } };
    } catch (error) { return failure(reply, error); }
  });
  app.put<{ Params: { id: string } }>('/api/publication/tokens/:id', options, async (request, reply) => {
    privateResponse(reply);
    try {
      const selected = owner(request);
      const validate = () => { if (owner(request) !== selected) throw new PublicationVaultError('PUBLICATION_FORBIDDEN'); };
      const token = await deps.vault.update(selected, request.params.id, request.body, validate);
      return { success: true, data: { token } };
    } catch (error) { return failure(reply, error); }
  });
  app.delete<{ Params: { id: string } }>('/api/publication/tokens/:id', options, async (request, reply) => {
    privateResponse(reply);
    try {
      const selected = owner(request);
      const validate = () => { if (owner(request) !== selected) throw new PublicationVaultError('PUBLICATION_FORBIDDEN'); };
      return { success: true, data: await deps.vault.remove(selected, request.params.id, validate) };
    } catch (error) { return failure(reply, error); }
  });
  app.get('/api/publication/credentials', options, async (request, reply) => {
    privateResponse(reply);
    try {
      const first = currentAgent(request);
      const metadata = await deps.vault.metadata(first.owner);
      const current = currentAgent(request); sameActor(first, current);
      return { success: true, data: {
        employeeId: current.employeeId, sessionId: current.sessionId,
        credentials: metadata.filter(entry => current.ids.includes(entry.id)),
      } };
    } catch (error) { return failure(reply, error); }
  });
  app.get('/api/publication/credentials/status', options, async (request, reply) => {
    privateResponse(reply);
    try {
      if (Object.keys(request.query as object).length) throw new PublicationVaultError('PUBLICATION_INVALID');
      const first = currentAgent(request);
      const metadata = await deps.vault.metadata(first.owner);
      const current = currentAgent(request); sameActor(first, current);
      return { success: true, data: ownCredentialStatus(current, metadata) };
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/publication/credentials/:id/material', options, async (request, reply) => {
    privateResponse(reply);
    try {
      if (request.body !== undefined && (request.body === null || typeof request.body !== 'object' ||
          Array.isArray(request.body) || Object.keys(request.body).length !== 0)) throw new PublicationVaultError('PUBLICATION_INVALID');
      const first = currentAgent(request);
      const validate = () => {
        const current = currentAgent(request); sameActor(first, current);
        if (!current.ids.includes(request.params.id)) throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
      };
      validate();
      const material = await deps.vault.material(first.owner, request.params.id, validate);
      validate();
      reply.header('X-Reverie-Employee-Id', first.employeeId);
      reply.header('X-Reverie-Session-Id', first.sessionId);
      reply.header('X-Reverie-Credential-Id', request.params.id);
      reply.header('Content-Length', String(material.length));
      return reply.type('application/octet-stream').send(material);
    } catch (error) { return failure(reply, error); }
  });
}
