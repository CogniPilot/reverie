/**
 * @fileoverview The supported way out of a "provider launch outcome is unconfirmed" input hold.
 *
 * `GET /api/sessions/:id/provider-hold` reports the hold. `POST` settles it:
 * `{ "observation": "auto" }` asks the office to read the session's own terminal again, and
 * `"running"` / `"not-running"` are the verified owner's reading of that terminal, for the case
 * the office cannot tell by itself. Only input to the existing agent is settled here; a new
 * launch stays fenced (see provider-hold-reconcile.ts).
 *
 * Both verbs are the verified owner's alone: an agent's request (it carries
 * `X-Reverie-Parent-Session`) or any caller without verified owner sign-in is refused. An agent
 * needs no route for the automatic check, which also runs on every input it sends to a held
 * session and on the server's own periodic pass.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionPort } from '../ports/session-port.js';
import type { EventPort } from '../ports/event-port.js';
import { SseEvent } from '../sse-events.js';
import type { Session } from '../../session.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import {
  PROVIDER_HOLD_CLAIMS,
  providerHoldPath,
  type ProviderHoldReconciliation,
} from '../../provider-hold-reconcile.js';

const Body = z.object({ observation: z.enum(PROVIDER_HOLD_CLAIMS as [string, ...string[]]) }).strict();

/** The hold as a caller sees it. `launchHeld` never changes here. */
function holdView(session: Session, result?: ProviderHoldReconciliation) {
  return {
    sessionId: session.id,
    launchHeld: session.providerDispatchHeld,
    holdKind: session.providerDispatchHoldKind ?? null,
    inputHeld: session.providerInputHeld,
    presence: session.providerPresence ?? null,
    lastReconciliation: result ?? session.providerHoldLastReconciliation ?? null,
    reconcile: { method: 'POST', path: providerHoldPath(session.id), observations: PROVIDER_HOLD_CLAIMS },
  };
}

export function registerProviderHoldRoutes(
  app: FastifyInstance,
  ctx: SessionPort & Partial<EventPort>,
  verifiedOwner: (req: FastifyRequest) => boolean
): void {
  const owner = (req: FastifyRequest) => req.headers['x-reverie-parent-session'] === undefined && verifiedOwner(req);
  const refuse = () =>
    createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the verified owner may read or settle a provider hold');

  app.get('/api/sessions/:id/provider-hold', async (req, reply) => {
    if (!owner(req)) return reply.code(403).send(refuse());
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    return { success: true, data: holdView(session) };
  });

  app.post('/api/sessions/:id/provider-hold', async (req, reply) => {
    if (!owner(req)) return reply.code(403).send(refuse());
    const id = (req.params as { id: string }).id;
    const session = findSessionOrFail(ctx, id, req);
    const claim = parseBody(Body, req.body).observation as (typeof PROVIDER_HOLD_CLAIMS)[number];
    const before = session.providerInputHeld;
    const result = await session.reconcileProviderHold(claim);
    // The answer is about the object that was asked: a replaced session gets a fresh request.
    if (ctx.sessions.get(id) !== session)
      return reply
        .code(409)
        .send(createErrorResponse(ApiErrorCode.CONFLICT, 'The session changed while its terminal was being checked'));
    const after = session.providerInputHeld;
    if (claim !== 'auto' || before !== after)
      console.log(
        `[provider-hold] session ${id.slice(0, 8)} ${claim === 'auto' ? 'terminal check' : `owner says ${claim}`}: ${result.outcome}` +
          `${result.outcome === 'held' ? ` (${result.reason})` : ''}; input ${after ? 'held' : 'admitted'}, launch fence unchanged`
      );
    if (before !== after)
      ctx.broadcast?.(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });
    return { success: true, data: { ...result, ...holdView(session, result) } };
  });
}
