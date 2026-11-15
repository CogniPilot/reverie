/** Canonical original resource-attempt correlation DATA; never effect authority. */
import { z } from 'zod';
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DockerResourceAttemptKey = z
  .object({
    revision: uuid,
    scopeDigest: digest,
    employeeId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    operationId: uuid,
    containerId: digest,
  })
  .strict();
export type DockerResourceAttemptKey = z.infer<typeof DockerResourceAttemptKey>;
