/** Existing portable memory selector grammar, shared by its wire boundaries. */
import { z } from 'zod';
export const MemoryProjectSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const MemoryInstanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const MemorySelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('private') }).strict(),
  z.object({ kind: z.literal('project'), project: MemoryProjectSchema }).strict(),
]);
