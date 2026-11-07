/** Per-use API policy data over the actual fixed-session Office connection.
 * A response is not native ownership/completion proof. No issuer key is here.
 */
import { z } from 'zod';
import { httpRequest, type AgentContext, type ApiRequest } from './cli-agent.js';
import { MemoryServiceReferenceSchema, type InstalledMemoryScope } from './installed-memory-context.js';
import { MemorySelectorSchema } from './memory-scope-identifiers.js';
const grantRef = z
  .object({ grantId: MemoryServiceReferenceSchema, policyGeneration: z.string().regex(/^sha256:[0-9a-f]{64}$/) })
  .strict();
const response = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        instanceRef: MemoryServiceReferenceSchema,
        instanceId: z.string(),
        resourceId: MemoryServiceReferenceSchema,
        scope: MemorySelectorSchema,
        grantRef,
      })
      .strict(),
  })
  .strict();
export type MemoryPolicyReference = z.infer<typeof grantRef>;
export type InstalledMemoryAccess = (
  project: string | undefined,
  expected?: MemoryPolicyReference,
  signal?: AbortSignal
) => Promise<MemoryPolicyReference>;

export function installedMemoryAccess(
  context: InstalledMemoryScope,
  actor: AgentContext,
  request: ApiRequest = httpRequest
): InstalledMemoryAccess {
  return async (project, expected, signal) => {
    const resource = context.resources.find((row) =>
      project === undefined
        ? row.scope.kind === 'private'
        : row.scope.kind === 'project' && row.scope.project === project
    );
    if (!resource) throw new Error('Memory scope is not configured for this installation');
    const reply = await request(actor, {
      method: 'POST',
      path: '/api/agent/memory-scope',
      body: {
        instanceRef: context.instanceRef,
        resourceId: resource.resourceId,
        binding: context.employee,
        ...(expected ? { expectedGrantRef: expected } : {}),
      },
      signal,
      bounds: { maxBytes: 16 * 1024, deadlineMs: 20_000 },
    });
    const parsed = response.safeParse(reply.json);
    if (reply.status !== 200 || !parsed.success)
      throw new Error('Memory scope unavailable; check the current session and owner grant');
    const checked = parsed.data.data;
    const sameScope =
      checked.scope.kind === resource.scope.kind &&
      (checked.scope.kind === 'private' ||
        (resource.scope.kind === 'project' && checked.scope.project === resource.scope.project));
    if (
      checked.instanceRef !== context.instanceRef ||
      checked.instanceId !== context.instanceId ||
      checked.resourceId !== resource.resourceId ||
      !sameScope ||
      (expected &&
        (expected.grantId !== checked.grantRef.grantId ||
          expected.policyGeneration !== checked.grantRef.policyGeneration))
    )
      throw new Error('Memory scope policy changed; no memory result is released');
    return Object.freeze(checked.grantRef);
  };
}
