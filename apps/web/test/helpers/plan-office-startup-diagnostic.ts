/** Closed CI observations only. A checkpoint records entry, never an effect's
 * outcome, absence of dispatch, permission or reason to retry. */
export const PLAN_OFFICE_BUILD_STAGES = [
  'build-inputs',
  'build-dependency-lock',
  'build-product-modules',
  'build-public-assets',
  'build-provider-fixtures',
  'build-driver-modules',
  'build-import-smoke',
  'build-metadata',
] as const;
export const PLAN_OFFICE_STARTUP_STAGES = [
  ...PLAN_OFFICE_BUILD_STAGES,
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

/** Nix's structured builder-log records only. Never return a raw Nix message,
 * path, environment, command or exception. The zero instance is the inert build
 * smoke contract, not a business operation or proof that no effects occurred. */
export function readPlanOfficeBuildDiagnostic(stderr: unknown) {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr) > 32 * 1024 ** 2 || !stderr.endsWith('\n'))
    return undefined;
  const frames = [];
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('@nix ') || Buffer.byteLength(line) > 256 * 1024) continue;
    try {
      const record = JSON.parse(line.slice(5));
      if (
        record?.action !== 'result' ||
        record.type !== 101 ||
        !Array.isArray(record.fields) ||
        typeof record.fields[0] !== 'string'
      )
        continue;
      const frame = readPlanOfficeStartupDiagnostic(record.fields[0] + '\n', '0'.repeat(32));
      if (frame) frames.push(frame);
    } catch {
      // A malformed/partial record supplies no diagnostic authority.
    }
  }
  const builders = frames.filter((frame) => (PLAN_OFFICE_BUILD_STAGES as readonly string[]).includes(frame.stage));
  const imports = frames.filter((frame) => !(PLAN_OFFICE_BUILD_STAGES as readonly string[]).includes(frame.stage));
  if (builders.length !== 1 || imports.length > 1) return undefined;
  return { builder: builders[0]!, ...(imports.length ? { importSmoke: imports[0]! } : {}) };
}
