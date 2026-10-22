/** Launch-only trust for the exact workspace of an authorized full-access container Codex session. */
import fs from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fullAccessByDefault } from './full-access-default.js';
import { canUsernameRunPrivilegedCommands } from './user-store.js';

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
  if (!fullAccessByDefault() || options.mode !== 'codex' || options.fullAccess !== true ||
      options.remote || options.docker || options.discovered ||
      !(await canUsernameRunPrivilegedCommands(options.owner))) return undefined;
  if (!isAbsolute(options.workingDir)) throw new Error('Codex needs an absolute workspace path.');
  try { return await fs.realpath(options.workingDir); }
  catch { throw new Error('Codex workspace is unavailable. Restore it before starting the expert.'); }
}

/** A complete TOML table inside one shell-escaped --config argument. */
export function codexTrustArgument(workingDir: string): string {
  if (!isAbsolute(workingDir) || /[\0\r\n]/.test(workingDir)) throw new Error('Invalid Codex trust workspace');
  // Codex 0.146 splits dotted override keys without unquoting path segments.
  // An inline table preserves the exact path key and works at real startup.
  const value = `projects={${JSON.stringify(workingDir)}={trust_level="trusted"}}`;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
