/** Current own-grant metadata only. No credential material, local paths or network probes. */
import { z } from 'zod';
import type { PublicationTokenMetadata } from './publication-credentials.js';

const id = z.string().uuid();
const name = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const unavailableExpiry = z.object({ state: z.literal('unknown'), reason: z.literal('not-recorded') }).strict();
const access = z.object({ state: z.literal('not-verified'), basis: z.literal('owner-declared-labels') }).strict();
const common = { id, expiry: unavailableExpiry, repositoryAccess: access };
const credential = z.discriminatedUnion('registration', [
  z
    .object({
      ...common,
      registration: z.literal('registered'),
      grant: z.literal('current'),
      name,
      repositories: z.array(repository).max(50),
    })
    .strict(),
  z
    .object({
      ...common,
      registration: z.literal('missing'),
      grant: z.literal('unavailable'),
      repositories: z.array(repository).length(0),
    })
    .strict(),
]);

export const OwnCredentialStatusSchema = z
  .object({
    version: z.literal(1),
    employeeId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    visibility: z.literal('current-employee-grants-only'),
    registrationAuthority: z.literal('owner-only'),
    credentials: z.array(credential).max(64),
  })
  .strict()
  .refine((value) => new Set(value.credentials.map((entry) => entry.id)).size === value.credentials.length);
export type OwnCredentialStatus = z.infer<typeof OwnCredentialStatusSchema>;

/** Missing names elsewhere are deliberately not enumerated or inferred from an empty own grant set. */
export function ownCredentialStatus(
  actor: { employeeId: string; sessionId: string; ids: readonly string[] },
  metadata: readonly PublicationTokenMetadata[]
): OwnCredentialStatus {
  if (actor.ids.length > 64 || new Set(actor.ids).size !== actor.ids.length) throw Error('Invalid own grants');
  const credentials = actor.ids.map((grantedId) => {
    const matches = metadata.filter((entry) => entry.id === grantedId);
    if (matches.length > 1) throw Error('Ambiguous own registration');
    const entry = matches[0];
    const facts = {
      id: grantedId,
      expiry: { state: 'unknown' as const, reason: 'not-recorded' as const },
      repositoryAccess: { state: 'not-verified' as const, basis: 'owner-declared-labels' as const },
    };
    // Do not copy free-form labels, timestamps, extra provider fields or material into this report.
    return entry
      ? {
          ...facts,
          registration: 'registered' as const,
          grant: 'current' as const,
          name: entry.name,
          repositories: [...entry.repositories],
        }
      : { ...facts, registration: 'missing' as const, grant: 'unavailable' as const, repositories: [] };
  });
  return OwnCredentialStatusSchema.parse({
    version: 1,
    employeeId: actor.employeeId,
    sessionId: actor.sessionId,
    visibility: 'current-employee-grants-only',
    registrationAuthority: 'owner-only',
    credentials,
  });
}
