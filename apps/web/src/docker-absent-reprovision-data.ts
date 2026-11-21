/** Canonical DATA for reprovisioning a laptop whose recorded Docker containers
 * are absent. A retirement entry is history and a resumable cursor for one
 * replacement source. It never grants Engine, launch or provider authority. */
import { z } from 'zod';
import { DockerEmployeeBinding, DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hostPath = z
  .string()
  .min(2)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(value) &&
      !value.split('/').some((part) => part === '..' || part === '.'),
    'Absolute normalized host path required'
  );
/** Closed operator read-only set of the legacy worker rules. */
export const REPROVISION_READ_ONLY_TARGETS = [
  '/host-published',
  '/instances/default/tools',
  '/instances/default/console/statusline-exporter.sh',
  '/run/reverie-model',
] as const;
const DRIVE_TARGETS = ['/workspace', '/reverie_workspace', '/projects'];
const PROJECT_TARGET = /^\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Private storage, capsule, kernel and Engine targets are never template data. */
const PROTECTED_TARGETS = [
  '/home/agent',
  '/nix',
  '/tmp',
  '/scratch',
  '/proc',
  '/opt/reverie-worker-tools',
  '/opt/reverie-worker-client',
  '/run/reverie-engine',
  '/run/reverie-office',
  '/var/run/docker.sock',
  '/run/docker.sock',
];
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
const templateMount = z
  .object({ source: hostPath, destination: hostPath, readOnly: z.boolean() })
  .strict()
  .superRefine((mount, context) => {
    const target = mount.destination;
    if (target.startsWith('/opt/reverie-worker-') || PROTECTED_TARGETS.some((value) => overlaps(target, value)))
      context.addIssue({ code: 'custom', message: 'Protected laptop mount target' });
    const readOnly = (REPROVISION_READ_ONLY_TARGETS as readonly string[]).includes(target);
    if (readOnly && !mount.readOnly) context.addIssue({ code: 'custom', message: 'Operator mount must be read-only' });
    if (!readOnly && !DRIVE_TARGETS.includes(target) && !PROJECT_TARGET.test(target))
      context.addIssue({ code: 'custom', message: 'Unsupported laptop mount target' });
  });
/** Owner-approved shared-drive layout. Identity-bearing HOME/Nix storage is
 * derived by the backend from its own retired record, never from this DATA. */
export const DockerLaptopTemplate = z
  .object({
    user: z
      .string()
      .regex(/^[1-9][0-9]{0,9}:[0-9]{1,10}$/)
      .refine((value) => value.split(':').every((part) => Number(part) <= 4294967294)),
    scratchRoot: hostPath,
    mounts: z.array(templateMount).max(32),
    workspaceAlias: z.boolean().optional(),
    /** Selects one of the employee's observed per-worker office API networks. */
    network: z
      .string()
      .regex(/^reverie-boxed-api-[a-z0-9-]{1,64}$/)
      .optional(),
  })
  .strict()
  .superRefine((template, context) => {
    const targets = template.mounts.map((mount) => mount.destination);
    if (targets.some((target, index) => targets.some((other, at) => at !== index && overlaps(target, other))))
      context.addIssue({ code: 'custom', message: 'Laptop mount targets must be disjoint' });
    if (template.workspaceAlias && (targets.includes('/workspace') || !targets.includes('/reverie_workspace')))
      context.addIssue({ code: 'custom', message: 'The workspace alias requires one /reverie_workspace drive' });
  });
export type DockerLaptopTemplate = z.infer<typeof DockerLaptopTemplate>;
export const DockerAbsentReprovisionRequest = z
  .object({
    operationId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    expectedScopeDigest: digest,
    template: DockerLaptopTemplate,
  })
  .strict();
export type DockerAbsentReprovisionRequest = z.infer<typeof DockerAbsentReprovisionRequest>;
const sourceIntent = {
  name: z.string().regex(/^reverie-boxed-source-[a-f0-9]{64}$/),
  imageId: image,
  network: z.object({ name: z.string().regex(/^reverie-boxed-api-[a-z0-9-]{1,64}$/), id: digest }).strict(),
  configurationDigest: digest,
};
/** Intent is recorded before CREATE and the actual ID after it. An issued
 * cursor is only ever settled by observing its deterministic name and labels. */
export const DockerReprovisionSourceCursor = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('pending') }).strict(),
  z.object({ phase: z.literal('issued'), ...sourceIntent }).strict(),
  z.object({ phase: z.literal('created'), ...sourceIntent, containerId: digest }).strict(),
]);
export type DockerReprovisionSourceCursor = z.infer<typeof DockerReprovisionSourceCursor>;
export const DockerAbsentContinuationRetirement = z
  .object({
    version: z.literal(1),
    purpose: z.literal('docker-absent-continuation-retirement-v1'),
    retiredAt: z.number().int().nonnegative().safe(),
    operationId: uuid,
    reason: z.literal('recorded-containers-absent'),
    employeeId: uuid,
    owner: z.string().max(200).optional(),
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    scopeDigest: digest,
    templateDigest: digest,
    template: DockerLaptopTemplate,
    absent: z
      .object({
        containerIds: z
          .array(digest)
          .min(1)
          .max(8)
          .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id)),
        /** Active native plan moves closed as abandoned by this operation. */
        planMoveIds: z.array(z.string().min(1).max(100)).max(8),
      })
      .strict(),
    /** The removed continuation row and published binding, verbatim. */
    record: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding.nullable(),
    /** Stale saved boxed view reference removed through the state service. */
    session: z.object({ phase: z.enum(['pending', 'cleared']), containerName: digest.nullable() }).strict(),
    source: DockerReprovisionSourceCursor,
  })
  .strict()
  .refine(
    (entry) =>
      entry.record.employeeId === entry.employeeId &&
      entry.record.owner === entry.owner &&
      entry.record.request.sessionId === entry.sessionId &&
      entry.record.request.sessionGeneration === entry.sessionGeneration &&
      entry.record.request.operationId !== entry.operationId &&
      (!entry.binding || entry.binding.sessionId === entry.sessionId) &&
      (entry.source.phase === 'pending' || entry.session.phase === 'cleared'),
    'Retirement must bind its original employee, session and record'
  );
export type DockerAbsentContinuationRetirement = z.infer<typeof DockerAbsentContinuationRetirement>;
/** Append-only: entries are never removed; only their own cursors advance. */
export const DockerAbsentContinuationRetirements = z
  .array(DockerAbsentContinuationRetirement)
  .max(256)
  .refine((rows) => new Set(rows.map((row) => row.operationId)).size === rows.length);
export function allowedReprovisionTransition(
  before: DockerAbsentContinuationRetirement,
  next: DockerAbsentContinuationRetirement
): boolean {
  const fixed = (entry: DockerAbsentContinuationRetirement) =>
    JSON.stringify({ ...entry, session: undefined, source: undefined });
  if (fixed(before) !== fixed(next) || before.session.containerName !== next.session.containerName) return false;
  const session =
    before.session.phase === next.session.phase ||
    (before.session.phase === 'pending' && next.session.phase === 'cleared');
  const order = { pending: 0, issued: 1, created: 2 } as const;
  const a = before.source,
    b = next.source;
  if (order[b.phase] < order[a.phase] || order[b.phase] > order[a.phase] + 1) return false;
  if (a.phase !== 'pending' && b.phase !== 'pending') {
    const intent = (value: typeof a) => JSON.stringify({ ...value, phase: undefined, containerId: undefined });
    if (intent(a) !== intent(b)) return false;
    if (a.phase === 'created' && JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return session;
}
