import { stripVTControlCharacters } from 'node:util';

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
  'driver-control-transport',
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

const nixCategories = ['builder-failure', 'dependency-failure', 'evaluation-error', 'nix-error'] as const;
const nixComponents = [
  'fixture-runtime',
  'fixture-image',
  'client-bundle',
  'client-capsule',
  'client-capsule-producer',
  'client-notices',
  'guest-capsule',
  'guest-capsule-producer',
  'tools-capsule',
  'tools-capsule-producer',
  'resource-helper',
  'worker-platform',
  'other-derivation',
  'unavailable',
] as const;
const nixSources = [
  'ci-plan-office-images',
  'package',
  'docker-viewer-executables',
  'other-source',
  'unavailable',
] as const;
const nixKeys = [
  'version',
  'purpose',
  'observation',
  'instance',
  'category',
  'component',
  'source',
  'reports',
] as const;
/** Already parsed child data is still untrusted. Emit only a fresh closed shape,
 * never a raw Nix string, path, source excerpt, number or exception. */
export function projectPlanOfficeNixDiagnostic(value: unknown, instance: string) {
  try {
    if (
      !hex.test(instance) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).length !== nixKeys.length ||
      !Reflect.ownKeys(value).every((key) => typeof key === 'string' && (nixKeys as readonly string[]).includes(key))
    )
      return undefined;
    const v = Object.fromEntries(nixKeys.map((key) => [key, property(value, key)]));
    if (
      v.version !== 1 ||
      v.purpose !== 'reverie-ci-plan-office-nix-diagnostic-v1' ||
      !['last-reported-nix-error', 'first-reported-builder-failure'].includes(v.observation as string) ||
      v.instance !== instance ||
      typeof v.category !== 'string' ||
      !(nixCategories as readonly string[]).includes(v.category) ||
      typeof v.component !== 'string' ||
      !(nixComponents as readonly string[]).includes(v.component) ||
      typeof v.source !== 'string' ||
      !(nixSources as readonly string[]).includes(v.source) ||
      !['one', 'multiple'].includes(v.reports as string)
    )
      return undefined;
    return {
      version: 1 as const,
      purpose: 'reverie-ci-plan-office-nix-diagnostic-v1' as const,
      observation: v.observation as 'last-reported-nix-error' | 'first-reported-builder-failure',
      instance,
      category: v.category as (typeof nixCategories)[number],
      component: v.component as (typeof nixComponents)[number],
      source: v.source as (typeof nixSources)[number],
      reports: v.reports as 'one' | 'multiple',
    };
  } catch {
    return undefined;
  }
}
function nixError(record: Record<string, unknown>, instance: string, reports: 'one' | 'multiple') {
  if (record.action !== 'msg' || record.level !== 0 || typeof record.msg !== 'string' || record.msg.length === 0)
    return undefined;
  // Match only Nix's fixed summary grammar, never a builder log line. Classification
  // describes that reported error; it does not identify the underlying cause.
  const raw = typeof record.raw_msg === 'string' ? record.raw_msg : record.msg;
  const text = stripVTControlCharacters(raw).replace(/^error:\s*/, '');
  const derivation = /^(?:Cannot build|builder for) '([^'\r\n]+\.drv)'/.exec(text)?.[1];
  const builder =
    !!derivation &&
    /^(?:Cannot build '[^'\r\n]+\.drv'\.\n[ \t]*Reason: builder failed with exit code [0-9]+\b|builder for '[^'\r\n]+\.drv' failed with exit code [0-9]+\b)/.test(
      text
    );
  const dependency =
    !!derivation &&
    /^Cannot build '[^'\r\n]+\.drv'\.\n[ \t]*Reason: [1-9][0-9]* dependenc(?:y|ies) failed\b/.test(text);
  const located =
    typeof record.file === 'string' &&
    record.file.length > 0 &&
    Number.isSafeInteger(record.line) &&
    Number(record.line) > 0;
  const name = derivation && /^\/nix\/store\/[a-z0-9]{32}-([^/]+)\.drv$/.exec(derivation)?.[1];
  const owned: Record<string, (typeof nixComponents)[number]> = {
    'reverie-worker-client-bundle': 'client-bundle',
    'reverie-worker-client-capsule': 'client-capsule',
    'reverie-worker-client-capsule-producer-0.1.0': 'client-capsule-producer',
    'reverie-worker-client-notices': 'client-notices',
    'reverie-perf-guest-capsule': 'guest-capsule',
    'reverie-perf-capsule-producer-0.1.0': 'guest-capsule-producer',
    'reverie-worker-tools-capsule': 'tools-capsule',
    'reverie-worker-tools-capsule-producer-0.1.0': 'tools-capsule-producer',
    'reverie-docker-resources-0.1.0': 'resource-helper',
    'reverie-ci-plan-worker-platform': 'worker-platform',
  };
  const component =
    name === 'reverie-ci-plan-office-runtime'
      ? 'fixture-runtime'
      : typeof name === 'string' &&
          /^docker-image-reverie-ci-plan-office-[a-f0-9]{32}-(?:source|worker|helper|control)(?:\.tar\.gz)?$/.test(name)
        ? 'fixture-image'
        : name
          ? Object.hasOwn(owned, name)
            ? owned[name]!
            : 'other-derivation'
          : 'unavailable';
  const file = located ? (record.file as string) : '';
  const source = file.endsWith('/nix/ci-plan-office-images.nix')
    ? 'ci-plan-office-images'
    : file.endsWith('/nix/package.nix')
      ? 'package'
      : file.endsWith('/nix/docker-viewer-executables.nix')
        ? 'docker-viewer-executables'
        : file
          ? 'other-source'
          : 'unavailable';
  return projectPlanOfficeNixDiagnostic(
    {
      version: 1,
      purpose: 'reverie-ci-plan-office-nix-diagnostic-v1',
      observation: 'last-reported-nix-error',
      instance,
      category: builder
        ? 'builder-failure'
        : dependency
          ? 'dependency-failure'
          : located
            ? 'evaluation-error'
            : 'nix-error',
      component,
      source,
      reports,
    },
    instance
  );
}
/** Revalidate the complete outbound build shape, including nested diagnostics. */
export function projectPlanOfficeBuildDiagnostic(value: unknown, instance?: string) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length === 0 ||
      keys.some((key) => typeof key !== 'string' || !['builder', 'importSmoke', 'nix', 'firstBuilder'].includes(key))
    )
      return undefined;
    const b = property(value, 'builder'),
      i = property(value, 'importSmoke'),
      n = property(value, 'nix'),
      first = property(value, 'firstBuilder');
    const builder = !keys.includes('builder') ? undefined : projectPlanOfficeStartupDiagnostic(b, '0'.repeat(32));
    const importSmoke = !keys.includes('importSmoke')
      ? undefined
      : projectPlanOfficeStartupDiagnostic(i, '0'.repeat(32));
    const nix =
      !keys.includes('nix') || instance === undefined ? undefined : projectPlanOfficeNixDiagnostic(n, instance);
    const firstBuilder =
      !keys.includes('firstBuilder') || instance === undefined
        ? undefined
        : projectPlanOfficeNixDiagnostic(first, instance);
    if (
      (keys.includes('builder') &&
        (!builder || !(PLAN_OFFICE_BUILD_STAGES as readonly string[]).includes(builder.stage))) ||
      (keys.includes('importSmoke') &&
        (!builder || !importSmoke || (PLAN_OFFICE_BUILD_STAGES as readonly string[]).includes(importSmoke.stage))) ||
      (keys.includes('nix') && (!nix || nix.observation !== 'last-reported-nix-error')) ||
      (keys.includes('firstBuilder') &&
        (!nix ||
          !firstBuilder ||
          firstBuilder.category !== 'builder-failure' ||
          firstBuilder.observation !== 'first-reported-builder-failure')) ||
      (!builder && !nix)
    )
      return undefined;
    return {
      ...(builder ? { builder } : {}),
      ...(importSmoke ? { importSmoke } : {}),
      ...(nix ? { nix } : {}),
      ...(firstBuilder ? { firstBuilder } : {}),
    };
  } catch {
    return undefined;
  }
}
/** Structured records from this one Nix child only. The zero instance belongs
 * to inert Node build/import smoke; Nix reports are correlated with the CI run.
 * No reported error proves effects, their absence, permission or retry safety. */
