/** Closed GPU request and observation data shared by the route and owner channel. */
import { z } from 'zod';

export const EmployeeGpuId = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const Device = z.string().regex(/^GPU-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Current = z
  .object({
    sessionId: EmployeeGpuId,
    sessionGeneration: Revision.refine((value) => value > 0),
    bindingDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const Expected = Current.extend({ revision: Revision.refine((value) => value < Number.MAX_SAFE_INTEGER) }).strict();
export const EmployeeGpuIntentData = z
  .object({ expected: Expected, enabled: z.boolean(), deviceUuid: Device.optional() })
  .strict()
  .refine((value) => (value.enabled ? value.deviceUuid !== undefined : value.deviceUuid === undefined));
export const EmployeeGpuStatus = z
  .object({
    version: z.literal(1),
    employeeId: EmployeeGpuId,
    current: Current,
    revision: Revision,
    choices: z
      .object({
        known: z.boolean(),
        devices: z.array(z.object({ deviceUuid: Device, model: z.string().min(1).max(128) }).strict()).max(64),
      })
      .strict(),
    requested: z
      .object({ enabled: z.boolean(), deviceUuid: Device.nullable(), revision: Revision })
      .strict()
      .nullable(),
    applied: z
      .object({
        known: z.boolean(),
        enabled: z.boolean().nullable(),
        deviceUuid: Device.nullable(),
        source: z.enum(['employee', 'legacy-session', 'none', 'unknown']),
      })
      .strict(),
    active: z
      .object({
        known: z.boolean(),
        running: z.boolean().nullable(),
        enabled: z.boolean().nullable(),
        deviceUuid: Device.nullable(),
      })
      .strict(),
    state: z.enum(['unchanged', 'pending', 'applied', 'reconciliation-required']),
  })
  .strict()
  .refine(
    (value) => new Set(value.choices.devices.map((device) => device.deviceUuid)).size === value.choices.devices.length
  );
export type EmployeeGpuStatusValue = z.infer<typeof EmployeeGpuStatus>;

export type EmployeeGpuIntent = z.infer<typeof EmployeeGpuIntentData>;
