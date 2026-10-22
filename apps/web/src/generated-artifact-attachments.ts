/**
 * @fileoverview Codex generated-artifact attachment registration.
 *
 * Codex image generation prints paths such as `Saved to: file://...`. These
 * paths are registered directly when they fall within allowed locations (the
 * session workspace or the well-known Codex generated-artifact directories
 * anchored at the user's home). The trust decision is made on the
 * realpath-RESOLVED path so a symlink staged at an allowed location cannot
 * smuggle an arbitrary host file past workspace confinement.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { registerExternalAttachment, type AttachmentRegistrationResult } from './attachment-registry.js';
import type { SessionRemote } from './types/session.js';

export interface GeneratedArtifactRegistrationOptions {
  sessionId: string;
  filePath: string;
  sessionWorkingDir: string;
  /** Remote (SSH) case: the path lives on the remote host (see attachment-registry). */
  remote?: SessionRemote;
}

export async function registerGeneratedArtifactAttachment(
  options: GeneratedArtifactRegistrationOptions
): Promise<AttachmentRegistrationResult> {
  // Decide trust on the symlink-resolved path. If it can't be resolved, fall
  // back to the strict force-confined policy (registration will 404 a missing
  // file anyway).
  //
  // A remote case keeps that strict policy unconditionally: the well-known Codex
  // artifact directories are anchored at THIS host's home, which says nothing about
  // a remote home, so only a file inside the remote workspace is trusted here.
  const resolvedPath = options.remote ? undefined : tryRealpath(options.filePath);
  const forceWorkspaceConfinement = !resolvedPath
    ? true
    : !isAllowedGeneratedArtifactPath(resolvedPath, options.sessionWorkingDir);
  return registerExternalAttachment(options.sessionId, options.filePath, {
    sessionWorkingDir: options.sessionWorkingDir,
    forceWorkspaceConfinement,
    remote: options.remote,
  });
}

/** `realpathSync` without the throw — undefined when the path does not resolve. */
function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Well-known Codex generated-artifact directories, anchored at the user's home. */
function codexGeneratedDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.codex-personal', 'generated_images'),
    join(home, '.codex', 'generated_images'),
    join(home, '.codex-personal', 'generated_artifacts'),
    join(home, '.codex', 'generated_artifacts'),
  ];
}

/**
 * True when `filePath` (absolute; callers should pass the realpath-resolved
 * path) is inside the session workspace or one of the well-known Codex
 * generated-artifact directories under the current user's home. The marker
 * directories are prefix-anchored to `os.homedir()` — a `.codex/...` subtree
 * elsewhere on the filesystem does NOT qualify.
 */
export function isAllowedGeneratedArtifactPath(filePath: string, workingDir: string): boolean {
  const normalizedPath = normalize(filePath);
  if (isPathInside(normalizedPath, workingDir)) return true;
  return codexGeneratedDirs().some((dir) => isPathInside(normalizedPath, dir));
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const normalizedRoot = normalize(rootPath);
  if (filePath === normalizedRoot) return true;
  return filePath.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep);
}