export function readPlanOfficeBuildDiagnostic(stderr: unknown, instance?: string) {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr) > 32 * 1024 ** 2 || !stderr.endsWith('\n'))
    return undefined;
  const frames = [];
  let nix: ReturnType<typeof projectPlanOfficeNixDiagnostic>,
    firstBuilder: ReturnType<typeof projectPlanOfficeNixDiagnostic>,
    reports: 'one' | 'multiple' = 'one';
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('@nix ') || Buffer.byteLength(line) > 256 * 1024) continue;
    try {
      const record = JSON.parse(line.slice(5));
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      if (instance) {
        const reported = nixError(record, instance, reports);
        if (reported) {
          if (!firstBuilder && reported.category === 'builder-failure') firstBuilder = reported;
          nix = reported;
          reports = 'multiple';
        }
      }
      if (
        record.action !== 'result' ||
        record.type !== 101 ||
        !Array.isArray(record.fields) ||
        typeof record.fields[0] !== 'string'
      )
        continue;
      const frame = readPlanOfficeStartupDiagnostic(record.fields[0] + '\n', '0'.repeat(32));
      if (frame) frames.push(frame);
    } catch {
      /* Malformed or partial records supply no diagnostic authority. */
    }
  }
  const builders = frames.filter((frame) => (PLAN_OFFICE_BUILD_STAGES as readonly string[]).includes(frame.stage));
  const imports = frames.filter((frame) => !(PLAN_OFFICE_BUILD_STAGES as readonly string[]).includes(frame.stage));
  if (builders.length > 1 || imports.length > 1) return undefined;
  return projectPlanOfficeBuildDiagnostic(
    {
      ...(builders.length ? { builder: builders[0] } : {}),
      ...(builders.length && imports.length ? { importSmoke: imports[0] } : {}),
      ...(nix ? { nix } : {}),
      ...(firstBuilder && nix !== firstBuilder
        ? {
            firstBuilder: {
              ...firstBuilder,
              observation: 'first-reported-builder-failure',
            },
          }
        : {}),
    },
    instance
  );
}
