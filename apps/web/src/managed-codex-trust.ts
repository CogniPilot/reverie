/** Launch-only trust for the exact workspace of an authorized full-access container Codex session. */
import fs from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fullAccessByDefault } from './full-access-default.js';
import { canUsernameRunPrivilegedCommands } from './user-store.js';
import { startupAccountProfile } from './utils/startup-account-profile.js';
export { inlineWorkspaceTrustArgument as codexTrustArgument } from './cli-startup-policy.js';

interface ManagedCodexTrustOptions {
  mode: string;
  fullAccess?: boolean;
  workingDir: string;
  owner?: string;
  remote?: unknown;
  docker?: unknown;
  customModel?: unknown;
  discovered?: boolean;
}
/** Eligibility is not a workspace grant; Docker still requires its private launch owner and native observation. */
export async function managedCodexTrustEligible(options: ManagedCodexTrustOptions): Promise<boolean> {
  return !!(
    fullAccessByDefault() &&
    startupAccountProfile(options.mode)?.workspaceTrustArgument &&
    options.fullAccess === true &&
    !options.remote &&
    !options.discovered &&
    (await canUsernameRunPrivilegedCommands(options.owner))
  );
}
export async function managedCodexTrust(options: ManagedCodexTrustOptions): Promise<string | undefined> {
  if (options.docker || !(await managedCodexTrustEligible(options))) return undefined;
  if (!isAbsolute(options.workingDir)) throw new Error('Codex needs an absolute workspace path.');
  try {
    return await fs.realpath(options.workingDir);
  } catch {
    throw new Error('Codex workspace is unavailable. Restore it before starting the expert.');
  }
}
