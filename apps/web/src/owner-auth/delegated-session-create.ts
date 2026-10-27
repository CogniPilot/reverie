/** Private, one-use authority for a validated hire or approved plan migration. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { ownerFor } from '../web/route-helpers.js';

interface Grant {
  sessionId: string;
  owner: string | undefined;
  payload: unknown;
  targetSessionId?: string;
  authorized(): boolean;
  claimed?: FastifyRequest;
  consumed: boolean;
  closed: boolean;
}
const grants = new AsyncLocalStorage<Grant>();
export const hasDelegatedSessionCreate = (): boolean => !!grants.getStore();

/** Preserve the original actor only for the exact privately approved start.
 * General parent resolution still requires a live registry entry. */
export function delegatedSessionStartCaller(req: FastifyRequest): string | undefined {
  const grant = grants.getStore();
  if (!grant?.targetSessionId || grant.closed || grant.consumed || grant.claimed ||
      req.method !== 'POST' || req.url !== `/api/sessions/${encodeURIComponent(grant.targetSessionId)}/interactive` ||
      req.routeOptions.url !== '/api/sessions/:id/interactive' || ownerFor(req) !== grant.owner ||
      req.headers['x-reverie-parent-session'] !== grant.sessionId || !grant.authorized()) return undefined;
  return grant.sessionId;
}

/** Only the migration executor may start its exact freshly-created candidate. */
export function withDelegatedSessionStart<T>(
  input: Pick<Grant, 'sessionId' | 'owner' | 'authorized'> & { targetSessionId: string },
  start: () => Promise<T>
): Promise<T> {
  return withDelegatedSessionCreate({ ...input, payload: undefined }, start);
}

/** Not an HTTP capability: only a validated hire or migration callback creates this scope. */
export async function withDelegatedSessionCreate<T>(
  input: Pick<Grant, 'sessionId' | 'owner' | 'payload' | 'authorized' | 'targetSessionId'>,
  create: () => Promise<T>
): Promise<T> {
  const grant: Grant = { ...input, payload: structuredClone(input.payload), consumed: false, closed: false };
  return grants.run(grant, async () => {
    try { return await create(); }
    finally { grant.closed = true; }
  });
}

/** Claim before parsing; one request only, even when two injections overlap. */
export function claimDelegatedSessionCreate(req: FastifyRequest, caller: string | undefined): boolean {
  const grant = grants.getStore();
  const url = grant?.targetSessionId ? `/api/sessions/${encodeURIComponent(grant.targetSessionId)}/interactive` : '/api/sessions';
  const route = grant?.targetSessionId ? '/api/sessions/:id/interactive' : '/api/sessions';
  if (!grant || grant.closed || grant.consumed || grant.claimed || req.method !== 'POST' || req.url !== url || req.routeOptions.url !== route) return false;
  if (caller !== grant.sessionId || ownerFor(req) !== grant.owner || req.headers['x-reverie-parent-session'] !== grant.sessionId || !grant.authorized()) return false;
  grant.claimed = req;
  return true;
}

/** Check the parsed payload and fresh authorization before the session handler runs. */
export function consumeDelegatedSessionCreate(req: FastifyRequest): boolean | undefined {
  const grant = grants.getStore();
  if (!grant) return undefined;
  if (grant.claimed !== req) return req.method === 'POST' &&
    (req.url === '/api/sessions' || (!!grant.targetSessionId && req.url === `/api/sessions/${encodeURIComponent(grant.targetSessionId)}/interactive`))
    ? false : undefined;
  if (grant.closed || grant.consumed) return false;
  grant.consumed = true;
  return ownerFor(req) === grant.owner && req.headers['x-reverie-parent-session'] === grant.sessionId &&
    isDeepStrictEqual(req.body, grant.payload) && grant.authorized();
}
