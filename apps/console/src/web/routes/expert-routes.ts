/**
 * @fileoverview Experts API: templates the owner keeps, and hiring/retiring them as employees.
 *
 * - Reading (`GET /api/experts`, `GET /api/experts/:id`) is open to any caller.
 * - Changing a template or the settings is the owner's alone: a request carrying an
 *   `X-Codeman-Parent-Session` header, with any value (empty too), is refused and changes nothing.
 * - Hiring and retiring: the owner, or an agent session the owner listed in `settings.hireDelegates`.
 *   Caps (`maxHiresPerDay` over a rolling 24 hours, `maxActive`) are refused at the limit with 409;
 *   nothing is retired or trimmed to make room.
 * - A hire creates the session through the console's own session route, registers it as an employee,
 *   joins the template's rooms and posts one notice. Without a notice room, or if the notice cannot be
 *   posted, the hire fails and every step already taken is undone. An admin-audit line is written
 *   before the response.
 * - A delegate hire uses the template's mode and account (a `mode` or `accountProfileId` in its body is
 *   refused with 403), and its `workingDir` must be inside `settings.delegateWorkingRoot` (unset: 403).
 * - Retiring stops the session through the console's session cleanup and marks the hire retired.
 *   Removed: the session (its console row, running process and paste uploads). Kept: the hire and
 *   employee records, the working directory, the agent's memory and the CLI transcripts.
 * - Budget stop: a hire may carry `budgetStop { planId, weeklyPercent }`. An hourly check reads the
 *   plans (the rows GET /api/plans shows). At or past the limit the session is asked, in the notice
 *   room, to save its work and write a handoff; after the grace it is retired through the same path
 *   as the retire route, with by='budget-stop'. `triggeredAt` is kept on the record, so a restart
 *   during the grace resumes the countdown. A missing or stale reading never stops a session and
 *   never passes silently: it posts a "cannot be checked" notice, at most once a day per hire.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import {
  AccountProfileIdSchema,
  BudgetStopBodySchema,
  CliModeSchema,
  DAY_MS,
  EffortSchema,
  ExpertError,
  MAX_EXPERT_TEMPLATES,
  MAX_HIRE_RECORDS,
  ModelIdSchema,
  findCredential,
  parseExpertSettings,
  parseExpertTemplate,
  type ExpertHire,
  type ExpertStore,
  type SessionLaunch,
} from '../../experts.js';

export interface ExpertAuditEntry {
  admin: string;
  action: string;
  target?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

/** One plan as GET /api/plans reads it: `weeklyPercent` is its seven-day used percentage (null when unknown). */
export interface PlanReading {
  id: string;
  weeklyPercent: number | null;
  /** When the reading was taken (epoch ms). */
  updatedAt: number;
}

export interface BudgetCheckResult {
  triggered: string[];
  retired: string[];
  unchecked: string[];
  /** Hires whose retirement failed this pass; the next pass retries them. */
  failed: string[];
}

export interface ExpertRoutes {
  /** Check every active hire's budget stop at `now`; the hourly timer calls this too. */
  checkBudgetStops(now?: number): Promise<BudgetCheckResult>;
}

export const HOUR_MS = 60 * 60 * 1000;
/** A plan reading older than this cannot be used to decide a budget stop. */
export const BUDGET_READING_STALE_MS = 2 * HOUR_MS;

