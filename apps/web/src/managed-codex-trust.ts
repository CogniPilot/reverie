/** Launch-only trust for the exact workspace of an authorized full-access container Codex session. */
import fs from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fullAccessByDefault } from './full-access-default.js';
import { canUsernameRunPrivilegedCommands } from './user-store.js';
import {startupAccountProfile} from './utils/startup-account-profile.js';
export {inlineWorkspaceTrustArgument as codexTrustArgument} from './cli-startup-policy.js';

export async function managedCodexTrust(options: {
  mode: string;
  fullAccess?: boolean;
  workingDir: string;
  owner?: string;
  remote?: unknown;
  docker?: unknown;
  customModel?: unknown;
  discovered?: boolean;
}): Promise<string | undefined> {
  if (!fullAccessByDefault() || !startupAccountProfile(options.mode)?.workspaceTrustArgument || options.fullAccess !== true ||
      options.remote || options.docker || options.discovered ||
      !(await canUsernameRunPrivilegedCommands(options.owner))) return undefined;
  if (!isAbsolute(options.workingDir)) throw new Error('Codex needs an absolute workspace path.');
  try { return await fs.realpath(options.workingDir); }
  catch { throw new Error('Codex workspace is unavailable. Restore it before starting the expert.'); }
}
