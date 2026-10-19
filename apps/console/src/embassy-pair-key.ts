/**
 * Two-scan pairing payloads (pairing contract r2 §2, §3), as the console reads and writes them. Both are QR text of
 * at most 512 bytes whose origin passes the same canonical https rule as a v1 invite key:
 * - QR1, the pair invite: `embassy-v2|<origin>|<roomId>|<43-char token>`; the token is a one-time secret.
 * - The request QR: `embassy-pair-v1|<origin>|<requestId>|<code>`; a public locator, never a credential.
 */
import { EMBASSY_GUEST_KEY_MAX, parseEmbassyGuestKey } from './embassy-guest-client.js';

/** A pairing refusal with the contract's exact HTTP status and code (r2 §6); the message never holds a secret. */
export class EmbassyPairError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROOM = /^[A-Za-z0-9_-]{1,80}$/;

const bad = () => new EmbassyPairError(400, 'PAIR_BAD_QR', 'Not an embassy pairing code');

function fields(value: unknown, prefix: string): [string, string, string] {
  if (typeof value !== 'string') throw bad();
  value = value.trim();
  if (typeof value !== 'string' || Buffer.byteLength(value) > EMBASSY_GUEST_KEY_MAX) throw bad();
  const parts = value.split('|');
  if (parts.length !== 4 || parts[0] !== prefix) throw bad();
  let origin: string;
  try {
    origin = parseEmbassyGuestKey(`embassy-v1|${parts[1]}|${'A'.repeat(43)}`).origin;
  } catch {
    throw bad();
  }
  if (origin !== parts[1]) throw bad();
  return [parts[1], parts[2], parts[3]];
}

export function parsePairInvite(value: unknown): { origin: string; roomId: string; token: string } {
  const [origin, roomId, token] = fields(value, 'embassy-v2');
  if (!ROOM.test(roomId) || !TOKEN.test(token)) throw bad();
  return { origin, roomId, token };
}

/** Accepts the code as shown (`XXXX-XXXX`, any case) and returns the canonical 8 characters. */
export function normalizePairCode(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16) throw bad();
  const code = value.toUpperCase().replace(/[-\s]/g, '');
  if (!CODE.test(code)) throw bad();
  return code;
}
export function formatPairCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function parsePairRequest(value: unknown): { origin: string; requestId: string; code: string } {
  const [origin, requestId, code] = fields(value, 'embassy-pair-v1');
  if (!UUID.test(requestId) || !CODE.test(code)) throw bad();
  return { origin, requestId, code };
}
export function encodePairRequest(origin: string, requestId: string, code: string): string {
  const value = `embassy-pair-v1|${origin}|${requestId}|${normalizePairCode(code)}`;
  parsePairRequest(value);
  return value;
}
