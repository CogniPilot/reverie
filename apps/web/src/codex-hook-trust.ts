/**
 * Launch-only trust for Reverie's own Codex hooks.
 *
 * Codex asks "Hooks need review" for every project hook whose content has no matching trusted hash in the user config or
 * the launch flags. Reverie writes its own handlers into the workspace's .codex/hooks.json, so a returned seat stopped on
 * that prompt with nobody at the keyboard. This pins trust for exactly those handlers: each one found in the file is
 * hashed the way Codex hashes it, and only a handler whose hash equals one Reverie generates gets a trusted_hash entry,
 * as a --config flag for this launch. Any other or edited handler keeps Codex's normal prompt, and nothing is written to
 * Codex's config or the workspace.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { generateCodexTurnSummaryHooks } from './hooks-config.js';

/** Codex's config-state label for each hooks.json event name (codex-rs hooks/src/lib.rs hook_event_key_label). */
const EVENT_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  Interrupt: 'interrupt',
};

const MAX_HOOKS_FILE_BYTES = 1024 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key]!)]));
  }
  return value;
}

/**
 * Codex's hash of one command handler (codex-rs hooks/src/engine/discovery.rs hook_hash, config fingerprint
 * version_for_toml): sha256 over the key-sorted JSON of {event_name, matcher?, hooks: [normalized handler]}. Only
 * handlers Reverie itself generates need to hash right, since anything else must keep prompting. Returns null for a
 * handler shape this does not model, which then simply gets no trust.
 */
export function codexHookHash(event: string, matcher: unknown, handler: unknown): string | null {
  const label = EVENT_LABELS[event];
  if (!label || !handler || typeof handler !== 'object' || Array.isArray(handler)) return null;
  const h = handler as Record<string, unknown>;
  if (h.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) return null;
  if ('commandWindows' in h || 'command_windows' in h || 'additionalContextLimit' in h || 'env' in h) return null;
  if (h.timeout !== undefined && !(Number.isSafeInteger(h.timeout) && (h.timeout as number) >= 0)) return null;
  if (h.async !== undefined && typeof h.async !== 'boolean') return null;
  if (h.statusMessage !== undefined && typeof h.statusMessage !== 'string') return null;
  if (event === 'SessionEnd' || event === 'Interrupt') return null;
  if (matcher !== undefined && matcher !== null && typeof matcher !== 'string') return null;
  const normalized: Record<string, Json> = {
    type: 'command',
    command: h.command,
    timeout: Math.max(1, (h.timeout as number | undefined) ?? 600),
    async: h.async === true,
  };
  if (typeof h.statusMessage === 'string') normalized.statusMessage = h.statusMessage;
  const identity: Record<string, Json> = { event_name: label, hooks: [normalized] };
  if (typeof matcher === 'string') identity.matcher = matcher;
  return 'sha256:' + createHash('sha256').update(JSON.stringify(sorted(identity))).digest('hex');
}

/** The hashes of the handlers Reverie installs, per hooks.json event name. */
export function reverieCodexHookHashes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [event, groups] of Object.entries(generateCodexTurnSummaryHooks().hooks)) {
    for (const group of groups as Array<{ matcher?: unknown; hooks?: unknown[] }>) {
      for (const handler of group.hooks ?? []) {
        const hash = codexHookHash(event, group.matcher, handler);
        if (hash) out.set(event, (out.get(event) ?? new Set()).add(hash));
      }
    }
  }
  return out;
}

/**
 * The trusted_hash entries for the Reverie handlers present in `<workingDir>/.codex/hooks.json`, keyed the way Codex
 * keys hook state (`<hooks.json path>:<event label>:<group index>:<handler index>`). Codex keys by the path it was
 * started in, so both the working directory and its resolved path are covered when they differ. Empty when the file is
 * absent, unreadable, a symlink or malformed.
 */
export async function reverieCodexHookTrust(workingDir: string): Promise<Record<string, string>> {
  if (!isAbsolute(workingDir)) return {};
  const hooksPath = join(workingDir, '.codex', 'hooks.json');
  let text: string;
  try {
    const dir = await lstat(join(workingDir, '.codex'));
    const file = await lstat(hooksPath);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > MAX_HOOKS_FILE_BYTES) return {};
    text = await readFile(hooksPath, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  const events = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!events || typeof events !== 'object' || Array.isArray(events)) return {};
  const ours = reverieCodexHookHashes();
  const roots = [workingDir];
  try {
    const real = await realpath(workingDir);
    if (real !== workingDir) roots.push(real);
  } catch { /* the unresolved path is still the one Codex was started in */ }
  const trust: Record<string, string> = {};
  for (const [event, groups] of Object.entries(events as Record<string, unknown>)) {
    const label = EVENT_LABELS[event];
    if (!label || !Array.isArray(groups)) continue;
    groups.forEach((group: unknown, g) => {
      if (!group || typeof group !== 'object') return;
      const { matcher, hooks } = group as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(hooks)) return;
      hooks.forEach((handler, h) => {
        const hash = codexHookHash(event, matcher, handler);
        if (!hash || !ours.get(event)?.has(hash)) return;
        for (const root of roots) trust[`${join(root, '.codex', 'hooks.json')}:${label}:${g}:${h}`] = hash;
      });
    });
  }
  return trust;
}

/** One shell-escaped --config value: an inline hooks.state table (dotted override keys would split the path keys). */
export function codexHookTrustArgument(trust: Record<string, string>): string | undefined {
  const entries = Object.entries(trust).filter(([key, hash]) => !/[\0\r\n]/.test(key) && /^sha256:[0-9a-f]{64}$/.test(hash));
  if (!entries.length) return undefined;
  const value = `hooks.state={${entries.map(([key, hash]) => `${JSON.stringify(key)}={trusted_hash=${JSON.stringify(hash)}}`).join(',')}}`;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
