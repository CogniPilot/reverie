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

export function nativeThreadProfile(mode: string | undefined): Readonly<NativeThreadProfile> | undefined {
  if (!mode) return undefined;
  const pair = resolvedStockProtocol(mode),
    name = pair?.shipped.launch.threadStateProfile;
  if (!pair || !name || pair.entry.launch.threadStateProfile !== name) return undefined;
  return NATIVE_THREAD_PROFILES[name];
}
function rebootPolicy(mode: string) {
  const pair = resolvedStockProtocol(mode),
    policy = pair?.shipped.capabilities.rebootRestore;
  return pair && policy && pair.entry.capabilities.rebootRestore === policy ? policy : undefined;
}
export function rebootResumeTarget(state: NativeThreadState & { mode?: string }): string | undefined {
  const mode = state.mode ?? 'claude',
    policy = rebootPolicy(mode);
  if (!policy) return undefined;
  if (policy === 'persistent-record') return conversationChainTarget(state);
  const native = nativeThreadProfile(mode)?.read(state);
  return policy === 'native-or-new' ? (native ?? '') : native;
}
export function rebootRestoreLaunchConfig(
  state: NativeThreadState & { mode?: string },
  target: string
): ThreadRestoreLaunchConfig {
  const mode = state.mode ?? 'claude',
    policy = rebootPolicy(mode);
  if (!policy || rebootResumeTarget(state) === undefined)
    throw new Error('The saved runtime no longer has a supported reboot restore protocol');
  if (policy === 'persistent-record') return conversationLaunchConfig(state, target);
  const profile = nativeThreadProfile(mode);
  if (!profile) throw new Error('The saved runtime has no supported native thread codec');
  return profile.project(state, target);
}
