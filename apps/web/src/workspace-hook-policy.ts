import { getCli } from './config/cli-registry/registry.js';
import type { WorkspaceHookPhase, WorkspaceHookPolicy } from './config/cli-registry/types.js';
import { applyWorkspaceHooks, refreshStaleReverieHooks, writeHooksConfig } from './hooks-config.js';

export function workspaceHookPolicy(mode: string, phase: WorkspaceHookPhase): WorkspaceHookPolicy {
  return getCli(mode)?.capabilities.workspaceHooks?.[phase] ?? 'none';
}

/** The caller supplies only an authorized local workspace and its creation phase. */
export async function prepareWorkspaceHooks(
  workspace: string,
  policy: WorkspaceHookPolicy,
  options: { scaffold: boolean; enabled: () => Promise<boolean> }
): Promise<void> {
  switch (policy) {
    case 'none':
      return;
    case 'refresh-only':
      await refreshStaleReverieHooks(workspace).catch(() => {});
      return;
    case 'install':
      if (options.scaffold) await writeHooksConfig(workspace);
      else await applyWorkspaceHooks(workspace, await options.enabled());
      return;
    default: {
      const unexpected: never = policy;
      void unexpected;
      throw new Error('Unsupported workspace hook policy');
    }
  }
}