export interface ExpertRouteDeps {
  store: ExpertStore;
  /** The agent session an `X-Codeman-Parent-Session` header resolves to, if any. */
  callerSession(req: FastifyRequest): string | undefined;
  /** Create the session through the console's session-creation route; resolves to its id. */
  createSession(req: FastifyRequest, launch: SessionLaunch): Promise<string>;
  /** Stop a session through the console's cleanup path (no history or data directories are removed). */
  stopSession(sessionId: string): Promise<void>;
  sessionExists(sessionId: string): boolean;
  hireEmployee(input: {
    owner?: string;
    name: string;
    icon: string;
    position: string;
    expertise: string[];
    sessionId: string;
  }): Promise<{ id: string }>;
  inviteEmployee(employeeId: string, roomId: string, owner: string | undefined): void;
  /** Rollback only: remove an employee record this hire just created. */
  removeEmployee(employeeId: string): Promise<void>;
  /** Rollback only: take the session out of a room this hire just joined. */
  leaveRoom(roomId: string, sessionId: string): void;
  /** Rollback only: drop the temporary-worker profile the session route records for a new agent session. */
  forgetSpawnProfile?(owner: string | undefined, sessionId: string): Promise<void>;
  postNotice(roomId: string, text: string): void | Promise<void>;
  audit(entry: ExpertAuditEntry): Promise<void>;
  /** Notice room when the settings name none (FLEET_EXPERTS_NOTICE_ROOM). */
  noticeRoomFallback?: string;
  /** Plans as GET /api/plans reads them. A throw means the plans cannot be read. */
  readPlans?(): Promise<PlanReading[]>;
  /** Send the session a message addressed to it in `roomId` (the checkpoint request). */
  sendToSession?(roomId: string, sessionId: string, text: string): void | Promise<void>;
  /** Whether a chat room exists (a template's rooms are checked when it is saved). */
  roomExists?(roomId: string): boolean;
  /** How often the budget stops are checked; 0 turns the timer off. Default hourly. */
  budgetCheckEveryMs?: number;
  /** Run `fn` after `ms` (the end of a budget-stop grace). Default: an unref'd timeout while the check timer runs. */
  setTimer?(ms: number, fn: () => void): { clear(): void } | void;
  /** Resolve a path through symlinks (default fs.realpath). */
  realpath?(path: string): Promise<string>;
  now?(): number;
}

const HireBodySchema = z
  .object({
    workingDir: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => p.startsWith('/'), 'workingDir is an absolute path'),
    mode: CliModeSchema.optional(),
    model: ModelIdSchema.optional(),
    effort: EffortSchema.optional(),
    accountProfileId: AccountProfileIdSchema.optional(),
    reason: z.string().trim().min(3).max(500),
    budgetStop: BudgetStopBodySchema.optional(),
  })
  .strict();
