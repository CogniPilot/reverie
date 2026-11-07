/**
 * @fileoverview The read-only agent profile report behind `GET /api/agents/:id/profile`, built in
 * the console from its own session, company and room state instead of a `reverie-runtime profile`
 * subprocess that called this same server back over HTTP.
 *
 * The report keeps the runtime's shape and rules: the observed effort comes from the newest record
 * in the tail of the session's agent CLI transcript; the runtime supervision section and the
 * owner-selected persona are read only when the server environment names a runtime policy
 * (REVERIE_RUNTIME_POLICY), with instance configs confined to that policy's `instances_dir`.
 * Files are read without following a final symlink, never from a FIFO or device, and with fixed
 * size bounds.
 */

import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** What a report may include: direct-message rooms only for the owner. */
export interface ProfileView {
  includeDms: boolean;
}

export interface ProfileEmployee {
  id?: unknown;
  name?: unknown;
  icon?: unknown;
  position?: unknown;
  expertise?: unknown;
  sessionId?: unknown;
}

export interface ProfileRoom {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  members?: ReadonlyArray<{ sessionId?: unknown; role?: unknown }>;
}

/** The console state a report reads besides the session itself. */
export interface ProfileSources {
  employees(): readonly ProfileEmployee[];
  rooms(): readonly ProfileRoom[];
  /** The agent CLI's `projects` directory, where transcripts live. */
  transcriptProjectsDir: string;
  /** The runtime policy file, if the server environment names one. */
  runtimePolicy?: string;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
export const MARKER_BYTES = 4096;
export const INSTANCE_BYTES = 64 * 1024;
export const PERSONA_CHARS = 2000;
/** Upper bound for the runtime policy and its supervisor state file. */
export const POLICY_BYTES = 1024 * 1024;
const SWITCH = {
  available: false,
  reason: 'switching a backend is an owner action; it waits for owner authentication',
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const get = (object: unknown, key: string): unknown => (isObject(object) ? object[key] : undefined);
/** `dict.get(key)` with JSON `null` for a missing key. */
const field = (object: unknown, key: string): unknown => get(object, key) ?? null;
/** Python truthiness of a decoded JSON value. */
const truthy = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : !!value;

/**
 * At most `limit` bytes of a regular file (the last ones with `fromEnd`). A symlink as the last
 * path component, a FIFO or a device is refused, so an agent-writable path can never block the
 * caller or stream without end.
 */
export function readRegular(path: string, limit: number, fromEnd = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
    const start = fromEnd ? Math.max(0, info.size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, info.size - start)));
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * The effort level of the newest record in an agent CLI transcript that names one, or null.
 * The CLI writes each turn's effort into its transcript; the console only knows the
 * spawn-time default, which /effort can change in the session. Reads the file's tail only.
 */
export function observedEffort(conversation: unknown, projects: string): { level: string; at: string | null } | null {
  if (typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation)) return null;
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const project of readdirSync(projects)) {
      const path = join(projects, project, `${conversation}.jsonl`);
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (!newest || mtime >= newest.mtime) newest = { path, mtime };
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  let data: Buffer;
  try {
    data = readRegular(newest.path, TRANSCRIPT_TAIL_BYTES, true);
  } catch {
    return null;
  }
  // The first line after the seek may be cut; it just fails to parse.
  const lines = data.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const effort = get(record, 'effort');
    if (typeof effort === 'string' && EFFORT_LEVELS.has(effort)) {
      const at = get(record, 'timestamp');
      return { level: effort, at: typeof at === 'string' && [...at].length <= 64 ? at : null };
    }
  }
  return null;
}

/** The runtime policy and its supervisor state, read as the runtime itself validates them. */
interface Runtime {
  dir: string;
  policy: Json;
  state: Json;
}

/** A bounded JSON read: `readRegular` (no final symlink, no FIFO or device) refusing oversize files. */
function readJson(path: string): unknown {
  const data = readRegular(path, POLICY_BYTES + 1);
  if (data.length > POLICY_BYTES) throw new Error(`file too large: ${path}`);
  return JSON.parse(data.toString('utf8'));
}

function loadRuntime(policyPath: string): Runtime {
  const resolved = realpathSync(policyPath.startsWith('~/') ? join(homedir(), policyPath.slice(2)) : policyPath);
  const policy = readJson(resolved);
  if (!isObject(policy)) throw new Error('runtime policy must be an object');
  const dir = dirname(resolved);
  const stateFile = get(policy, 'state_file');
  if (typeof stateFile !== 'string') throw new Error('runtime policy requires state_file');
  // The supervisor state is agent-writable: anything but a readable, bounded regular file (missing,
  // a symlink, a FIFO, oversize or malformed) reads as no supervised session, never a stalled server.
  let state: unknown = {};
  try {
    state = readJson(resolvePolicyPath(dir, stateFile));
  } catch {
    state = {};
  }
  const backends = get(policy, 'backends');
  const fallback = get(policy, 'fallback');
  const chosen = typeof fallback === 'string' ? get(backends, fallback) : undefined;
  if (!isObject(chosen) || !truthy(chosen.enabled)) throw new Error('an enabled local fallback is required');
  if (chosen.mode !== 'opencode') throw new Error('the fallback must use the local OpenCode adapter');
  return { dir, policy, state: isObject(state) ? state : {} };
}

