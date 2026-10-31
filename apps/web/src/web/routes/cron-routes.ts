import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
/**
 * @fileoverview Cron Jobs routes.
 *
 * CRUD + enable/disable + Run Now + run history for `CronJob`s. These are
 * separate from the legacy `/api/scheduled` (ScheduledRun) endpoints — see
 * docs/cron-discovery.md §0.
 */

import { FastifyInstance } from 'fastify';
import { getCli } from '../../config/cli-registry/registry.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { CronJobSchema, CronJobUpdateSchema, CronJobEnabledSchema } from '../schemas.js';
import { canAccessOwned, getAuthUser, isWorkingDirAllowed, ownerFor, parseBody } from '../route-helpers.js';
import { canUsernameRunPrivilegedCommands } from '../../user-store.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { CronJob } from '../../types/cron.js';
import type { CronPort } from '../ports/index.js';
import { appendAdminAudit } from '../admin-audit.js';
import { RoutinesGrantsError } from '../../routines-grants.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** What an agent's routine may do; the owner's bots and jobs keep the wider limits. */
export const ROUTINES_PER_AUTHOR = 20;
export const ROUTINE_MIN_INTERVAL_MINUTES = 5;
export const ROUTINE_MAX_TEXT = 2000;
/** Fields only the owner sets: who speaks, what data a post reads, and whether it only pretends. */
const OWNER_ONLY_FIELDS = ['postAs', 'botId', 'postSource', 'postSourceArgs', 'postWhen', 'postChangeOnly', 'dryRun'] as const;

