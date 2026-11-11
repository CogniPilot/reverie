/** Private revocable fence for an already-authorized creation. This never supplies HTTP authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { ownerFor } from '../web/route-helpers.js';

interface CreationFence {
  owner: string | undefined;
  payload: unknown;
  authorized(): boolean;
  claimed?: FastifyRequest;
  closed: boolean;
}
const fences = new AsyncLocalStorage<CreationFence>();

/** The ordinary owner/delegate authentication still runs on the nested request. */
export async function withSessionCreateAdmission<T>(
  input: Pick<CreationFence, 'owner' | 'payload' | 'authorized'>,
  create: () => Promise<T>
): Promise<T> {
  const fence: CreationFence = { ...input, payload: structuredClone(input.payload), closed: false };
  return fences.run(fence, async () => {
    try {
      if (!fence.authorized()) throw new Error('Session creation admission was revoked before dispatch');
      return await create();
    } finally {
      fence.closed = true;
    }
  });
}

/** One exact request only; no header, body field, role or captured callback can recreate the fence. */
export function sessionCreateAdmission(req: FastifyRequest): (() => boolean) | undefined {
  const fence = fences.getStore();
  if (!fence) return undefined;
  const matches = () =>
    req.method === 'POST' &&
    req.url === '/api/sessions' &&
    req.routeOptions.url === '/api/sessions' &&
    ownerFor(req) === fence.owner &&
    isDeepStrictEqual(req.body, fence.payload);
  if (!fence.closed && !fence.claimed && matches()) fence.claimed = req;
  return () => !fence.closed && fence.claimed === req && matches() && fence.authorized();
}
