/**
 * @fileoverview Reverie runs every agent with full access inside its container.
 *
 * A CLI's approval bypass is a launch param (codex `--dangerously-bypass-approvals-and-sandbox`),
 * so a session created, moved or relaunched without it starts with approval prompts on and
 * stalls on the first command. Inside the reverie container (`REVERIE_CONTAINER=1`, or the older
 * `REVERIE_CONTAINER=1`) the bypass is therefore the default: every boolean param a CLI entry
 * lists in `privilegedParams` with `clampTo: false` is filled with `true` where the session's
 * config leaves it unset.
 *
 * - An explicit `false` is kept (an owner who turned prompts on keeps them).
 * - A non-granted owner gets nothing: `canUsernameRunPrivilegedCommands()` is the same check
 *   the create-time clamp uses, so the default never hands back what the clamp removes.
 * - Outside the container nothing changes.
 *
 * Two CLIs keep their bypass outside `privilegedParams`:
 * - claude: the global `claudeMode` (default `dangerously-skip-permissions`, owner-clamped by
 *   `resolveClaudeModeForUsername`) becomes `--dangerously-skip-permissions`; nothing to fill,
 *   but the launch check expects that flag when the session's mode asks for it.
 * - opencode: `openCodeConfig.autoAllowTools` makes the console send `permission: {"*": "allow"}`
 *   in OPENCODE_CONFIG_CONTENT. It is filled like a bypass switch, unless the session's own
 *   `configContent` already sets a `permission` (an owner policy is kept). OpenCode has no argv
 *   flag, so the launch check cannot see it.
 *
 * The filled config is stored on the session, so the persisted row and every later relaunch
 * carry it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { getCli } from './config/cli-registry/registry.js';
import type { ClaudeMode } from './types/session.js';
import { canUsernameRunPrivilegedCommands } from './user-store.js';
import { envValue } from './config/reverie-env.js';

/** True when this console runs inside the reverie container. */
export function fullAccessByDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return envValue(env, 'CONTAINER') === '1';
}

/** The wire keys (legacy config names) of `mode`'s bypass switches, e.g. `dangerouslyBypassApprovals` for codex. */
export function fullAccessKeys(mode: string): string[] {
  const entry = getCli(mode);
  if (!entry?.launch.legacyConfigField) return [];
  const aliases = entry.launch.legacyConfigAliases ?? {};
  return entry.capabilities.privilegedParams
    .filter(({ param, clampTo }) => clampTo === false && entry.launch.params?.[param]?.type === 'bool')
    .map(({ param }) => aliases[param] ?? param);
}

/** Bypass switches kept outside `privilegedParams`, by mode (see the file comment). */
const EXTRA_FULL_ACCESS_KEYS: Record<string, string[]> = { opencode: ['autoAllowTools'] };

/** An opencode `configContent` that sets its own `permission`: the owner chose a policy, so it is not replaced. */
function ownsPermission(config: Record<string, unknown> | undefined): boolean {
  const content = config?.configContent;
  if (typeof content !== 'string') return false;
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null && 'permission' in parsed;
  } catch {
    return false;
  }
}

/**
 * `config` with every unset bypass switch of `mode` turned on, or `undefined` when nothing
 * changes (not in the container, the owner is not granted, the CLI has no switch, or every
 * switch is already set either way).
 */
export async function withFullAccessDefault<T extends object>(
  mode: string,
  config: T | undefined,
  owner: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<T | undefined> {
  if (!fullAccessByDefault(env)) return undefined;
  const values = config as Record<string, unknown> | undefined;
  const extra = ownsPermission(values) ? [] : (EXTRA_FULL_ACCESS_KEYS[mode] ?? []);
  const keys = [...fullAccessKeys(mode), ...extra].filter((key) => values?.[key] === undefined);
  if (keys.length === 0) return undefined;
  if (!(await canUsernameRunPrivilegedCommands(owner))) return undefined;
  return { ...(config ?? {}), ...Object.fromEntries(keys.map((key) => [key, true])) } as T;
}

/** claude's bypass flag, which tmux-manager builds from `claudeMode` rather than the registry. */
export const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';

/**
 * The registry flags that must appear on the launched command line for `mode`'s bypass switches.
 * A switch the session's `config` sets to `false` expects no flag. For claude, `claudeMode`
 * (the session's resolved mode) expects the bypass flag only when it is the bypass mode.
 */
export function fullAccessFlags(mode: string, config?: object, claudeMode?: ClaudeMode): string[] {
  if (mode === 'claude') return claudeMode === 'dangerously-skip-permissions' ? [CLAUDE_BYPASS_FLAG] : [];
  const entry = getCli(mode);
  if (!entry) return [];
  const aliases = entry.launch.legacyConfigAliases ?? {};
  const values = (config ?? {}) as Record<string, unknown>;
  const params = new Set(
    entry.capabilities.privilegedParams
      .filter(({ param, clampTo }) => clampTo === false && values[aliases[param] ?? param] !== false)
      .map(({ param }) => param)
  );
  const flags: string[] = [];
  for (const variant of entry.launch.variants ?? []) {
    for (const arg of variant.args as Array<{ flag?: string; value?: string; when?: { param?: string; is?: unknown } }>) {
      if (arg.flag && arg.value === undefined && arg.when?.is === true && params.has(arg.when.param ?? '')) flags.push(arg.flag);
    }
  }
  return [...new Set(flags)];
}

/** How the process table is read; `/proc` by default, a fake in tests. */
export interface ProcessTable {
  pids(): number[];
  ppid(pid: number): number | undefined;
  argv(pid: number): string[];
}

export const procTable: ProcessTable = {
  pids: () => readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number),
  ppid: (pid) => {
    try {
      // Field 4 of /proc/PID/stat, counted after the parenthesised command name (which may hold spaces).
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      return Number.isInteger(ppid) ? ppid : undefined;
    } catch {
      return undefined;
    }
  },
  argv: (pid) => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
};

