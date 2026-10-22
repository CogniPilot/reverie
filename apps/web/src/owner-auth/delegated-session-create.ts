/** Private, one-use authority for a validated template hire's in-process request. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { ownerFor } from '../web/route-helpers.js';

interface Grant {
  sessionId: string;
  owner: string | undefined;
  payload: unknown;
  authorized(): boolean;
  claimed?: FastifyRequest;
  consumed: boolean;
  closed: boolean;
}
const grants = new AsyncLocalStorage<Grant>();
export const hasDelegatedSessionCreate = (): boolean => !!grants.getStore();

/** Not an HTTP capability: only the validated hire callback creates this scope. */
export async function withDelegatedSessionCreate<T>(
  input: Pick<Grant, 'sessionId' | 'owner' | 'payload' | 'authorized'>,
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
  if (!grant || grant.closed || grant.consumed || grant.claimed || req.method !== 'POST' || req.url !== '/api/sessions' || req.routeOptions.url !== '/api/sessions') return false;
  if (caller !== grant.sessionId || ownerFor(req) !== grant.owner || req.headers['x-reverie-parent-session'] !== grant.sessionId || !grant.authorized()) return false;
  grant.claimed = req;
  return true;
}

/** Check the parsed payload and fresh authorization before the session handler runs. */
export function consumeDelegatedSessionCreate(req: FastifyRequest): boolean | undefined {
  const grant = grants.getStore();
  if (!grant) return undefined;
  if (grant.claimed !== req) return req.method === 'POST' && req.url === '/api/sessions' ? false : undefined;
  if (grant.closed || grant.consumed) return false;
  grant.consumed = true;
  return ownerFor(req) === grant.owner && req.headers['x-reverie-parent-session'] === grant.sessionId &&
    isDeepStrictEqual(req.body, grant.payload) && grant.authorized();
}
