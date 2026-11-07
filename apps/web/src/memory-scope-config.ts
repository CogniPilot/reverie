/** Installer-selected resource DATA for the existing owner-issued service-grant
 * owner. Guest config paths remain in this trusted bootstrap, never API replies
 * or request-side selectors. No executable, key or permission lives here.
 */
import { z } from 'zod';
import { ServiceGrantSchema, type ServiceGrant } from './company-types.js';
import { MemoryInstanceIdSchema, MemorySelectorSchema } from './memory-scope-identifiers.js';

export const MEMORY_READ_PURPOSE = 'MEMORY_READ';
const reference = ServiceGrantSchema.shape.resources.unwrap().element;
export const MemoryScopeConfigSchema = z
  .object({
    principal: reference.refine((value) => value.length <= 56, 'Service principal is too long'),
    instances: z
      .array(
        z
          .object({
            instanceRef: reference,
            instanceId: MemoryInstanceIdSchema,
            guestConfigPathCodepoints: z
              .array(z.number().int().min(0).max(0x10ffff))
              .max(65536)
              .refine(
                (points) => points[0] === 47 && !points.includes(0),
                'Select an absolute guest configuration path'
              )
              .optional(),
            resources: z
              .array(z.object({ resourceId: reference, scope: MemorySelectorSchema }).strict())
              .min(1)
              .max(256),
          })
          .strict()
      )
      .min(1)
      .max(256),
  })
  .strict()
  .superRefine((config, ctx) => {
    const resources = config.instances.flatMap((instance) => instance.resources);
    if (resources.length > 256 || new Set(resources.map((row) => row.resourceId)).size !== resources.length)
      ctx.addIssue({ code: 'custom', message: 'Configure at most 256 unique memory resources' });
    if (new Set(config.instances.map((row) => row.instanceRef)).size !== config.instances.length)
      ctx.addIssue({ code: 'custom', message: 'Configure each memory instance reference once' });
    for (const instance of config.instances) {
      const keys = instance.resources.map((row) =>
        row.scope.kind === 'private' ? 'private' : `project:${row.scope.project}`
      );
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: 'custom', message: 'Configure each instance memory scope once' });
    }
  });
export type MemoryScopeConfiguration = z.infer<typeof MemoryScopeConfigSchema>;
export type ConfiguredMemoryResource = Readonly<{
  instanceRef: string;
  instanceId: string;
  resourceId: string;
  scope: Readonly<z.infer<typeof MemorySelectorSchema>>;
}>;
export type MemoryInstallationData = Readonly<{
  instanceRef: string;
  instanceId: string;
  guestConfigPathCodepoints: readonly number[];
  resources: readonly ConfiguredMemoryResource[];
}>;

/** An immutable deployment catalog, never an authority or a persistent store. */
export class MemoryScopeCatalog {
  private readonly resources: ReadonlyMap<string, ConfiguredMemoryResource>;
  private readonly installations: ReadonlyMap<string, MemoryInstallationData>;
  private constructor(
    readonly principal: string,
    readonly epoch: string,
    rows: ConfiguredMemoryResource[],
    installations: MemoryInstallationData[]
  ) {
    this.resources = new Map(rows.map((row) => [row.resourceId, row]));
    this.installations = new Map(installations.map((row) => [row.instanceRef, row]));
  }
  static configured(
    config: MemoryScopeConfiguration,
    issuer: { principal: string; epoch: string }
  ): MemoryScopeCatalog {
    const parsed = MemoryScopeConfigSchema.parse(config);
    if (parsed.principal !== issuer.principal) throw new Error('Memory publisher principal is not configured');
    const rows = parsed.instances.flatMap((instance) =>
      instance.resources.map((row) =>
        Object.freeze({
          instanceRef: instance.instanceRef,
          instanceId: instance.instanceId,
          resourceId: row.resourceId,
          scope: Object.freeze({ ...row.scope }),
        })
      )
    );
    const installations = parsed.instances.flatMap((instance) =>
      instance.guestConfigPathCodepoints === undefined
        ? []
        : [
            Object.freeze({
              instanceRef: instance.instanceRef,
              instanceId: instance.instanceId,
              guestConfigPathCodepoints: Object.freeze([...instance.guestConfigPathCodepoints]),
              resources: Object.freeze(rows.filter((row) => row.instanceRef === instance.instanceRef)),
            }),
          ]
    );
    return new MemoryScopeCatalog(issuer.principal, issuer.epoch, rows, installations);
  }
  resource(id: string): ConfiguredMemoryResource | undefined {
    return this.resources.get(id);
  }
  /** Trusted launch/bootstrap DATA only; the API never returns these paths.
   * A real lifecycle publisher must mount the closed context readonly before
   * adoption. Absence stays disabled; no default path/ID inference is allowed.
   */
  installation(instanceRef: string): MemoryInstallationData | undefined {
    return this.installations.get(instanceRef);
  }
  /** Reject Cartesian ambiguity, unknown resources and stale publisher epochs.
   * Passing this validation issues no authority: the canonical owner transaction
   * and the existing service assertion/current checks remain mandatory.
   */
  acceptsGrant(
    input: Pick<ServiceGrant, 'principal' | 'epoch' | 'resources'> & { employeeIds: readonly string[] }
  ): boolean {
    if (
      input.principal !== this.principal ||
      input.epoch !== this.epoch ||
      input.employeeIds.length !== 1 ||
      !input.resources.length
    )
      return false;
    const selected = input.resources.map((id) => this.resource(id));
    return (
      selected.every((row) => row !== undefined && this.installation(row.instanceRef) !== undefined) &&
      new Set(selected.map((row) => row?.instanceRef)).size === 1
    );
  }
}