/**
 * The argv of `root` and every process below it. The pane process tmux reports is usually the
 * `bash -c` launcher, and the CLI runs as its child (often under a node wrapper), so the flag
 * is looked for on the real CLI processes, not on the pane's own command string.
 */
export function processTreeArgv(root: number, table: ProcessTable = procTable): string[][] {
  const children = new Map<number, number[]>();
  for (const pid of table.pids()) {
    const parent = table.ppid(pid);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const result: string[][] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      result.push(table.argv(pid));
    } catch {
      continue; // exited between the scan and the read
    }
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

/** Interpreters an npm-installed CLI runs under: `node /usr/local/bin/codex ...`. */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno']);

/**
 * Whether `argv` is `mode`'s CLI itself: its executable is one of the registry's binaries
 * (`/usr/local/lib/codex/codex`), or an interpreter runs a script named after one
 * (`node /usr/local/bin/codex`, `node .../codex.js`). A helper or launcher is not.
 */
export function isCliProcess(argv: string[], binaries: string[]): boolean {
  const name = (path: string | undefined) => (path ? basename(path).replace(/\.(c|m)?js$/, '') : '');
  if (binaries.includes(name(argv[0]))) return true;
  return INTERPRETERS.has(basename(argv[0] ?? '')) && binaries.includes(name(argv[1]));
}

export interface FullAccessCheck {
  /** Expected flags not on every CLI process (all of them when no CLI process was found). */
  missing: string[];
  /** 'ok'; 'flags': a CLI process lacks one; 'no-cli': nothing in the tree is the CLI; 'gone': the pane process is gone. */
  reason: 'ok' | 'flags' | 'no-cli' | 'gone';
}

/**
 * Check the launched CLI for its bypass flags. Only processes in the pane's tree (`pid` and its
 * descendants) that ARE the CLI count (`isCliProcess`), and each of them must carry every
 * expected flag as a whole argv entry: a flag inside a `bash -c` string or on an unrelated
 * helper does not count. No CLI process in the tree fails closed (every flag missing, 'no-cli').
 * A gone pane process says nothing. `config` is the session's config for `mode`; a switch it
 * sets to `false` is not expected. `claudeMode` is the session's resolved claude mode.
 */
export function checkFullAccessFlags(
  mode: string,
  pid: number,
  config?: object,
  table: ProcessTable = procTable,
  claudeMode?: ClaudeMode
): FullAccessCheck {
  const flags = fullAccessFlags(mode, config, claudeMode);
  if (flags.length === 0) return { missing: [], reason: 'ok' };
  let tree: string[][];
  try {
    tree = processTreeArgv(pid, table);
  } catch {
    return { missing: [], reason: 'gone' };
  }
  if (tree.length === 0) return { missing: [], reason: 'gone' };
  const binaries = getCli(mode)?.discovery.binaries ?? [];
  const clis = tree.filter((argv) => isCliProcess(argv, binaries));
  if (clis.length === 0) return { missing: flags, reason: 'no-cli' };
  const missing = flags.filter((flag) => !clis.every((argv) => argv.includes(flag)));
  return { missing, reason: missing.length ? 'flags' : 'ok' };
}

/** The flags `checkFullAccessFlags` reports missing. */
export function missingFullAccessFlags(
  mode: string,
  pid: number,
  config?: object,
  table: ProcessTable = procTable,
  claudeMode?: ClaudeMode
): string[] {
  return checkFullAccessFlags(mode, pid, config, table, claudeMode).missing;
}

/**
 * The #reverie room a full-access alert for a session goes to: only a room of the
 * session's own owner (both unset in single-user mode), never another owner's room.
 */
export function fullAccessAlertRoom<R extends { kind?: string; name: string; owner?: string }>(
  rooms: readonly R[],
  owner: string | undefined
): R | undefined {
  return rooms.find((r) => r.kind !== 'dm' && r.owner === owner && r.name.trim().toLowerCase() === 'reverie');
}