const RetireBodySchema = z
  .object({
    sessionId: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

type Actor = { kind: 'owner'; label: string } | { kind: 'delegate'; session: string; label: string };

const statusCode = (status: number): ApiErrorCode =>
  status === 403
    ? ApiErrorCode.FORBIDDEN
    : status === 404
      ? ApiErrorCode.NOT_FOUND
      : status === 409
        ? ApiErrorCode.CONFLICT
        : status >= 500
          ? ApiErrorCode.OPERATION_FAILED
          : ApiErrorCode.INVALID_INPUT;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const flat = (text: string): string => text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();

const isInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function registerExpertRoutes(app: FastifyInstance, deps: ExpertRouteDeps): ExpertRoutes {
  const now = () => (deps.now ?? Date.now)();
  const realpath = deps.realpath ?? ((p: string) => fs.realpath(p));
  const agentCall = (req: FastifyRequest): boolean => req.headers['x-codeman-parent-session'] !== undefined;
  const ownerOnly = (req: FastifyRequest, what: string): void => {
    if (agentCall(req)) throw new ExpertError(`Only the owner ${what}`, 403);
  };
  /** The owner, or a listed delegate session. An unresolved or unlisted agent is refused. */
  const hiringActor = (req: FastifyRequest): Actor => {
    if (!agentCall(req)) return { kind: 'owner', label: getAuthUser(req).username || 'owner' };
    const session = deps.callerSession(req);
    if (!session) throw new ExpertError('Unknown agent session', 403);
    if (!deps.store.snapshot().settings.hireDelegates.includes(session))
      throw new ExpertError('This session may not hire or retire experts; the owner lists delegates', 403);
    return { kind: 'delegate', session, label: `agent:${session}` };
  };
  const run = async <T>(reply: { code(code: number): unknown }, work: () => Promise<T>) => {
    try {
      return { success: true, data: await work() };
    } catch (error) {
      const status = error instanceof ExpertError ? error.status : (error as { status?: unknown }).status;
      if (typeof status !== 'number' || (error as { body?: unknown }).body) throw error;
      reply.code(status);
      return createErrorResponse(statusCode(status), (error as Error).message);
    }
  };
  // Hires and retirements run one at a time, so two concurrent requests cannot both pass a cap.
  let gate: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = gate.then(work);
    gate = next.catch(() => {});
    return next;
  };
  const noticeRoom = (): string | undefined => deps.store.snapshot().settings.noticeRoomId ?? deps.noticeRoomFallback;

  app.get('/api/experts', async (_req, reply) =>
    run(reply, async () => {
      await deps.store.load();
      const state = deps.store.snapshot();
      const since = now() - DAY_MS;
      return {
        experts: state.templates,
        hires: state.hires,
        // The whole settings object: PUT /api/experts-settings replaces it, so a caller reads, changes and writes it back.
        settings: state.settings,
        limits: {
          hiresLast24h: state.hires.filter((h) => h.hiredAt > since).length,
          maxHiresPerDay: state.settings.maxHiresPerDay,
          active: state.hires.filter((h) => h.status === 'active').length,
          maxActive: state.settings.maxActive,
        },
      };
    })
  );

  app.get('/api/experts/:id', async (req, reply) =>
    run(reply, async () => {
      await deps.store.load();
      const { id } = req.params as { id: string };
      const state = deps.store.snapshot();
      const expert = state.templates.find((t) => t.id === id);
      if (!expert) throw new ExpertError('No such expert template', 404);
      return { expert, hires: state.hires.filter((h) => h.templateId === id) };
    })
  );

  app.put('/api/experts/:id', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req, 'creates or changes an expert template');
      const { id } = req.params as { id: string };
      const { expert, created } = await deps.store.update((state) => {
        const index = state.templates.findIndex((t) => t.id === id);
        const next = parseExpertTemplate(id, req.body, now(), index >= 0 ? state.templates[index] : undefined);
        const missing = deps.roomExists ? next.rooms.find((roomId) => !deps.roomExists!(roomId)) : undefined;
        if (missing !== undefined) throw new ExpertError(`rooms: no room with id "${flat(missing).slice(0, 100)}"`);
        if (index < 0 && state.templates.length >= MAX_EXPERT_TEMPLATES)
          throw new ExpertError(`At most ${MAX_EXPERT_TEMPLATES} expert templates`, 409);
        if (index < 0) state.templates.push(next);
        else state.templates[index] = next;
        return { expert: next, created: index < 0 };
      });
      await deps.audit({
        admin: getAuthUser(req).username,
        action: 'expert_template_set',
        target: id,
        ip: req.ip,
        detail: { created, personaSha256: sha256(expert.persona) },
      });
      return { expert };
    })
  );

  app.delete('/api/experts/:id', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req, 'removes an expert template');
      const { id } = req.params as { id: string };
      await deps.store.update((state) => {
        const index = state.templates.findIndex((t) => t.id === id);
        if (index < 0) throw new ExpertError('No such expert template', 404);
        if (state.hires.some((h) => h.templateId === id && h.status === 'active'))
          throw new ExpertError('Retire the active hires of this template first', 409);
        state.templates.splice(index, 1);
      });
      await deps.audit({ admin: getAuthUser(req).username, action: 'expert_template_delete', target: id, ip: req.ip });
      return {};
    })
  );

  app.put('/api/experts-settings', async (req, reply) =>
    run(reply, async () => {
      ownerOnly(req, 'changes the experts settings');
      const settings = parseExpertSettings(req.body);
      const hit = findCredential(settings);
      if (hit) throw new ExpertError(`${hit}: looks like a credential`);
      const saved = await deps.store.update((state) => {
        state.settings = settings;
        return settings;
      });
      await deps.audit({
        admin: getAuthUser(req).username,
        action: 'expert_settings',
        target: 'experts-settings',
        ip: req.ip,
        detail: { ...saved },
      });
      return { settings: saved };
    })
  );

  app.post('/api/experts/:id/hire', async (req, reply) =>
    run(reply, async () => {
      await deps.store.load();
      const actor = hiringActor(req);
      const body = parseBody(HireBodySchema, req.body);
      if (findCredential(body.reason)) throw new ExpertError('reason: looks like a credential');
      const { id } = req.params as { id: string };
      const owner = ownerFor(req);
      if (actor.kind === 'delegate') {
        const settings = deps.store.snapshot().settings;
        // The internal session request carries no agent header, so the session route would treat a
        // delegate as the owner. Everything that changes privilege therefore comes from the template.
        if (body.mode !== undefined || body.accountProfileId !== undefined)
          throw new ExpertError('A delegate hire uses the template mode and account; leave out mode and accountProfileId', 403);
        const root = settings.delegateWorkingRoot;
        if (!root) throw new ExpertError('No delegateWorkingRoot is set, so a delegate may not hire', 403);
        let inside = false;
        try {
          inside = isInside(await realpath(root), await realpath(body.workingDir));
        } catch {
          inside = false;
        }
        if (!inside) throw new ExpertError('workingDir is outside the delegate working root', 403);
        if (settings.requireBudgetStopForDelegates && !body.budgetStop)
          throw new ExpertError('budgetStop: a delegate hire must carry a budget stop');
      }
      if (body.budgetStop) {
        if (!deps.readPlans) throw new ExpertError('budgetStop: plans cannot be read here, so a budget stop cannot be checked');
        let plans: PlanReading[] | undefined;
        try {
          plans = await deps.readPlans();
        } catch (error) {
          // Unreadable now: accepted; the hourly check reports it until the reading returns.
          console.error('[experts] plans unreadable at hire:', error instanceof Error ? error.message : error);
        }
        const row = plans?.find((p) => p.id === body.budgetStop!.planId);
        if (plans && !row) throw new ExpertError('budgetStop.planId: no such plan');
        // A fresh reading already at the limit would stop the hire at the first check: refuse it now.
        if (
          row &&
          typeof row.weeklyPercent === 'number' &&
          Number.isFinite(row.weeklyPercent) &&
          Number.isFinite(row.updatedAt) &&
          now() - row.updatedAt <= BUDGET_READING_STALE_MS &&
          row.weeklyPercent >= body.budgetStop.weeklyPercent
        )
          throw new ExpertError(`budgetStop: plan ${row.id} is already at ${row.weeklyPercent}% weekly`);
      }
      return serial(async () => {
        const state = deps.store.snapshot();
        const template = state.templates.find((t) => t.id === id);
        if (!template) throw new ExpertError('No such expert template', 404);
        const { settings } = state;
        const room = noticeRoom();
        if (!room) throw new ExpertError('No notice room is configured, so hiring is off', 503);
        const at = now();
        const recent = state.hires.filter((h) => h.hiredAt > at - DAY_MS).length;
        const active = state.hires.filter((h) => h.status === 'active').length;
        if (recent >= settings.maxHiresPerDay)
          throw new ExpertError(`Hire limit reached: ${recent} of ${settings.maxHiresPerDay} in the last 24 hours`, 409);
        if (active >= settings.maxActive)
          throw new ExpertError(`Active expert limit reached: ${active} of ${settings.maxActive}; retire one first`, 409);
        if (state.hires.length >= MAX_HIRE_RECORDS) throw new ExpertError('Hire record limit reached', 409);

        const sessionId = await deps.createSession(req, {
          workingDir: body.workingDir,
          mode: body.mode ?? template.defaults.mode,
          name: template.name,
          icon: template.icon,
          model: body.model ?? (body.mode && body.mode !== template.defaults.mode ? undefined : template.defaults.model),
          effort: body.effort ?? template.defaults.effort,
          accountProfileId: body.accountProfileId ?? template.defaults.accountProfileId,
        });
        // Undo steps, newest first. The session goes last, after everything that refers to it.
        const undo: Array<() => unknown> = [
          () => deps.stopSession(sessionId),
          () => deps.forgetSpawnProfile?.(owner, sessionId),
        ];
        let record: ExpertHire;
        try {
          const employee = await deps.hireEmployee({
            owner,
            name: template.name,
            icon: template.icon,
            position: template.role,
            expertise: template.expertise.length ? template.expertise.slice(0, 12) : [template.role],
            sessionId,
          });
          undo.unshift(() => deps.removeEmployee(employee.id));
          // A hire with a budget stop also joins the notice room, where its checkpoint request is sent.
          const joins = body.budgetStop && !template.rooms.includes(room) ? [...template.rooms, room] : template.rooms;
          for (const roomId of joins) {
            deps.inviteEmployee(employee.id, roomId, owner);
            undo.unshift(() => deps.leaveRoom(roomId, sessionId));
          }
          record = {
            id: randomUUID(),
            templateId: template.id,
            sessionId,
            employeeId: employee.id,
            by: actor.kind === 'owner' ? 'owner' : actor.label,
            reason: body.reason,
            hiredAt: at,
            status: 'active',
            ...(body.budgetStop ? { budgetStop: { ...body.budgetStop } } : {}),
          };
          const hireId = record.id;
          await deps.store.update((s) => {
            s.hires.push(record);
          });
          undo.unshift(() =>
            deps.store.update((s) => {
              s.hires = s.hires.filter((h) => h.id !== hireId);
            })
          );
          try {
            await deps.postNotice(
              room,
              `Expert hired: ${template.icon} ${template.name} (${template.role}) from template "${template.id}" by ${record.by}. ` +
                `Reason: ${flat(body.reason)}. Session ${sessionId}. ` +
                (body.budgetStop
                  ? `Budget stop: plan ${body.budgetStop.planId} at ${body.budgetStop.weeklyPercent}% weekly. `
                  : '') +
                `Hires in the last 24 hours: ${recent + 1}/${settings.maxHiresPerDay}; active: ${active + 1}/${settings.maxActive}.`
            );
          } catch (error) {
            throw new ExpertError(
              `The hire notice could not be posted, so the hire was undone: ${error instanceof Error ? error.message : String(error)}`,
              503
            );
          }
        } catch (error) {
          for (const step of undo) {
            try {
              await step();
            } catch (undoError) {
              console.error('[experts] hire rollback step failed:', undoError instanceof Error ? undoError.message : undoError);
            }
          }
          throw error;
        }
        await deps.audit({
          admin: actor.label,
          action: 'expert_hire',
          target: template.id,
          ip: req.ip,
          detail: { template: template.id, sessionId, by: record.by, employeeId: record.employeeId },
        });
        return { hire: record, sessionId, employeeId: record.employeeId };
      });
    })
  );

  /**
   * The one retire path (the retire route and the budget stop). Not serialized itself: callers hold
   * the gate. Cleanup removes the session's console row, process and paste uploads; the hire and
   * employee records, the working directory, the memory and the transcripts stay.
   */
  const retireHire = async (hire: ExpertHire, by: string, reason: string, admin: string, ip?: string) => {
    if (deps.sessionExists(hire.sessionId)) await deps.stopSession(hire.sessionId);
    const retired = await deps.store.update((s) => {
      const saved = s.hires.find((h) => h.id === hire.id)!;
      Object.assign(saved, { status: 'retired', retiredAt: now(), retiredBy: by, retireReason: reason });
      return saved;
    });
    await deps.audit({
      admin,
      action: 'expert_retire',
      target: hire.templateId,
      ip,
      detail: { template: hire.templateId, sessionId: hire.sessionId, by, employeeId: hire.employeeId },
    });
    let notice = false;
    const room = noticeRoom();
    if (room) {
      try {
        await deps.postNotice(
          room,
          `Expert retired: session ${hire.sessionId} of template "${hire.templateId}" by ${by}. Reason: ${flat(reason)}. ` +
            `Removed: the session (its console row, running process and paste uploads). ` +
            `Kept: the hire and employee records, the working directory, the agent's memory and the CLI transcripts.`
        );
        notice = true;
      } catch (error) {
        console.error('[experts] retire notice failed:', error instanceof Error ? error.message : error);
      }
    }
    return { hire: retired, notice };
  };

  app.post('/api/experts/:id/retire', async (req, reply) =>
    run(reply, async () => {
      await deps.store.load();
      const actor = hiringActor(req);
      const body = parseBody(RetireBodySchema, req.body);
      if (findCredential(body.reason)) throw new ExpertError('reason: looks like a credential');
      const { id } = req.params as { id: string };
      return serial(async () => {
        const state = deps.store.snapshot();
        const hire = state.hires.find((h) => h.templateId === id && h.sessionId === body.sessionId && h.status === 'active');
        if (!hire) throw new ExpertError('No active hire of this template with that session', 404);
        const by = actor.kind === 'owner' ? 'owner' : actor.label;
        return retireHire(hire, by, body.reason, actor.label, req.ip);
      });
    })
  );

  // ========== Budget stop ==========

  const every = deps.budgetCheckEveryMs ?? HOUR_MS;
  const setTimer =
    deps.setTimer ??
    (every > 0
      ? (ms: number, fn: () => void) => {
          const t = setTimeout(fn, ms);
          t.unref?.();
          return { clear: () => clearTimeout(t) };
        }
      : undefined);
  const graceTimers = new Map<string, { clear(): void }>();
  const log = (what: string, error: unknown) =>
    console.error(`[experts] ${what}:`, error instanceof Error ? error.message : error);
  const notify = async (text: string): Promise<boolean> => {
    const room = noticeRoom();
    if (!room) {
      console.error(`[experts] no notice room for: ${text}`);
      return false;
    }
    try {
      await deps.postNotice(room, text);
      return true;
    } catch (error) {
      log('budget-stop notice failed', error);
      return false;
    }
  };
  const scheduleRetire = (hireId: string, due: number) => {
    if (!setTimer || graceTimers.has(hireId)) return;
    const timer = setTimer(Math.max(0, due - now()), () => {
      graceTimers.delete(hireId);
      checkBudgetStops().catch((error) => log('budget-stop check failed', error));
    });
    if (timer) graceTimers.set(hireId, timer);
  };

  const checkBudgetStops = async (at = now()): Promise<BudgetCheckResult> => {
    await deps.store.load();
    return serial(async () => {
      const result: BudgetCheckResult = { triggered: [], retired: [], unchecked: [], failed: [] };
      const state = deps.store.snapshot();
      const graceMs = state.settings.budgetStopGraceMinutes * 60_000;
      const watched = state.hires.filter((h) => h.status === 'active' && h.budgetStop);
      if (!watched.length) return result;

      // Fired earlier (maybe before a restart): retire once the grace is over, else wait for it.
      for (const hire of watched.filter((h) => h.budgetStop!.triggeredAt !== undefined)) {
        const stop = hire.budgetStop!;
        const due = stop.triggeredAt! + graceMs;
        if (at < due) {
          scheduleRetire(hire.id, due);
          continue;
        }
        graceTimers.get(hire.id)?.clear();
        graceTimers.delete(hire.id);
        // Each hire on its own: one failing stop must not leave the others unchecked.
        try {
          await retireHire(
            hire,
            'budget-stop',
            `Budget stop: plan ${stop.planId} reached the ${stop.weeklyPercent}% weekly limit`,
            'budget-stop'
          );
          result.retired.push(hire.id);
        } catch (error) {
          result.failed.push(hire.id);
          log(`budget-stop retire of ${hire.sessionId} failed`, error);
          if (stop.retireFailNoticeAt !== undefined && at - stop.retireFailNoticeAt < HOUR_MS) continue;
          const reason = flat(error instanceof Error ? error.message : String(error)).slice(0, 300);
          if (await notify(`Budget stop could not retire session ${hire.sessionId}: ${reason}; retrying hourly.`)) {
            try {
              await deps.store.update((s) => {
                s.hires.find((h) => h.id === hire.id)!.budgetStop!.retireFailNoticeAt = at;
              });
            } catch (saveError) {
              log('budget-stop notice time not saved', saveError);
            }
          }
        }
      }

      const pending = watched.filter((h) => h.budgetStop!.triggeredAt === undefined);
      if (!pending.length) return result;
      let plans: PlanReading[] | undefined;
      try {
        plans = deps.readPlans ? await deps.readPlans() : undefined;
      } catch (error) {
        log('plans unreadable for the budget stop', error);
      }
      for (const hire of pending) {
        try {
          await checkPending(hire, plans, at, graceMs, result);
        } catch (error) {
          log(`budget-stop check of ${hire.sessionId} failed`, error);
        }
      }
      return result;
    });
  };

  const checkPending = async (
    hire: ExpertHire,
    plans: PlanReading[] | undefined,
    at: number,
    graceMs: number,
    result: BudgetCheckResult
  ): Promise<void> => {
    {
        const stop = hire.budgetStop!;
        const row = plans?.find((p) => p.id === stop.planId);
        const weekly = row?.weeklyPercent;
        const problem = !plans
          ? 'the plans cannot be read'
          : !row
            ? 'the plan is not listed'
            : typeof weekly !== 'number' || !Number.isFinite(weekly)
              ? 'the plan has no weekly reading'
              : !Number.isFinite(row.updatedAt) || at - row.updatedAt > BUDGET_READING_STALE_MS
                ? `the plan reading is stale (taken ${new Date(row.updatedAt).toISOString()})`
                : undefined;
        if (problem) {
          result.unchecked.push(hire.id);
          if (stop.uncheckedNoticeAt !== undefined && at - stop.uncheckedNoticeAt < DAY_MS) return;
          const posted = await notify(
            `Budget stop cannot be checked: session ${hire.sessionId} (template "${hire.templateId}", plan ${stop.planId}, ` +
              `stop at ${stop.weeklyPercent}% weekly): ${problem}. The session keeps running; check the plan by hand.`
          );
          if (posted)
            await deps.store.update((s) => {
              s.hires.find((h) => h.id === hire.id)!.budgetStop!.uncheckedNoticeAt = at;
            });
          return;
        }
        if ((weekly as number) < stop.weeklyPercent) return;

        // Record the trigger first: a restart from here on resumes the countdown, never restarts it.
        await deps.store.update((s) => {
          s.hires.find((h) => h.id === hire.id)!.budgetStop!.triggeredAt = at;
        });
        result.triggered.push(hire.id);
        const minutes = Math.round(graceMs / 60_000);
        const room = noticeRoom();
        let notTold: string | undefined;
        try {
          if (!room) throw new Error('no notice room');
          if (!deps.sendToSession) throw new Error('no channel to the session');
          await deps.sendToSession(
            room,
            hire.sessionId,
            `Budget stop: save your work and write a handoff now; this session stops in ${minutes} minutes.`
          );
        } catch (error) {
          notTold = flat(error instanceof Error ? error.message : String(error)).slice(0, 300) || 'unknown error';
          log('budget-stop checkpoint request failed', error);
        }
        const head =
          `Budget stop triggered: plan ${stop.planId} is at ${weekly}% weekly (stop at ${stop.weeklyPercent}%) ` +
          `for session ${hire.sessionId} (template "${hire.templateId}"); `;
        await notify(
          notTold === undefined
            ? `${head}the session was asked to save its work and write a handoff; it is retired in ${minutes} minutes.`
            : `${head}the session was NOT told (${notTold}); retiring anyway in ${minutes} minutes.`
        );
        scheduleRetire(hire.id, at + graceMs);
    }
  };

  if (every > 0) {
    const tick = () => void checkBudgetStops().catch((error) => log('budget-stop check failed', error));
    const interval = setInterval(tick, every);
    interval.unref?.();
    // Soon after a start, so a grace that was running before a restart resumes promptly.
    const first = setTimeout(tick, Math.min(every, 60_000));
    first.unref?.();
    app.addHook('onClose', async () => {
      clearInterval(interval);
      clearTimeout(first);
      for (const timer of graceTimers.values()) timer.clear();
      graceTimers.clear();
    });
  }

  return { checkBudgetStops };
}
