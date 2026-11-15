/** Closed CI observations only. A checkpoint records entry, never an effect's
 * outcome, absence of dispatch, permission or reason to retry. */
export const PLAN_OFFICE_STARTUP_STAGES = [
  'entry-arguments',
  'entry-contract',
  'entry-private-home',
  'entry-driver-import',
  'entry-import-exports',
  'driver-admission',
  'driver-contract',
  'driver-runtime-package',
  'driver-evidence-directory',
  'driver-container-census',
  'driver-image-source',
  'driver-image-worker',
  'driver-image-helper',
  'driver-image-control',
  'driver-image-layer-prefix',
  'driver-fixture-directories',
  'driver-bootstrap-seed',
  'driver-network-front',
  'driver-network-workers',
  'driver-platform-closure-read',
  'driver-worker-directories',
  'driver-worker-platform-copy',
  'driver-worker-home-prepare',
  'driver-source-create',
  'driver-docker-socket',
  'driver-control-create',
  'driver-control-connect',
  'driver-control-start',
  'driver-control-owner-preflight',
  'driver-control-tools',
  'driver-internal-host',
  'driver-owner-enrollment',
  'driver-original-policy',
  'driver-original-recovery',
  'driver-original-sdk',
  'driver-selected-scenario',
  'driver-completion-census',
  'ready-self-admission',
] as const;
export type PlanOfficeStartupStage = (typeof PLAN_OFFICE_STARTUP_STAGES)[number];
export type PlanOfficeStartupCheckpoint = (stage: PlanOfficeStartupStage) => void;
const classes = [
  'Error',
  'AssertionError',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ZodError',
  'AggregateError',
  'TimeoutError',
  'AbortError',
  'unknown',
] as const;
const codes = [
  'ERR_ASSERTION',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_REQUIRE_ESM',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_DLOPEN_FAILED',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EEXIST',
  'ENOSPC',
  'ENOTDIR',
  'EISDIR',
  'ELOOP',
  'EIO',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
] as const;
export const PLAN_OFFICE_STARTUP_PREFIX = 'BCPLAN_STARTUP_DIAGNOSTIC_V1 ';
const hex = /^[a-f0-9]{32}$/;
function property(value: unknown, key: string): unknown {
  try {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}
export function planOfficeStartupDiagnostic(stage: PlanOfficeStartupStage, instance: string | null, error: unknown) {
  const name = property(error, 'name'),
    code = property(error, 'code');
  return {
    version: 1 as const,
    purpose: 'reverie-ci-plan-office-startup-diagnostic-v1' as const,
    observation: 'last-known-entered-stage' as const,
    instance: typeof instance === 'string' && hex.test(instance) ? instance : null,
    stage: PLAN_OFFICE_STARTUP_STAGES.includes(stage) ? stage : ('entry-arguments' as const),
    errorClass: typeof name === 'string' && (classes as readonly string[]).includes(name) ? name : 'unknown',
    errorCode: typeof code === 'string' && (codes as readonly string[]).includes(code) ? code : null,
  };
}
/** Exact closed shape and run correlation are required even for an already
 * parsed object. Extra fields, malformed classes/codes and foreign runs fail closed. */
export function projectPlanOfficeStartupDiagnostic(value: unknown, instance: string) {
  try {
    if (!hex.test(instance) || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // Snapshot each property once so a getter cannot change after validation.
    const v = Object.fromEntries(
      ['version', 'purpose', 'observation', 'instance', 'stage', 'errorClass', 'errorCode'].map((key) => [
        key,
        property(value, key),
      ])
    );
    if (
      v.version !== 1 ||
      v.purpose !== 'reverie-ci-plan-office-startup-diagnostic-v1' ||
      v.observation !== 'last-known-entered-stage' ||
      v.instance !== instance ||
      typeof v.stage !== 'string' ||
      !(PLAN_OFFICE_STARTUP_STAGES as readonly string[]).includes(v.stage) ||
      typeof v.errorClass !== 'string' ||
      !(classes as readonly string[]).includes(v.errorClass) ||
      !(
        v.errorCode === null ||
        (typeof v.errorCode === 'string' && (codes as readonly string[]).includes(v.errorCode))
      ) ||
      Object.keys(value).sort().join(',') !== 'errorClass,errorCode,instance,observation,purpose,stage,version'
    )
      return undefined;
    return {
      version: 1 as const,
      purpose: 'reverie-ci-plan-office-startup-diagnostic-v1' as const,
      observation: 'last-known-entered-stage' as const,
      instance,
      stage: v.stage as PlanOfficeStartupStage,
      errorClass: v.errorClass,
      errorCode: v.errorCode as string | null,
    };
  } catch {
    return undefined;
  }
}
/** Only one complete canonical frame is accepted; no raw child text is returned. */
export function readPlanOfficeStartupDiagnostic(stdout: unknown, instance: string) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 65536 || !stdout.endsWith('\n')) return undefined;
  const frames = stdout.split('\n').filter((line) => line.startsWith(PLAN_OFFICE_STARTUP_PREFIX));
  if (frames.length !== 1 || Buffer.byteLength(frames[0]!) > 1024) return undefined;
  const json = frames[0]!.slice(PLAN_OFFICE_STARTUP_PREFIX.length);
  try {
    const projected = projectPlanOfficeStartupDiagnostic(JSON.parse(json), instance);
    return projected && JSON.stringify(projected) === json ? projected : undefined;
  } catch {
    return undefined;
  }
}