export function registerCronRoutes(app: FastifyInstance, ctx: CronPort, verifiedOwner: OwnerVerifier = NO_OWNER): void {
  // Unattended session jobs require the verified owner. Delegated post-only jobs
  // retain their employee grant, room membership, authorship and rate boundaries below.
  const refuseAgentCaller = async (req: FastifyRequest, reply: FastifyReply) => {
    if (verifiedOwner(req)) return;
    // This runs before any handler, so on Run once its refusal also says nothing ran.
    const refusal = (why: string) => {
      const body = createErrorResponse(ApiErrorCode.FORBIDDEN, why);
      return reply.code(403).send(req.routeOptions.url === '/api/cron/jobs/:id/run' ? { ...body, notRun: true } : body);
    };
    if (req.headers['x-reverie-parent-session'] === undefined || req.headers['x-reverie-service-token'] !== undefined)
      return refusal('Verified owner or routine delegate required');
    const body = (req.body ?? {}) as { action?: unknown };
    const id = (req.params as { id?: string } | undefined)?.id;
    const postTraffic = id
      ? ctx.cron.getJob(id)?.action === 'post' && (req.method !== 'PUT' || body.action === undefined || body.action === 'post')
      : req.method === 'POST' && body.action === 'post';
    if (postTraffic) return;
    return refusal('Only the owner may create, change or run cron jobs');
  };
  app.addHook('onRoute', (options) => {
    if (!options.url.startsWith('/api/cron/')) return;
    const methods = [options.method].flat();
    if (methods.every((m) => m === 'GET' || m === 'HEAD')) return;
    const existing = options.preHandler ? [options.preHandler].flat() : [];
    options.preHandler = [refuseAgentCaller, ...existing];
  });

  // A job the caller may see/act on (own, or admin/single-user).
  const canTouch = (req: FastifyRequest, job: CronJob | null | undefined): job is CronJob =>
    !!job && canAccessOwned(getAuthUser(req), job.owner);

  // ── Jobs ────────────────────────────────────────────────────────────────

  app.get('/api/cron/active', async (req, reply) => {
    if (!verifiedOwner(req)) return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Owner sign-in required'));
    const jobs = ctx.cron.listRunningJobs().filter((job) => canAccessOwned(getAuthUser(req), job.owner));
    return { jobs: jobs.map(({ id, name }) => ({ id, name })) };
  });

  // The verified owner or an explicitly delegated employee may author post jobs.
  // Delegate changes are announced and audited before they happen; bot policy stays owner-only.
  const header = (req: FastifyRequest, name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const gatePost = async (
    req: FastifyRequest,
    verb: string,
    job: CronJob | undefined,
    body?: { name?: string; postSource?: string | null; roomId?: string | null }
  ): Promise<ReturnType<typeof createErrorResponse> | undefined> => {
    const caller = header(req, 'x-reverie-parent-session');
    const name = body?.name ?? job?.name ?? 'post job';
    const detail = { job: job?.id, verb, fields: body ? Object.keys(body) : [] };
    const refuseRecoveryReplay = () => {
      if (job?.recoveryUncertain && verb !== 'disabled') throw Object.assign(
        new Error('RECOVERY_UNCERTAIN: retained backup job requires unavailable owner reconciliation'),
        { statusCode: 400, body: createErrorResponse(ApiErrorCode.INVALID_INPUT, 'RECOVERY_UNCERTAIN: retain the disabled job and its evidence; no replay or reset') }
      );
    };
    if (verifiedOwner(req)) {
      refuseRecoveryReplay();
      void appendAdminAudit({ admin: 'owner', action: `post_job_${verb}`, target: name, ip: req.ip, detail });
      return undefined;
    }
    const refuse = (why: string): never => {
      throw Object.assign(new Error(why), { statusCode: 403, body: createErrorResponse(ApiErrorCode.FORBIDDEN, why) });
    };
    if (!caller || req.headers['x-reverie-service-token'] !== undefined) return refuse('Verified owner or routine delegate required');
    const policy = ctx.routines;
    if (!policy) return refuse('Only the owner creates or edits a post job');
    // A tainted caller (web content in its context) never schedules posts, whoever it is.
    if (header(req, 'x-reverie-tainted') !== undefined) return refuse('Refused while web content is in the caller context');
    const employee = policy.findEmployee(caller);
    if (!employee) {
      return refuse('Temporary agents cannot own routines, because the routine would outlive the agent. Ask the owner to hire this agent first');
    }
    if (!policy.grants.allows(employee)) return refuse('Only the owner or a delegate creates or edits a post job');
    // A routine belongs to the employee who made it. Bot jobs and the owner's jobs have no author, so no agent changes them.
    if (job && job.createdBy?.employeeId !== employee.id) return refuse('You can only change your own routines');
    // Refuse before the mandatory announcement: a blocked replay must not post a false mutation notice.
    refuseRecoveryReplay();
    const asked = body ? OWNER_ONLY_FIELDS.filter((f) => (verb !== 'created' || f !== 'postAs') && (body as Record<string, unknown>)[f] !== undefined) : [];
    if (asked.length) return refuse(`${asked.join(', ')} can only be set by the owner`);
    const room = body?.roomId ?? job?.roomId;
    if (room && verb !== 'deleted' && verb !== 'disabled' && !policy.isMember(room, caller)) return refuse('You can only schedule a routine in a room you are a member of');
    if (body) {
      const text = (body as { postText?: string }).postText;
      if (text !== undefined && text.length > ROUTINE_MAX_TEXT) return refuse(`A routine's text is at most ${ROUTINE_MAX_TEXT} characters`);
      const every = (body as { intervalMinutes?: number }).intervalMinutes;
      if (every !== undefined && every < ROUTINE_MIN_INTERVAL_MINUTES) {
        return refuse(`A routine repeats at most every ${ROUTINE_MIN_INTERVAL_MINUTES} minutes`);
      }
    }
    if (verb === 'created' && ctx.cron.listJobs().filter((j) => j.createdBy?.employeeId === employee.id).length >= ROUTINES_PER_AUTHOR) {
      return refuse(`You already have ${ROUTINES_PER_AUTHOR} routines; remove one first`);
    }
    const scope = ownerFor(req);
    const announcement = policy.notificationRoomId(scope);
    const text = `${employee.name} (${employee.position}) ${verb} post job "${name}"${detail.fields.length ? ` (${detail.fields.join(', ')})` : ''}`;
    if (!announcement || !policy.notify(announcement, text, scope))
      return refuse('The routine announcement room could not be told, so the change was not made');
    void appendAdminAudit({ admin: `${employee.name} (${employee.id})`, action: `post_job_${verb}`, target: name, ip: req.ip, detail });
    return undefined;
  };

  app.get('/api/routines-grants', async () => ({ success: true, data: ctx.routines?.grants.snapshot() ?? null }));
  app.put('/api/routines-grants', async (req, reply) => {
    if (!verifiedOwner(req) || !ctx.routines) {
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the owner grants the routines permission'));
    }
    try {
      const data = await ctx.routines.grants.set(req.body);
      void appendAdminAudit({ admin: 'owner', action: 'routines_grants_set', ip: req.ip, detail: data as unknown as Record<string, unknown> });
      return { success: true, data };
    } catch (err) {
      if (err instanceof RoutinesGrantsError) return createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message);
      throw err;
    }
  });

  app.get('/api/cron/jobs', async (req) => {
    // Owner scope first, for every caller: an agent never sees past the jobs its owner scope allows, ?all=1 or not.
    let jobs = ctx.cron.listJobs();
    if (isMultiUserMode()) {
      const user = getAuthUser(req);
      if (user.role !== 'admin') jobs = (jobs as CronJob[]).filter((j) => canAccessOwned(user, j.owner));
    }
    // An agent sees its own routines in full; ?all=1 adds everyone's name, room and schedule, never another author's text.
    const caller = header(req, 'x-reverie-parent-session');
    if (caller === undefined) return jobs;
    const mine = authorOf(caller);
    const all = (req.query as { all?: string } | undefined)?.all === '1';
    return jobs.filter((j) => all || isMine(mine, j)).map((j) => (isMine(mine, j) ? j : publicJob(j)));
  });

  const authorOf = (caller: string): string | undefined => ctx.routines?.findEmployee(caller)?.id;
  const isMine = (me: string | undefined, j: CronJob | undefined): boolean => !!me && !!j && j.createdBy?.employeeId === me;
  // What an agent may read of a job or run that is not its own: when, where and by whom, never what it says. An allowlist,
  // so a field added to the job later (rendered text, notes, commands, errors that quote the text) stays hidden by default.
  const PUBLIC_JOB_FIELDS = [
    'id', 'name', 'action', 'postAs', 'createdBy', 'createdByOwner', 'roomId', 'enabled', 'scheduleType', 'runAt', 'intervalMinutes', 'timeZone',
    'dailyTime', 'weeklyDays', 'weeklyTime', 'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt', 'lastStatus',
  ] as const;
  const PUBLIC_RUN_FIELDS = ['id', 'cronJobId', 'startedAt', 'finishedAt', 'status', 'triggerType'] as const;
  const pick = <T extends object>(o: T, keys: readonly string[]): T =>
    Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, (o as Record<string, unknown>)[k]])) as T;
  const publicJob = (j: CronJob): CronJob => pick(j, PUBLIC_JOB_FIELDS);
  const publicRun = <R extends object>(r: R): R => pick(r, PUBLIC_RUN_FIELDS);

  app.post('/api/cron/jobs', async (req, reply) => {
    // No custom errorMessage: surface the schema's field-specific messages
    // (e.g. "runAt is required for a one-time schedule").
    // An employee's routine always speaks as its author: the server says so, and the body may not.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const asEmployee = header(req, 'x-reverie-parent-session') !== undefined && raw.action === 'post';
    if (asEmployee && raw.postAs !== undefined) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'postAs can only be set by the owner');
    }
    const body = parseBody(CronJobSchema, asEmployee ? { ...raw, postAs: 'author' } : req.body);
    if (body.action === 'post') {
      const refused = await gatePost(req, 'created', undefined, body);
      if (refused) return refused;
      // The author comes from the caller's own session, never from the body.
      const caller = header(req, 'x-reverie-parent-session');
      const author = caller === undefined ? undefined : ctx.routines?.findEmployee(caller);
      if (caller === undefined && body.postAs === 'author') {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'postAs author is only for an employee\'s own routine');
      }
      return { job: ctx.cron.createJob(body, ownerFor(req), author && { employeeId: author.id }, verifiedOwner(req)) };
    }
    // Section 6.2: confine the job's workingDir to the owner's case space (mirrors
    // POST /api/sessions). No-op allow-all for admins/single-user. workingDir is
    // required by CronJobSchema so it is always present here.
    if (!isWorkingDirAllowed(getAuthUser(req), body.workingDir as string)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }
    // Section 6.3: shell mode / a launchCommand is arbitrary host-account execution.
    // Resolve the owner's grant from the store (AuthUser.role alone can't tell a GRANTED
    // regular user from a plain one); mirrors session-routes + the cron fire-time re-check.
    if (
      (getCli(body.agentType as string)?.capabilities.privilegedCommandGate || body.launchCommand) &&
      !(await canUsernameRunPrivilegedCommands(ownerFor(req)))
    ) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Shell/launchCommand cron jobs require the can-bypass-permissions grant'
      );
    }
    return { job: ctx.cron.createJob(body, ownerFor(req), undefined, verifiedOwner(req)) };
  });

  app.get('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.cron.getJob(id);
    if (!canTouch(req, job)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    const caller = header(req, 'x-reverie-parent-session');
    if (caller !== undefined && !isMine(authorOf(caller), job)) return publicJob(job);
    return job;
  });

  app.put('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!canTouch(req, ctx.cron.getJob(id))) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    const existingJob = ctx.cron.getJob(id) as CronJob;
    const body = parseBody(CronJobUpdateSchema, req.body);
    if (existingJob.action === 'post' || body.action === 'post') {
      const refused = await gatePost(req, 'edited', existingJob, body);
      if (refused) return refused;
    }
    // Section 6.2: the update body is partial, so only confine when workingDir is set.
    if (body.action !== undefined && body.action !== (existingJob.action ?? 'launch')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'A job cannot change what it does; create a new one');
    }
    if (body.workingDir !== undefined && !isWorkingDirAllowed(getAuthUser(req), body.workingDir)) {
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'workingDir is outside your workspace');
    }
    if (
      (getCli(body.agentType ?? 'claude')?.capabilities.privilegedCommandGate || body.launchCommand) &&
      !(await canUsernameRunPrivilegedCommands(ownerFor(req)))
    ) {
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        'Shell/launchCommand cron jobs require the can-bypass-permissions grant'
      );
    }
    const job = ctx.cron.updateJob(id, body);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return { job };
  });

  app.delete('/api/cron/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const target = ctx.cron.getJob(id);
    if (target?.action === 'post' && canTouch(req, target)) {
      const refused = await gatePost(req, 'deleted', target);
      if (refused) return refused;
    }
    if (!canTouch(req, target) || !ctx.cron.deleteJob(id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    }
    return {};
  });

  app.put('/api/cron/jobs/:id/enabled', async (req) => {
    const { id } = req.params as { id: string };
    if (!canTouch(req, ctx.cron.getJob(id))) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    const target = ctx.cron.getJob(id);
    const { enabled } = parseBody(CronJobEnabledSchema, req.body, 'Invalid request body');
    if (target?.action === 'post') {
      const refused = await gatePost(req, enabled ? 'enabled' : 'disabled', target);
      if (refused) return refused;
    }
    const job = ctx.cron.setEnabled(id, enabled);
    if (!job) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return { job };
  });

  // ── Run Now ──────────────────────────────────────────────────────────────

  app.post('/api/cron/jobs/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.cron.getJob(id);
    // Every refusal here comes before runNow and says so; any other failure leaves the outcome unknown to the caller.
    const notRun = <T extends object>(body: T) => ({ ...body, notRun: true as const });
    if (!canTouch(req, job)) return notRun(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found'));
    if (job.action === 'post') {
      try {
        const refused = await gatePost(req, 'ran', job);
        if (refused) return notRun(refused);
      } catch (error) {
        const refusal = error as { body?: object };
        if (refusal.body) refusal.body = notRun(refusal.body);
        throw error;
      }
    }
    const run = await ctx.cron.runNow(id);
    return { run, activeAgents: ctx.cron.countActiveAgents(job.agentType, job.id) };
  });

  // ── Preview: what Run once would do now; nothing is written, posted or announced ──

  app.get('/api/cron/jobs/:id/preview', async (req) => {
    const { id } = req.params as { id: string };
    const job = ctx.cron.getJob(id);
    if (!canTouch(req, job)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    // A preview shows the message and source data a run would post, so an agent previews only its own routines.
    const caller = header(req, 'x-reverie-parent-session');
    if (caller !== undefined && !isMine(authorOf(caller), job)) return createErrorResponse(ApiErrorCode.FORBIDDEN, 'You can preview only your own routines');
    const preview = await ctx.cron.preview(id);
    if (!preview) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    return { preview };
  });

  // ── Run history ──────────────────────────────────────────────────────────

  app.get('/api/cron/jobs/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    // Owner-gate like every other :id handler so a foreign job's run history (session
    // ids, names, deep links) isn't leaked; NOT_FOUND avoids disclosing existence.
    const job = ctx.cron.getJob(id);
    if (!canTouch(req, job)) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Cron job not found');
    // An agent reads the history of its own routines; for anyone else's it gets the times and outcomes, not the messages.
    const caller = header(req, 'x-reverie-parent-session');
    const runs = ctx.cron.listRuns(id);
    return caller !== undefined && !isMine(authorOf(caller), job) ? runs.map(publicRun) : runs;
  });

  app.get('/api/cron/runs', async (req) => {
    const runs = ctx.cron.listRuns();
    const caller = header(req, 'x-reverie-parent-session');
    if (caller !== undefined) {
      // Owner scope below still applies; then an agent keeps its own runs whole and sees only times and outcomes of the rest.
      const jobById = new Map(ctx.cron.listJobs().map((j): [string, CronJob] => [j.id, j]));
      const mine = authorOf(caller);
      const scoped = (filtered: typeof runs) => filtered.map((r) => (isMine(mine, jobById.get(r.cronJobId)) ? r : publicRun(r)));
      if (!isMultiUserMode()) return scoped(runs);
      const agentUser = getAuthUser(req);
      return scoped(agentUser.role === 'admin' ? runs : runs.filter((r) => canAccessOwned(agentUser, jobById.get(r.cronJobId)?.owner)));
    }
    if (!isMultiUserMode()) return runs;
    const user = getAuthUser(req);
    if (user.role === 'admin') return runs;
    // Non-admin: keep only runs whose owning job the caller can access (drops runs
    // whose job is absent from the map — defensive; deleteJob already cascades).
    const ownerByJobId = new Map<string, string | undefined>(
      ctx.cron.listJobs().map((j): [string, string | undefined] => [j.id, j.owner])
    );
    return runs.filter((run) => canAccessOwned(user, ownerByJobId.get(run.cronJobId)));
  });
}
