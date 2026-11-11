import { getCli } from './config/cli-registry/registry.js';
import type { WorkspaceHookPhase, WorkspaceHookPolicy } from './config/cli-registry/types.js';
import {
  applyWorkspaceHooks,
  refreshStaleReverieHooks,
  writeHooksConfig,
  type SettingsWriteOutcome,
} from './hooks-config.js';

const FILESYSTEM_FAILURE_CODES = new Set([
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'EIO',
  'ENOTDIR',
  'EISDIR',
  'ENOENT',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENAMETOOLONG',
  'ETIMEDOUT',
]);

export class WorkspaceHookPreparationError extends Error {
  constructor(
    readonly workspace: string,
    readonly outcome: Extract<SettingsWriteOutcome, { state: 'refused' | 'unconfirmed' }>
  ) {
    const code = outcome.state === 'unconfirmed' ? (outcome.cause as { code?: unknown } | undefined)?.code : undefined;
    // Expose a bounded filesystem diagnosis, never arbitrary exception text.
    const diagnostic = typeof code === 'string' && FILESYSTEM_FAILURE_CODES.has(code) ? ` (${code})` : '';
    super(
      `Workspace hook preparation ${outcome.state}: ${outcome.reason}${diagnostic}. Inspect and repair the case's .claude paths before retrying.`,
      { cause: outcome.state === 'unconfirmed' ? outcome.cause : undefined }
    );
    this.name = 'WorkspaceHookPreparationError';
  }
}

export function workspaceHookPolicy(mode: string, phase: WorkspaceHookPhase): WorkspaceHookPolicy {
  return getCli(mode)?.capabilities.workspaceHooks?.[phase] ?? 'none';
}

export type WorkspaceHookConfiguration = 'prepared' | 'opted-out' | 'unknown';

// Created only after this module consumes an actual filesystem preparation
// result. It is neither a JSON authority nor persisted session state.
class ConfigurationReceipt {
  #consumed = false;
  #workspace: string;
  #configuration: WorkspaceHookConfiguration;
  constructor(workspace: string, configuration: WorkspaceHookConfiguration) {
    this.#workspace = workspace; this.#configuration = configuration; Object.freeze(this);
  }
  consume(workspace: string): WorkspaceHookConfiguration {
    if (this.#consumed || workspace !== this.#workspace) return 'unknown';
    this.#consumed = true;
    return this.#configuration;
  }
}
export type WorkspaceHookPreparation = ConfigurationReceipt;

export function consumeWorkspaceHookPreparation(
  preparation: WorkspaceHookPreparation | undefined,
  workspace: string
): WorkspaceHookConfiguration {
  return preparation instanceof ConfigurationReceipt ? preparation.consume(workspace) : 'unknown';
}

/** The caller supplies only an authorized local workspace and its creation phase. */
export async function prepareWorkspaceHooks(
  workspace: string,
  policy: WorkspaceHookPolicy,
  options: { scaffold: boolean; enabled?: () => Promise<boolean> }
): Promise<WorkspaceHookPreparation> {
  let outcome: SettingsWriteOutcome;
  switch (policy) {
    case 'none':
      return new ConfigurationReceipt(workspace, 'opted-out');
    case 'refresh-only':
      try {
        outcome = await refreshStaleReverieHooks(workspace);
      } catch {
        return new ConfigurationReceipt(workspace, 'unknown');
      }
      break;
    case 'install':
      try {
        outcome = options.scaffold
          ? await writeHooksConfig(workspace)
          : await applyWorkspaceHooks(workspace, await options.enabled?.());
      } catch (cause) {
        throw new WorkspaceHookPreparationError(workspace, {
          state: 'unconfirmed', reason: 'the required hooks configuration did not complete', cause,
        });
      }
      if (outcome.state === 'refused' || outcome.state === 'unconfirmed')
        throw new WorkspaceHookPreparationError(workspace, outcome);
      break;
    default: {
      const unexpected: never = policy;
      void unexpected;
      throw new Error('Unsupported workspace hook policy');
    }
  }
  return new ConfigurationReceipt(workspace,
    outcome.state === 'completed' ? 'prepared' : outcome.state === 'opted-out' ? 'opted-out' : 'unknown');
}
