/** Closed fixed-launcher metadata, never a grant, filesystem selector or key. */
import { z } from 'zod';
import { ServiceGrantSchema } from './company-types.js';
import { MemoryInstanceIdSchema, MemorySelectorSchema } from './memory-scope-identifiers.js';

export const MemoryServiceReferenceSchema = ServiceGrantSchema.shape.resources.unwrap().element;
export const MemoryContextBindingSchema = ServiceGrantSchema.shape.employees
  .unwrap()
  .element.extend({
    ownerCodepoints: z.array(z.number().int().min(0).max(0x10ffff)).nullable(),
  })
  .strict();
export const InstalledMemoryScopeSchema = z
  .object({
    instanceRef: MemoryServiceReferenceSchema,
    instanceId: MemoryInstanceIdSchema,
    employee: MemoryContextBindingSchema,
    resources: z
      .array(z.object({ resourceId: MemoryServiceReferenceSchema, scope: MemorySelectorSchema }).strict())
      .min(1)
      .max(256),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((context, ctx) => {
    const keys = context.resources.map((row) =>
      row.scope.kind === 'private' ? 'private' : `project:${row.scope.project}`
    );
    if (
      new Set(keys).size !== keys.length ||
      new Set(context.resources.map((row) => row.resourceId)).size !== keys.length
    )
      ctx.addIssue({ code: 'custom', message: 'Ambiguous installed memory scope' });
  });
export type InstalledMemoryScope = z.infer<typeof InstalledMemoryScopeSchema>;
export const InstalledMemorySummarySchema = z
  .object({
    schema: z.literal('reverie-installed-memory-summary-v1'),
    installed: z.boolean(),
    officeApiUrl: z.string().url(),
    data: InstalledMemoryScopeSchema.optional(),
  })
  .strict()
  .refine((summary) => summary.installed === (summary.data !== undefined), 'Partial installed memory summary');
