import { createHash, createHmac } from 'node:crypto';
import { isBrokerGoalRequest } from '../../src/goal-broker-auth.js';

// These bytes are used only by the synthetic broker verifier tests.
export const syntheticGoalKey = Buffer.from('not-a-deployment-key-synthetic-01!');
export const syntheticGoalSession = '11111111-2222-3333-4444-555555555555';
const now = 100_000;

export function syntheticGoalAssertion(body: string | Buffer, overrides: Record<number, unknown> = {}): string {
  const fields: unknown[] = [
    1,
    'goal-request',
    'test-broker',
    'test-epoch',
    syntheticGoalSession,
    7,
    'POST',
    '/api/goals',
    createHash('sha256').update(body).digest('hex'),
    now,
    now + 10_000,
    'a'.repeat(32),
  ];
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
  const signature = createHmac('sha256', syntheticGoalKey).update('reverie-goal-request-v1\n' + encoded).digest('hex');
  return encoded + '.' + signature;
}

export function syntheticGoalForward<Method extends string>({
  method,
  target = '/api/goals',
  body = '{}',
  sessionId = syntheticGoalSession,
  generation = 7,
  nonce = 'a'.repeat(32),
  headers = {},
}: {
  method: Method;
  target?: string;
  body?: string;
  sessionId?: string;
  generation?: number;
  nonce?: string;
  headers?: Record<string, string>;
}) {
  const sanitized: Record<string, string> = Object.fromEntries(
    Object.entries(headers).filter(([header]) => {
      const lower = header.toLowerCase();
      return (
        !lower.startsWith('x-reverie-goal-') &&
        !['cookie', 'authorization', 'content-type', 'x-reverie-parent-session', 'x-reverie-service-token'].includes(lower)
      );
    })
  );
  sanitized['X-Reverie-Parent-Session'] = sessionId;
  sanitized.Authorization = 'Basic c3ludGhldGlj';
  sanitized['Content-Type'] = 'application/json';
  const forwarded = { method, target, body, headers: sanitized };
  if (!/^\/api\/(goals|goal-grants|goal-unblock-proofs|goal-metadata)(?:[/?]|$)/.test(target)) return forwarded;
  if (!isBrokerGoalRequest(method, target) || Buffer.byteLength(body) > 65_536 || (method === 'GET' && body))
    return { ...forwarded, refused: 403 };
  sanitized['X-Reverie-Goal-Assertion'] = syntheticGoalAssertion(body, {
    4: sessionId,
    5: generation,
    6: method,
    7: target,
    11: nonce,
  });
  return forwarded;
}
