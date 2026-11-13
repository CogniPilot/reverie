import type { FastifyRequest } from 'fastify';

export const INPUT_PROTOCOL = '2';
export const INPUT_PROTOCOL_HEADER = 'x-reverie-input-protocol';
export const INPUT_PROTOCOL_QUERY = 'inputProtocol';
export const INPUT_RELOAD_MESSAGE =
  'This browser needs an input protocol update. Reload Reverie; saved or unconfirmed input must not be replayed automatically.';

/** Compatibility fence only, never authentication or proof of journal durability.
 * Headless clients retain their existing API contract. Fetch metadata/Origin
 * identify browser transport here, not a principal or an agent permission.
 */
export function browserInputNeedsReload(req: Pick<FastifyRequest, 'headers'>, marker: unknown): boolean {
  const headers = req.headers;
  // Node's ordinary fetch adds Sec-Fetch-Mode too. Origin/Site are the
  // browser compatibility heuristic; this classification grants no authority.
  const browser = headers.origin !== undefined || headers['sec-fetch-site'] !== undefined;
  return browser && marker !== INPUT_PROTOCOL;
}
