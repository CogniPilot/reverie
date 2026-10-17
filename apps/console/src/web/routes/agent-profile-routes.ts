/**
 * @fileoverview `GET /api/agents/:id/profile`: one agent session's read-only profile for the
 * profile panel: backend, model, effort, usage counters, company and room bindings, runtime
 * supervision and the owner-selected persona. The fleet runtime builds it
 * (`fleet-runtime --policy POLICY profile ID`), so the console and the runtime's own identity
 * checks report the same thing.
 *
 * Read-only: the report makes GET calls and local reads only, and lists backend switching as
 * unavailable until owner authentication exists. Enabled when the server's environment names the
 * runtime policy (FLEET_RUNTIME_POLICY); `fleet-runtime` comes from PATH unless FLEET_RUNTIME_BIN
 * names it. Configuration is environment-only, never a settings key, so no API call can choose what
 * this route runs. Single-user only: the report reads the console as its owner. Ownership of the
 * session itself goes through `findSessionOrFail`, like every session-scoped route; an agent caller
 * may read only its own profile, without direct-message rooms. Reports are cached for 15 s, and at most
 * two run at once.
 */

import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { SessionPort } from '../ports/session-port.js';
import { findSessionOrFail, ownerFor, resolveParentSessionId } from '../route-helpers.js';

/** What a report may include: direct-message rooms only for the owner. */
export interface ProfileView {
  includeDms: boolean;
}

/** Runs the runtime's profile report for one session and returns its stdout (a JSON object). */
export type ProfileRunner = (sessionId: string, view: ProfileView) => Promise<string>;

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Reports running at once, server-wide; more requests wait their turn. */
export const MAX_CONCURRENT_REPORTS = 2;
/** How long a finished report is reused for the same session and view. */
export const CACHE_MS = 15_000;

/**
 * What the runtime process inherits, by exact name: the lookup path, home and locale, its policy
 * file, the console address and the Claude config directory (where transcripts live). No prefix
 * wildcard, no API keys and, until the enforce service token is added by name, no console
 * credentials (CODEMAN_USERNAME, CODEMAN_PASSWORD).
 */
const CHILD_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'LANG',
  'CLAUDE_CONFIG_DIR',
  'FLEET_RUNTIME_POLICY',
  'CODEMAN_API_URL',
]);

/**
 * The report reads the console as the owner this route serves, never as some agent's parent
 * session, so CODEMAN_SESSION_ID is not in the list.
 */
export function profileChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (CHILD_ENV_NAMES.has(name) || name.startsWith('LC_'))) out[name] = value;
  }
  return out;
}

export function profileRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): ProfileRunner | null {
  const policy = env.FLEET_RUNTIME_POLICY;
  if (!policy) return null;
  const bin = env.FLEET_RUNTIME_BIN || 'fleet-runtime';
  const childEnv = profileChildEnv(env);
  return (sessionId, view) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        ['--policy', policy, 'profile', sessionId, ...(view.includeDms ? [] : ['--no-dms'])],
        { env: childEnv, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout) => {
          // Exit 1 still prints a JSON {error} report; only a missing report is a failure here.
          if (error && !stdout) reject(error);
          else resolve(String(stdout));
        }
      );
    });
}

export function registerAgentProfileRoutes(
  app: FastifyInstance,
  ctx: SessionPort,
  runner: ProfileRunner | null = profileRunnerFromEnv(),
  now: () => number = Date.now
): void {
  // A panel opened twice, or polled, shares one report; finished reports are reused briefly; and at
  // most MAX_CONCURRENT_REPORTS processes run at once, so a burst over many sessions queues.
  const inFlight = new Map<string, Promise<string>>();
  const cache = new Map<string, { at: number; stdout: string }>();
  let running = 0;
  const waiting: Array<() => void> = [];
  const limited = async (work: () => Promise<string>): Promise<string> => {
    if (running >= MAX_CONCURRENT_REPORTS) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };

  app.get('/api/agents/:id/profile', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    if (isMultiUserMode()) {
      return reply
        .code(501)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Agent profiles are available in single-user mode only')
        );
    }
    // The owner (no parent-session header) reads any profile. An agent reads only its own, without
    // its direct-message rooms; any other header, resolvable or not, is refused.
    const owner = req.headers['x-codeman-parent-session'] === undefined;
    if (!owner && resolveParentSessionId(ctx, req, undefined, ownerFor(req)) !== session.id) {
      return reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'An agent may read only its own profile'));
    }
    if (!runner) {
      return reply
        .code(503)
        .send(
          createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            'Agent profiles are not configured on this server (set FLEET_RUNTIME_POLICY)'
          )
        );
    }
    const view: ProfileView = { includeDms: owner };
    const key = `${session.id}\n${view.includeDms}`;
    const cached = cache.get(key);
    let stdout: string | undefined = cached && now() - cached.at < CACHE_MS ? cached.stdout : undefined;
    if (stdout === undefined) {
      let pending = inFlight.get(key);
      if (!pending) {
        pending = limited(() => runner(session.id, view))
          .then((out) => {
            cache.set(key, { at: now(), stdout: out });
            return out;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      try {
        stdout = await pending;
      } catch {
        stdout = '';
      }
    }
    let report: unknown;
    try {
      report = JSON.parse(stdout);
    } catch {
      report = null;
    }
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      return reply
        .code(502)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'The fleet runtime did not return a profile'));
    }
    const { error, status } = report as { error?: unknown; status?: unknown };
    if (typeof error === 'string') {
      // The session is known here, so a 404 from the runtime means it disappeared in between.
      const missing = status === 404;
      return reply
        .code(missing ? 404 : 502)
        .send(createErrorResponse(missing ? ApiErrorCode.NOT_FOUND : ApiErrorCode.OPERATION_FAILED, error));
    }
    return { success: true, data: report };
  });
}
