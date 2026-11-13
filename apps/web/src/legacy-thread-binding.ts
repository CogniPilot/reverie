/** Public config codecs are independent of native restoration/lifecycle authority. */
import { getCli } from './config/cli-registry/registry.js';
import { THREAD_STATE_BINDINGS } from './config/cli-registry/profiles.js';

type NestedBinding = (typeof THREAD_STATE_BINDINGS)['nested-resume-v1'];
type ForkableBinding = (typeof THREAD_STATE_BINDINGS)['forkable-continue-v1'];
export type LegacyThreadBinding = NestedBinding | ForkableBinding;

/** Resolve the current declared wire field AND its parameter/alias codec, never a CLI ID. */
export function legacyThreadBinding(mode: string | undefined): LegacyThreadBinding | undefined {
  const launch = mode ? getCli(mode)?.launch : undefined;
  if (!launch) return undefined;
  for (const binding of Object.values(THREAD_STATE_BINDINGS)) {
    if (!('field' in binding) || launch.legacyConfigField !== binding.field) continue;
    if (
      launch.params[binding.param]?.type !== 'token' ||
      (launch.legacyConfigAliases?.[binding.param] ?? binding.param) !== binding.key
    )
      return undefined;
    if (
      'forkParam' in binding &&
      (launch.params[binding.forkParam]?.type !== 'bool' ||
        (launch.legacyConfigAliases?.[binding.forkParam] ?? binding.forkParam) !== binding.forkKey)
    )
      return undefined;
    return binding;
  }
  return undefined;
}

/** A declared legacy thread bag must not be silently dropped under an incompatible codec. */
export function incompatibleLegacyThreadBinding(mode: string): boolean {
  const field = getCli(mode)?.launch.legacyConfigField;
  return (
    Object.values(THREAD_STATE_BINDINGS).some((binding) => 'field' in binding && binding.field === field) &&
    !legacyThreadBinding(mode)
  );
}

/** Other legacy config bags historically store subscription thread resumes under this key. */
export function legacySubscriptionThreadKey(mode: string): 'continueSession' | 'resumeSessionId' {
  return legacyThreadBinding(mode)?.key ?? THREAD_STATE_BINDINGS['nested-resume-v1'].key;
}
