/**
 * @fileoverview Shared sensitive-path blocklist.
 *
 * A small defense-in-depth blocklist of absolute paths that must never be
 * served to the browser regardless of how the path was obtained (workspace
 * download, cross-workspace attachment registration, raw/preview serving).
 *
 * This is intentionally a BLOCKLIST, not a workspace-confinement check:
 * cross-workspace attachment is a supported feature (reverie-publish skill +
 * the automated review-card loop attaching files under ~/.reverie/), so a
 * strict session-workspace boundary would break legitimate use. The blocklist
 * rejects well-known secret locations (system password files, SSH keys, cloud
 * credentials, dotenv files) while leaving ordinary cross-workspace files
 * attachable.
 *
 * ⚠️ The path picker's `showHidden` option is what makes the dot-prefixed half
 * of this list load-bearing. Before it existed, the picker refused every path
 * with a hidden segment, so `~/.config/gh/hosts.yml` and friends were
 * unreachable by construction and the list only had to cover the few secrets
 * that live in plain sight. Opting into hidden entries removes that accident,
 * so every credential location below has to be named. Adding a new browse
 * surface means re-reading this file, not assuming it already covers you.
 *
 * ⚠️ Deliberately NOT whole-tree blocks: `~/.reverie/` (the publish skill
 * attaches from it) and `~/.claude/` (transcripts and team state are ordinary
 * files worth attaching). Only their secret-bearing members are named.
 *
 * Callers MUST resolve symlinks (realpath) BEFORE calling isSensitivePath so a
 * symlink pointing at a sensitive target is also caught.
 */

import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { getDataDir } from '../config/instance.js';

// Runtime JSON contains credentials, private prompts, or owner-scoped state.
// Include atomic-write siblings and state backups: their payload is identical.
const PRIVATE_RUNTIME_FILE =
  /^(?:hook-secret|state[^/]*\.json|(?:users|settings|push-keys|push-subscriptions|subscription-profiles|custom-model-hosts|webhook|webviews|remote-hosts|remote-cases|docker-hosts|docker-cases|intents|external-chat|embassy-guest|chatrooms|company|company-research|mux-sessions|subagent-parents|subagent-window-states|linked-cases|clis|plan-usage-history|docker-env-applied|update-status)\.json)(?:\.(?:bak|[^/]*tmp))?$/;
// The append-only audit logs hold deleted message text and reports.
const PRIVATE_RUNTIME_LOG = /^(?:chatrooms\.json\.audit|admin-audit)\.jsonl(?:\.(?:bak|[^/]*tmp))?$/;
// chatroom-files-deleted holds the files of deleted channels (kept for the audit log, never cleaned up automatically).
const PRIVATE_RUNTIME_TREE =
  /^(?:certs|accounts|embassy-guest|docker-seeds|cred-seeds|custom-model-configs|chatroom-files-deleted)(?:\/|$)/;

function isPrivateRuntimeMember(member: string): boolean {
  return PRIVATE_RUNTIME_FILE.test(member) || PRIVATE_RUNTIME_LOG.test(member) || PRIVATE_RUNTIME_TREE.test(member);
}

const SENSITIVE_PATTERNS: RegExp[] = [
  // System account databases.
  /^\/etc\/shadow$/,
  /^\/etc\/gshadow$/,
  /^\/etc\/master\.passwd$/,

  // SSH and GPG private key material. `.ssh/` is matched at any depth rather
  // than only under homedir(): a per-project or per-deploy key directory holds
  // exactly the same secret, and it drops a homedir() read that is captured at
  // module load and therefore wrong for anything that changes HOME later.
  /\/\.ssh\//,
  /\/\.gnupg\//,

  // Dotenv, in every conventional spelling (.env, .env.local, .env.production).
  /\/\.env$/,
  /\/\.env\./,

  // Generic credential files, plus the per-vendor spellings that do not match it.
  /\/credentials(\.json|\.yml|\.yaml|\.xml|\.toml|\.db)?$/i,
  /\/\.aws\/(credentials|config)$/,
  /\/\.aws\/sso\/cache\//,
  /\/\.gcloud\/credentials\.db$/,
  /\/\.config\/gcloud\//,
  /\/\.azure\//,
  /\/\.docker\/config\.json$/,
  /\/\.kube\/config$/,

  // Package-registry and forge tokens. Each of these is a bearer credential in
  // a plain-text dotfile, which is exactly what a path picker will surface.
  /\/\.npmrc$/,
  /\/\.yarnrc\.yml$/,
  /\/\.git-credentials$/,
  /\/\.config\/gh\//,
  /\/\.config\/hub$/,
  /\/\.netrc$/,
  /\/_netrc$/,
  /\/\.pypirc$/,
  /\/\.gem\/credentials$/,
  /\/\.cargo\/credentials(\.toml)?$/,
  /\/\.terraformrc$/,
  /\/\.terraform\.d\//,

  // Database client credentials.
  /\/\.pgpass$/,
  /\/\.my\.cnf$/,

  // Agent CLI credential. Runtime-instance members are checked below.
  /\/\.claude\/\.credentials\.json$/,
];

/**
 * Claude config members that are credential-bearing ONLY under the user's real
 * home directory: `~/.claude/settings.json` can hold `env.ANTHROPIC_API_KEY`
 * and `apiKeyHelper` by schema (settings.local.json shares that schema), and
 * `~/.claude.json` holds account/OAuth-adjacent state. A blanket
 * `/\.claude\/settings\.json$/` would also block every CASE-level
 * `.claude/settings.json`, which users legitimately view and edit in the File
 * Viewer (model override, hooks) — so these are anchored to homedir(), read at
 * CHECK time inside isSensitivePath, never captured at module load (wrong for
 * anything that changes HOME later, e.g. per-file test fixtures — same
 * reasoning as the `.ssh/` note above).
 */
const HOME_SENSITIVE_MEMBERS = ['.claude.json', '.claude/settings.json', '.claude/settings.local.json'];

/**
 * Returns true if the given ABSOLUTE, symlink-resolved path matches the
 * sensitive-file blocklist and must not be served to the browser.
 */
export function isSensitivePath(absPath: string): boolean {
  if (isSensitivePathAt(absPath, [])) return true;
  const dataDir = resolve(getDataDir());
  let resolvedDataDir = dataDir;
  try {
    resolvedDataDir = realpathSync(dataDir);
  } catch {
    /* A not-yet-created store still has a protected lexical path. */
  }
  return isSensitivePathAt(absPath, [dataDir, resolvedDataDir]);
}

/** Pure counterpart for bounded async callers; roots must already be resolved by the caller. */
export function isSensitivePathAt(absPath: string, dataRoots: readonly string[]): boolean {
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(absPath))) return true;
  // Keep legacy/default/named-instance protections even when those stores are
  // not the currently selected instance (also applies to remote file paths).
  for (const match of absPath.matchAll(/\/\.reverie[^/]*(?=\/)/g)) {
    if (isPrivateRuntimeMember(absPath.slice(match.index + match[0].length + 1))) return true;
  }
  // A configured data directory need not have a recognizable name. Compare its
  // resolved location too, since callers resolve the requested file first.
  if (dataRoots.some((root) => isPrivateRuntimeMember(relative(root, absPath)))) return true;
  const home = homedir();
  return HOME_SENSITIVE_MEMBERS.some((member) => absPath === join(home, member));
}
