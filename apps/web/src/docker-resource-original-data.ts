/** Closed original-resource DATA contracts. No current kernel identity or policy authority. */
import { z } from 'zod';
import { DockerResourceAttemptKey } from './docker-resource-attempt-key.js';

import type {
  DockerOriginalResourceWriterReceipt,
  DockerOriginalResourcePrestartReceipt,
} from './docker-resource-original-writer.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DockerOriginalWriterReceipt = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-original-memory-writer-closed-v1'),
    authority: z.literal('fresh-original-helper-terminal-v1'),
    originalKey: DockerResourceAttemptKey,
    taskDigest: digest,
    originalBoxId: digest,
    containerId: digest,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    configurationDigest: digest,
    terminalStateDigest: digest,
    exitCode: z.number().int().min(0).max(255),
    originalOutcome: z.literal('unknown'),
  })
  .strict() satisfies z.ZodType<DockerOriginalResourceWriterReceipt>;
export const DockerOriginalPrestartReceipt = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-original-memory-prestart-observation-v1'),
    authority: z.literal('canonical-retirement-cas-required-v1'),
    originalKey: DockerResourceAttemptKey,
    taskDigest: digest,
    observed: z.object({ containerId: digest, originalBoxId: digest, stateDigest: digest }).strict().nullable(),
    originalOutcome: z.literal('unknown'),
  })
  .strict() satisfies z.ZodType<DockerOriginalResourcePrestartReceipt>;
export const DockerResourceOriginalCursorDTO = DockerResourceAttemptKey.omit({ scopeDigest: true })
  .extend({
    cursorId: digest,
    expectedDigest: digest,
    helperContainerId: digest.nullable(),
    taskPhase: z.enum(['create-issued', 'created', 'start-issued', 'running', 'completed']),
    state: z.enum(['pending', 'closed', 'retired', 'acknowledged']),
    originalOutcome: z.enum(['unknown', 'acknowledged']),
    allowedActions: z.array(z.enum(['reconcile', 'retire'])).max(2),
    enforcement: z.literal('not-observed'),
  })
  .strict();
export type DockerResourceOriginalCursorDTO = z.infer<typeof DockerResourceOriginalCursorDTO>;
