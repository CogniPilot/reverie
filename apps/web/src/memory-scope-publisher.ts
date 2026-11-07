/** The real canonical service-grant owner authorizes each installed read.
 * Context files, executable origin and response data never mint a native permit.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ServiceGrantSchema, type ServiceGrant } from './company-types.js';
import { MEMORY_READ_PURPOSE, type ConfiguredMemoryResource } from './memory-scope-config.js';
import { SERVICE_ASSERTION_MAX_LIFETIME_MS, signServiceAssertion } from './service-grant-auth.js';
import type { ServiceAuthorization } from './service-authorization.js';
import type { currentEmployeeCaller } from './web/employee-caller.js';
import { MemoryContextBindingSchema } from './installed-memory-context.js';

const reference = ServiceGrantSchema.shape.resources.unwrap().element;
export const MemoryScopeRequestSchema = z
  .object({
    instanceRef: reference,
    resourceId: reference,
    binding: MemoryContextBindingSchema,
    expectedGrantRef: z
      .object({ grantId: reference, policyGeneration: z.string().regex(/^sha256:[0-9a-f]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();
type Request = z.infer<typeof MemoryScopeRequestSchema>;
type Caller = NonNullable<ReturnType<typeof currentEmployeeCaller>>;
export interface MemoryScopeCheck {
  readonly instanceRef: string;
  readonly instanceId: string;
  readonly resourceId: string;
  readonly scope: ConfiguredMemoryResource['scope'];
  readonly grantRef: { readonly grantId: string; readonly policyGeneration: string };
}
function ownerText(points: number[] | null): string | undefined {
  if (points === null) return undefined;
  // Bounded by the route body; avoid an argument-count limit on accepted text.
  return points.map((point) => String.fromCodePoint(point)).join('');
}

/** Compare observed facts to the detached parsed request, never to a mutable
 * employee reference retained across an await. This predicate grants nothing. */
export function matchesMemoryCallerBinding(caller: Caller | undefined, binding: Request['binding']): boolean {
  return (
    caller !== undefined &&
    binding.employeeId === caller.employee.id &&
    binding.sessionId === caller.sessionId &&
    binding.sessionGeneration === caller.employee.sessionGeneration &&
    ownerText(binding.ownerCodepoints) === caller.owner
  );
}

export class MemoryScopePublisher {
  constructor(private readonly authority: ServiceAuthorization) {}

  async check(caller: Caller, input: Request): Promise<MemoryScopeCheck | undefined> {
    const a = this.authority,
      catalog = a.loaded.memoryScopes;
    if (!catalog || !matchesMemoryCallerBinding(caller, input.binding)) return undefined;
    const employeeId = input.binding.employeeId,
      owner = ownerText(input.binding.ownerCodepoints);
    const resource = catalog.resource(input.resourceId);
    if (!resource || resource.instanceRef !== input.instanceRef) return undefined;
    const eligible = this.eligible(input);
    // Never select the first grant from an ambiguous owner configuration.
    if (eligible.length !== 1) return undefined;
    const grant = eligible[0]!;
    if (input.expectedGrantRef && input.expectedGrantRef.grantId !== grant.id) return undefined;
    const issuer = a.issuer(catalog.principal);
    if (!issuer || issuer.epoch !== catalog.epoch) return undefined;
    const now = a.now();
    const assertion = signServiceAssertion(issuer.key, {
      purpose: MEMORY_READ_PURPOSE,
      principal: catalog.principal,
      epoch: catalog.epoch,
      ownerId: grant.owner ?? '',
      grantId: grant.id,
      issuedAt: now,
      expiresAt: Math.min(grant.expiresAt, now + SERVICE_ASSERTION_MAX_LIFETIME_MS),
      nonce: randomBytes(16).toString('hex'),
    });
    const lease = await a.auth.authenticate({ assertion }, MEMORY_READ_PURPOSE);
    if (
      !lease ||
      lease.ownerId !== (owner ?? '') ||
      !lease.currentFor(employeeId, resource.resourceId) ||
      (input.expectedGrantRef && input.expectedGrantRef.policyGeneration !== lease.generation)
    )
      return undefined;
    const fresh = this.eligible(input);
    if (fresh.length !== 1 || fresh[0]!.id !== grant.id || !lease.currentFor(employeeId, resource.resourceId))
      return undefined;
    return Object.freeze({
      instanceRef: resource.instanceRef,
      instanceId: resource.instanceId,
      resourceId: resource.resourceId,
      scope: resource.scope,
      grantRef: Object.freeze({ grantId: lease.grantId, policyGeneration: lease.generation }),
    });
  }
  private eligible(input: Request): readonly ServiceGrant[] {
    const a = this.authority,
      catalog = a.loaded.memoryScopes;
    if (!catalog) return [];
    const now = a.now(),
      owner = ownerText(input.binding.ownerCodepoints);
    return a.source
      .grantsFor(MEMORY_READ_PURPOSE)
      .filter(
        (grant) =>
          grant.owner === owner &&
          grant.issuedAt <= now &&
          now < grant.expiresAt &&
          grant.resources.includes(input.resourceId) &&
          a.source.revoked(grant.id) === false &&
          grant.employees[0]?.employeeId === input.binding.employeeId &&
          catalog.acceptsGrant({ ...grant, employeeIds: grant.employees.map((row) => row.employeeId) })
      );
  }
}