/**
 * Python's non-strict `Path.resolve()`: symlinks in the longest existing prefix are resolved and
 * the missing rest is appended, so a path to a file that does not exist still resolves.
 */
function resolveLoose(path: string): string {
  const missing: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...missing.reverse());
    } catch {
      if (dirname(at) === at) return resolve(path);
      missing.push(at.slice(dirname(at).length).replace(/^[/\\]/, ''));
    }
  }
}

/** A policy path: absolute paths stay as written; relative ones resolve against the policy's directory. */
function resolvePolicyPath(dir: string, value: string): string {
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolveLoose(join(dir, expanded));
}

/**
 * The resolved path if it lies strictly inside the policy's `instances_dir`, else null. Agents run
 * as the same user that owns the marker and the policy, so neither is trusted to name a file
 * outside the owner's instance configs. Without `instances_dir` nothing is.
 */
function insideInstancesDir(runtime: Runtime, path: string): string | null {
  const instances = get(runtime.policy, 'instances_dir');
  if (typeof instances !== 'string' || !instances) return null;
  const real = resolveLoose(path);
  const root = resolvePolicyPath(runtime.dir, instances);
  return real.startsWith(root.endsWith(sep) ? root : root + sep) ? real : null;
}

/**
 * The owner-selected instance config of a session: the supervised runtime's own workspace marker,
 * else the policy's `agent_instances` map. A shared working dir is not identity, so the marker
 * counts only for the session the supervisor tracks as current.
 */
function instanceFor(runtime: Runtime, sessionId: string, live: Json): string | null {
  if (sessionId === runtime.state.current) {
    const workspace = live.workingDir;
    if (typeof workspace === 'string' && isAbsolute(workspace)) {
      try {
        const data = readRegular(join(workspace, '.reverie-instance'), MARKER_BYTES + 1);
        if (data.length <= MARKER_BYTES) {
          const instance = get(JSON.parse(data.toString('utf8')), 'instance');
          const named =
            typeof instance === 'string' && instance ? insideInstancesDir(runtime, resolve(workspace, instance)) : null;
          if (named) return named;
        }
      } catch {
        // An unreadable or malformed marker names nothing.
      }
    }
  }
  const mapped = get(get(runtime.policy, 'agent_instances'), sessionId);
  return typeof mapped === 'string' && mapped
    ? insideInstancesDir(runtime, resolvePolicyPath(runtime.dir, mapped))
    : null;
}

const INSTANCE_FIELDS = new Set([
  'id',
  'agent_name',
  'owner_name',
  'data_dir',
  'persona',
  'initial_self',
  'role',
  'kind',
  'shared_room_tone',
  'employee_id',
]);

