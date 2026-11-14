import { resolvedStockProtocol } from './utils/resolved-stock-protocol.js';
/** Launch selection and observations of an existing provider are distinct DATA.
 * Neither digest grants permission to launch or to attach a native process. */
import type { CompanyEmployee } from './company-types.js';
import type { SessionState } from './types.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { THREAD_STATE_BINDINGS } from './config/cli-registry/profiles.js';
import { nativeThreadProfile, rebootRestoreLaunchConfig, rebootResumeTarget } from './utils/native-thread-profile.js';

const launchFields = [
  'mode',
  'workingDir',
  'model',
  'effort',
  'advisorModel',
  'claudeMode',
  'allowedTools',
  'subscriptionProfile',
  'customModel',
  'runtimeThreads',
  'openCodeConfig',
  'codexConfig',
  'geminiConfig',
  'antigravityConfig',
  'piConfig',
  'grokConfig',
  'deepSeekConfig',
  'ompConfig',
  'resumeSessionId',
  'claudeSessionChain',
  '__envOverrides',
  '__customModel',
] as const;

function sourceValue(employee: CompanyEmployee, saved: SessionState) {
  const target = rebootResumeTarget(saved);
  const normalized = target === undefined ? saved : { ...saved, ...rebootRestoreLaunchConfig(saved, target) };
  const value = { ...normalized, runtimeThreads: normalized.runtimeThreads ?? {} } as unknown as Record<
    string,
    unknown
  >;
  return {
    employeeId: employee.id,
    owner: employee.owner ?? null,
    sessionId: employee.sessionId,
    generation: employee.sessionGeneration,
    recipe: employee.runtimeRecipe ?? null,
    thread: employee.threadId ?? null,
    saved: Object.fromEntries(launchFields.map((key) => [key, value[key] ?? null])),
  };
}

/** Preserve the existing v1 launch bytes, including the selected native thread. */
export function dockerEmployeeSourceDigest(employee: CompanyEmployee, saved: SessionState): string {
  return dockerContinuationDigest(sourceValue(employee, saved));
}

function withoutKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function nativeConfigFacts(value: unknown, key: string): unknown {
  const projected = withoutKey(value, key);
  return projected && typeof projected === 'object' && !Array.isArray(projected) && Object.keys(projected).length
    ? projected
    : null;
}

/** Freeze actual recipe/configuration separately from runtime-owned native IDs.
 * Only a locked stock native-thread codec permits this projection. Unknown or
 * overridden protocols retain the full strict launch fingerprint. */
export function dockerEmployeeProviderSourceDigest(employee: CompanyEmployee, saved: SessionState): string {
  const profile = nativeThreadProfile(saved.mode ?? 'claude');
  if (!profile) return dockerEmployeeSourceDigest(employee, saved);
  const value = sourceValue(employee, saved);
  const fields: Record<string, unknown> = { ...value.saved };
  if ((saved.mode ?? 'claude') === 'claude') {
    // Absence already selects this exact locked protocol default. Normalize
    // only existing-provider facts; never alter the original launch bytes.
    const permission = resolvedStockProtocol('claude')?.shipped.launch.params.claudeMode;
    if (fields.claudeMode === null && permission?.type === 'enum') fields.claudeMode = permission.default ?? null;
  } else {
    // These top-level flags are used only by the locked Claude protocol.
    delete fields.claudeMode;
    delete fields.allowedTools;
  }
  for (const key of ['runtimeThreads', 'resumeSessionId', 'claudeSessionChain']) delete fields[key];
  const recipe = value.recipe ? { ...value.recipe } : null;
  if (recipe) delete recipe.runtimeThreads;
  const binding = THREAD_STATE_BINDINGS[profile.name];
  if ('field' in binding) {
    fields[binding.field] = nativeConfigFacts(fields[binding.field], binding.key);
    if (recipe?.configs && Object.hasOwn(recipe.configs, binding.field)) {
      const projected = nativeConfigFacts(recipe.configs[binding.field], binding.key);
      recipe.configs = projected
        ? ({ ...recipe.configs, [binding.field]: projected } as typeof recipe.configs)
        : Object.fromEntries(Object.entries(recipe.configs).filter(([name]) => name !== binding.field));
    }
  }
  return dockerContinuationDigest({
    ...value,
    recipe,
    thread: profile.kind === 'forkable-continue' ? null : value.thread,
    saved: fields,
  });
}

/** Legacy migration may reconstruct only the first learned nested native ID.
 * It must still reproduce the exact original launch digest. This is not an
 * arbitrary recipe adoption and never changes the retained launch fingerprint. */
export function legacyDockerProviderSourceMatches(
  employee: CompanyEmployee,
  saved: SessionState,
  originalDigest: string
): boolean {
  if (dockerEmployeeSourceDigest(employee, saved) === originalDigest) return true;
  const profile = nativeThreadProfile(saved.mode ?? 'claude');
  if (profile?.kind !== 'nested-resume') return false;
  const binding = THREAD_STATE_BINDINGS['nested-resume-v1'];
  const config = saved[binding.field];
  if (!config?.[binding.key]) return false;
  const original = { ...saved, [binding.field]: withoutKey(config, binding.key) } as SessionState;
  if (profile.read(original)) return false;
  return dockerEmployeeSourceDigest(employee, original) === originalDigest;
}
