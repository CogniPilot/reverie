/** Exact native input encoding. Secret values exist only in the held caller and
 * stdin; material is correlation DATA, never a native success receipt. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DockerPlanSourceContext, dockerPlanContextForProvider } from './docker-plan-source-data.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
const uuid = z
    .string()
    .uuid()
    .regex(/^[0-9a-f-]{36}$/),
  hash = z.string().regex(/^[0-9a-f]{64}$/),
  provider = z.enum(['anthropic', 'openai']);
const identity = z
  .string()
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
const selection = z
  .object({
    operationId: uuid,
    sessionId: uuid,
    provider,
    accountId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    context: DockerPlanSourceContext,
  })
  .strict();
export function dockerPlanMaterial(input: z.infer<typeof selection>, authDigest: string) {
  const value = selection.parse(input);
  hash.parse(authDigest);
  dockerPlanContextForProvider(value.context, value.provider);
  const material = {
    version: 1 as const,
    purpose: 'reverie-plan-material-v1' as const,
    operationId: value.operationId,
    sessionId: value.sessionId,
    provider: value.provider,
    accountId: value.accountId,
    authDigest,
    context: value.context,
  };
  return Object.freeze({
    material,
    projectionDigest: dockerContinuationDigest(material),
    contextInputDigest: dockerContinuationDigest(value.context),
  });
}
export function dockerPlanPayload(input: z.infer<typeof selection>, containerId: string, auth: string, token: string) {
  const value = selection.parse(input);
  hash.parse(containerId);
  identity.parse(token);
  dockerPlanContextForProvider(value.context, value.provider);
  if (Buffer.byteLength(auth) > 128 * 1024 || !auth.length) throw Error('Private native plan payload unconfirmed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(auth);
  } catch {
    throw Error('Private native plan payload unconfirmed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Error('Private native plan payload unconfirmed');
  const payload = {
    version: 1,
    purpose: 'reverie-plan-install-v1',
    operationId: value.operationId,
    sessionId: value.sessionId,
    containerId,
    provider: value.provider,
    accountId: value.accountId,
    auth,
    identity: token,
    context: value.context,
  };
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error('Private native plan payload unconfirmed');
  return text;
}
export function dockerPlanAuthDigest(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