/** The persona fields of an instance config, validated like the runtime's instance loader. */
export function parseInstance(
  text: string,
  path: string
): { agent_name: string; role: string; kind: string; persona: string } {
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw) || Object.keys(raw).some((key) => !INSTANCE_FIELDS.has(key)))
    throw new Error('instance config must be an object with supported fields only');
  for (const key of ['id', 'agent_name', 'owner_name', 'data_dir', 'persona']) {
    const value = raw[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`instance config requires nonempty ${key}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(raw.id as string)) throw new Error('invalid instance id');
  const state = resolvePolicyPath(dirname(path), raw.data_dir as string);
  const parents: string[] = [];
  for (let at = dirname(path); ; at = dirname(at)) {
    parents.push(at);
    if (dirname(at) === at) break;
  }
  if (parents.includes(resolve(state))) throw new Error('instance data_dir must be a separate state directory');
  const initial = raw.initial_self;
  if (
    initial !== undefined &&
    initial !== null &&
    (!isObject(initial) ||
      typeof initial.consciousness !== 'string' ||
      !Array.isArray(initial.directives) ||
      initial.directives.some((item) => typeof item !== 'string' || !item.trim()))
  )
    throw new Error('initial_self requires a consciousness statement and directive strings');
  const kind = 'kind' in raw ? raw.kind : 'agent';
  if (typeof kind !== 'string' || !['cto', 'agent', 'expert', 'implementer'].includes(kind))
    throw new Error('invalid agent kind');
  const role = 'role' in raw ? raw.role : 'Expert';
  if (typeof role !== 'string' || !role.trim()) throw new Error('role must be nonempty text');
  const tone = 'shared_room_tone' in raw ? raw.shared_room_tone : 'professional';
  if (tone !== 'professional' && tone !== 'social') throw new Error('shared_room_tone must be professional or social');
  if (
    'employee_id' in raw &&
    !(typeof raw.employee_id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(raw.employee_id))
  )
    throw new Error('employee_id must be a lowercase UUID');
  return { agent_name: raw.agent_name as string, role, kind, persona: raw.persona as string };
}

function persona(runtime: Runtime | null, sessionId: string, live: Json): Json | null {
  const source = runtime ? instanceFor(runtime, sessionId, live) : null;
  if (!source) return null;
  try {
    const data = readRegular(source, INSTANCE_BYTES + 1);
    if (data.length > INSTANCE_BYTES) throw new Error('instance config too large');
    const instance = parseInstance(data.toString('utf8'), source);
    return { ...instance, persona: [...instance.persona].slice(0, PERSONA_CHARS).join(''), source };
  } catch {
    return { error: 'instance config unreadable', source };
  }
}

function runtimeSection(runtime: Runtime | null, sessionId: string): Json {
  const supervised = !!runtime && sessionId === runtime.state.current;
  const backends = supervised ? get(runtime.policy, 'backends') : undefined;
  return {
    supervised,
    backend: supervised ? field(runtime.state, 'backend') : null,
    phase: supervised ? field(runtime.state, 'phase') : null,
    backends: isObject(backends)
      ? Object.entries(backends).map(([name, backend]) => ({
          name,
          mode: field(backend, 'mode'),
          model: field(backend, 'model'),
          enabled: truthy(get(backend, 'enabled')),
        }))
      : [],
    switch: SWITCH,
  };
}

/**
 * Builds one session's read-only profile: backend, model, effort, usage counters, company and room
 * bindings, runtime supervision and the owner-selected persona, from the session's light state (as
 * `GET /api/sessions/:id` returns it). Throws for an invalid session id
 * or an unusable runtime policy; the route reports either as a failed profile.
 */
export function buildProfile(sources: ProfileSources, sessionId: string, state: unknown, view: ProfileView): Json {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id');
  const live: Json = isObject(get(state, 'session')) ? (get(state, 'session') as Json) : isObject(state) ? state : {};
  let display = get(live, 'displayModel');
  display = isObject(display) ? display.model : display;
  const chain = truthy(live.claudeSessionChain)
    ? (live.claudeSessionChain as unknown[])
    : truthy(live.claudeSessionId)
      ? [live.claudeSessionId]
      : [];
  const tokens = isObject(live.tokens) ? live.tokens : {};
  const runtime = sources.runtimePolicy ? loadRuntime(sources.runtimePolicy) : null;
  const employee = sources.employees().find((e) => e.sessionId === sessionId);
  return {
    session: {
      id: live.id ?? sessionId,
      name: field(live, 'name'),
      status: field(live, 'status'),
      alive: live.pid !== undefined && live.pid !== null && !truthy(live.paneExit),
      pinned: truthy(live.pinned),
      created_at: field(live, 'createdAt'),
      last_activity_at: field(live, 'lastActivityAt'),
      working_dir: field(live, 'workingDir'),
    },
    backend: {
      mode: field(live, 'mode'),
      model: truthy(live.model) ? live.model : (display ?? null),
      display_model: display ?? null,
    },
    effort: {
      configured: field(live, 'effort'),
      observed:
        live.mode === 'claude' && chain.length
          ? observedEffort(chain[chain.length - 1], sources.transcriptProjectsDir)
          : null,
    },
    usage: {
      input_tokens: ('input' in tokens ? tokens.input : live.inputTokens) ?? null,
      output_tokens: ('output' in tokens ? tokens.output : live.outputTokens) ?? null,
      total_tokens: field(tokens, 'total'),
      cost: field(live, 'totalCost'),
      messages: field(live, 'messageCount'),
      scope: 'console counters for this session since created_at; no per-day history is recorded yet',
    },
    employee: employee
      ? {
          id: field(employee, 'id'),
          name: field(employee, 'name'),
          icon: field(employee, 'icon'),
          position: field(employee, 'position'),
          expertise: field(employee, 'expertise'),
        }
      : null,
    rooms: sources
      .rooms()
      .filter(
        (room) => (room.members ?? []).some((m) => m.sessionId === sessionId) && (view.includeDms || room.kind !== 'dm')
      )
      .map((room) => ({
        id: field(room, 'id'),
        name: field(room, 'name'),
        role: (room.members ?? []).find((m) => m.sessionId === sessionId)?.role ?? null,
      })),
    runtime: runtimeSection(runtime, sessionId),
    persona: persona(runtime, sessionId, live),
    note: 'read-only profile; nothing was changed',
  };
}

/** The agent CLI's transcript projects directory for this server, from its config directory variable. */
export function transcriptProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}
