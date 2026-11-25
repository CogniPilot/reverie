/** Independent native thread representation and explicit reboot offer policy. */
import { resolvedStockProtocol } from './resolved-stock-protocol.js';
import {
  NATIVE_THREAD_PROFILES,
  conversationChainTarget,
  conversationLaunchConfig,
  type NativeThreadProfile,
  type NativeThreadState,
  type ThreadRestoreLaunchConfig,
} from '../native-thread-policy.js';

type StockProtocol = ReturnType<typeof resolvedStockProtocol>;

// Each exported reader resolves the stock protocol ONCE and derives everything from that one
// validated pair. Resolution compares whole registry definitions, and these readers run for every
// employee on every health and digest pass, so resolving it again per derived fact was most of
// the office's time; within one synchronous call the registry cannot change between them.
function profileOf(pair: StockProtocol): Readonly<NativeThreadProfile> | undefined {
  const name = pair?.shipped.launch.threadStateProfile;
  if (!pair || !name || pair.entry.launch.threadStateProfile !== name) return undefined;
  return NATIVE_THREAD_PROFILES[name];
}
function policyOf(pair: StockProtocol) {
  const policy = pair?.shipped.capabilities.rebootRestore;
  return pair && policy && pair.entry.capabilities.rebootRestore === policy ? policy : undefined;
}
function resumeTarget(pair: StockProtocol, state: NativeThreadState): string | undefined {
  const policy = policyOf(pair);
  if (!policy) return undefined;
  if (policy === 'persistent-record') return conversationChainTarget(state);
  const native = profileOf(pair)?.read(state);
  return policy === 'native-or-new' ? (native ?? '') : native;
}

export function nativeThreadProfile(mode: string | undefined): Readonly<NativeThreadProfile> | undefined {
  return mode ? profileOf(resolvedStockProtocol(mode)) : undefined;
}
export function rebootResumeTarget(state: NativeThreadState & { mode?: string }): string | undefined {
  return resumeTarget(resolvedStockProtocol(state.mode ?? 'claude'), state);
}
export function rebootRestoreLaunchConfig(
  state: NativeThreadState & { mode?: string },
  target: string
): ThreadRestoreLaunchConfig {
  const pair = resolvedStockProtocol(state.mode ?? 'claude'),
    policy = policyOf(pair);
  if (!policy || resumeTarget(pair, state) === undefined)
    throw new Error('The saved runtime no longer has a supported reboot restore protocol');
  if (policy === 'persistent-record') return conversationLaunchConfig(state, target);
  const profile = profileOf(pair);
  if (!profile) throw new Error('The saved runtime has no supported native thread codec');
  return profile.project(state, target);
}
/** The resume target and its launch configuration from one protocol resolution, for callers that
 * need both (the same results as `rebootResumeTarget` followed by `rebootRestoreLaunchConfig`). */
export function rebootRestorePlan(
  state: NativeThreadState & { mode?: string }
): { target: string; config: ThreadRestoreLaunchConfig } | undefined {
  const pair = resolvedStockProtocol(state.mode ?? 'claude'),
    policy = policyOf(pair),
    target = resumeTarget(pair, state);
  if (!policy || target === undefined) return undefined;
  if (policy === 'persistent-record') return { target, config: conversationLaunchConfig(state, target) };
  const profile = profileOf(pair);
  if (!profile) throw new Error('The saved runtime has no supported native thread codec');
  return { target, config: profile.project(state, target) };
}
