/** Pure native identifier/config codecs. Reading a thread grants no restoration authority. */
import type { CodexConfig, SessionState } from './types.js';
import { THREAD_STATE_BINDINGS, type ThreadStateProfileName } from './config/cli-registry/profiles.js';

export type NativeThreadState = Partial<
  Pick<SessionState, 'id' | 'claudeSessionChain' | 'resumeSessionId' | 'codexConfig' | 'openCodeConfig'>
>;
export interface ThreadRestoreLaunchConfig {
  resumeSessionId?: string;
  codexConfig?: CodexConfig;
}
export interface NativeThreadProfile {
  readonly name: ThreadStateProfileName;
  readonly kind: 'conversation-chain' | 'nested-resume' | 'forkable-continue';
  read(state: NativeThreadState): string | undefined;
  /** Rebuild projection: native config IDs are never replaced by a logical plan target. */
  project(state: NativeThreadState, target: string): ThreadRestoreLaunchConfig;
}
export function conversationChainTarget(
  state: Pick<SessionState, 'id' | 'claudeSessionChain' | 'resumeSessionId'>
): string;
export function conversationChainTarget(state: NativeThreadState): string | undefined;
export function conversationChainTarget(state: NativeThreadState): string | undefined {
  const chain = state.claudeSessionChain;
  const tail = Array.isArray(chain) && chain.length > 0 ? chain[chain.length - 1] : undefined;
  return tail || state.resumeSessionId || state.id;
}
function nestedResume(state: NativeThreadState): string | undefined {
  const binding = THREAD_STATE_BINDINGS['nested-resume-v1'];
  const thread = state[binding.field]?.[binding.key] || state.resumeSessionId;
  return typeof thread === 'string' && thread.trim().length > 0 ? thread : undefined;
}
function forkableContinue(state: NativeThreadState): string | undefined {
  const binding = THREAD_STATE_BINDINGS['forkable-continue-v1'];
  if (state[binding.field]?.[binding.forkKey] === true) return undefined;
  const thread = state[binding.field]?.[binding.key];
  return typeof thread === 'string' && thread.length > 0 ? thread : undefined;
}
export function conversationLaunchConfig(state: NativeThreadState, target: string): ThreadRestoreLaunchConfig {
  return { resumeSessionId: target, codexConfig: state.codexConfig };
}
export const NATIVE_THREAD_PROFILES: Readonly<Record<ThreadStateProfileName, Readonly<NativeThreadProfile>>> =
  Object.freeze({
    'conversation-chain-v1': Object.freeze({
      name: 'conversation-chain-v1',
      kind: 'conversation-chain',
      read: conversationChainTarget,
      project: conversationLaunchConfig,
    }),
    'nested-resume-v1': Object.freeze({
      name: 'nested-resume-v1',
      kind: 'nested-resume',
      read: nestedResume,
      project: (state: NativeThreadState) => {
        const binding = THREAD_STATE_BINDINGS['nested-resume-v1'];
        return {
          resumeSessionId: undefined,
          [binding.field]: { ...state[binding.field], [binding.key]: nestedResume(state) },
        };
      },
    }),
    'forkable-continue-v1': Object.freeze({
      name: 'forkable-continue-v1',
      kind: 'forkable-continue',
      read: forkableContinue,
      project: (state: NativeThreadState) => ({ resumeSessionId: undefined, codexConfig: state.codexConfig }),
    }),
  });
