import { CompanyError, type CompanyService, type RuntimeRestartIntent } from '../../company-service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SessionPort } from '../ports/session-port.js';
import type { EventPort } from '../ports/event-port.js';
import { SseEvent } from '../sse-events.js';
import { clearOwnerStop, ownerStopPending, pendingOwnerStops, recordOwnerStop } from '../../owner-stop-journal.js';
import type { Session } from '../../session.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { selectedSubscription } from '../../subscription-profiles.js';
import { readCustomModelHosts } from '../../custom-model-hosts.js';
import { resolveLocalModelProfile } from '../../local-model-profile.js';
import { applyCustomModelInjection, removeConfigDir } from '../../custom-model-injection-apply.js';
import { getDataDir } from '../../config/instance.js';
import { findSessionOrFail, parseBody, ownerFor, resolveParentSessionId } from '../route-helpers.js';
import { hireEffort } from './company-hire-routes.js';
import { ModelIdSchema } from '../../experts.js';
import type { SessionMode } from '../../types.js';
import { restartEligibility } from '../../session-restart-policy.js';

const Recovery = z.object({
  forceRestart: z.boolean().optional(),
  confirmSessionId: z.string().min(1).max(100).optional(),
}).strict();

const Input = z.object({
  ...Recovery.shape,
  mode: z.string().min(1).max(100),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('subscription'), profileId: z.string().min(1).max(100) }).strict(),
    z.object({ kind: z.literal('local'), endpointId: z.string().min(1).max(100) }).strict(),
  ]),
  model: ModelIdSchema.optional(), effort: z.string().max(30).optional(),
}).strict();

export function runtimeView(session: Session) {
  const state = session.toState();
  const entry = getCli(session.mode);
  const config = entry?.launch.legacyConfigField ? (state as unknown as Record<string, Record<string, unknown>>)[entry.launch.legacyConfigField] : undefined;
  const custom = session.getCustomModelForPersist();
  const effort = hireEffort(session.mode);
  return {
    mode: session.mode,
    source: custom ? { kind: 'local', endpointId: custom.endpointId } : session.subscriptionProfile ? { kind: 'subscription', profileId: session.subscriptionProfile.id } : null,
    model: custom?.modelId ?? config?.model ?? state.model,
    effort: effort.field ? config?.[effort.field] : state.effort,
  };
}

export const runtimeSwitches = new Set<string>();

/**
 * An owner stop's timing. The laptop sends no signal after `dispatchMs` from the request. When the stop's answer is lost,
 * the website asks the laptop to settle it every `settleRetryMs`; no amount of elapsed time settles it by itself.
 */
export interface StopBounds { dispatchMs: number; settleRetryMs: number }
export const STOP_BOUNDS: StopBounds = { dispatchMs: 25_000, settleRetryMs: 5_000 };
/** The laptop's owner stop of one agent and the settle of a stop whose answer was lost (laptop-power-routes). */
/**
 * Settles an owner stop whose answer was lost: asks the laptop every retryMs until it answers that the stop is fenced (it
 * never signals from now on) or that it signalled and the exec that did so has exited (it can signal nothing later).
 * Nothing seen from the website settles it, a dead pane or viewer included: a stop accepted earlier could still run and
 * signal whatever then holds the pane. Never resolves on elapsed time. It also ends once the stop's record is gone
 * (another settling of the same stop finished first). The caller then removes the record and gives the input back.
 */
export async function settleOwnerStop(laptopStop: LaptopAgentStop, sessionId: string, fence: string, retryMs: number): Promise<void> {
  while (ownerStopPending(sessionId)) {
    const answer = await laptopStop.settle(sessionId, fence).catch(() => undefined) as { signalled?: unknown } | undefined;
    if (typeof answer?.signalled === 'boolean') return;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/**
 * After a restart: resume settling every recorded owner stop. Each session's input, restarts and pane replacement stay
 * held (by its record) until the laptop settles the stop, and the record is then removed. Resolves, per record, once its
 * restart hold is back and settling has begun; the settling itself runs until the laptop answers. session names the
 * restored session for a record, if any, for the log.
 */
export function resumeOwnerStops(laptopStop: LaptopAgentStop, session?: (id: string) => Session | undefined,
  retryMs = STOP_BOUNDS.settleRetryMs): Promise<void>[] {
  return pendingOwnerStops().map(async ([id, stop]) => {
    runtimeSwitches.add(id);
    console.log(`[owner-stop] holding ${session?.(id) ? 'restored' : 'unrestored'} session ${id.slice(0, 8)} until its stop is settled`);
    void settleOwnerStop(laptopStop, id, stop.fence, retryMs).finally(() => { clearOwnerStop(id, stop.fence); runtimeSwitches.delete(id); });
  });
}

export interface LaptopAgentStop {
  stop(sessionId: string, notAfter: number, fence: string): Promise<unknown>;
  settle(sessionId: string, fence: string): Promise<unknown>;
}

export function registerSessionRuntimeRoutes(app: FastifyInstance, ctx: SessionPort & Partial<EventPort> & { mux?: { updateSessionMode(id: string, mode: SessionMode): unknown } }, verifiedOwner: (req: FastifyRequest) => boolean, loadSession?: (id: string, req: FastifyRequest) => Session | undefined, company?: CompanyService, onRuntimeSaved?: (session: Session, stillCurrent: () => boolean, preserveRecipe?: boolean) => Promise<void>,
  laptopStop?: LaptopAgentStop, deadPaneWaitMs = 15_000, stopBounds: StopBounds = STOP_BOUNDS) {
  const switching = runtimeSwitches;
  const authorize = (req: FastifyRequest) => req.headers['x-reverie-parent-session'] === undefined && verifiedOwner(req);
  app.post('/api/company/employees/:id/restart', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const self = req.headers['x-reverie-service-token'] === undefined
      ? resolveParentSessionId(ctx, req, undefined, ownerFor(req)) : undefined;
    if (!authorize(req) && !self) return reply.code(403).send({ success: false, error: 'Office management permission is required' });
    let action: ReturnType<CompanyService['officeAction']> | undefined;
    try { action = company?.officeAction?.(id, ownerFor(req), authorize(req) ? undefined : self); }
    catch (error) { if (error instanceof CompanyError) return reply.code(error.status).send({success:false,error:error.message}); throw error; }
    const authorized = () => action ? action.current() : authorize(req);
    if (!authorized()) return reply.code(403).send({ success: false, error: 'Office management permission is required' });
    const recovery = parseBody(Recovery, req.body ?? {});
    const employee = company?.view(ownerFor(req)).employees.find((e) => e.id === (req.params as { id: string }).id);
    if (!employee) return reply.code(404).send({ success: false, error: 'Unknown active company expert' });
    if (employee.onVacation) return reply.code(409).send({ success: false, error: 'Return this expert from vacation before restarting' });
    if (!authorize(req) && employee.desiredRunning === false)
      return reply.code(409).send({success:false,error:'Enter the office before restarting this expert'});
    const session = ctx.sessions.get(employee.sessionId) ?? loadSession?.(employee.sessionId, req);
    if (!session) return reply.code(409).send({ success: false, error: 'No saved runtime recipe is available for this expert. Restore their runtime settings before restarting.' });
    // A wedged agent on an isolated laptop cannot change runtime in place. With the owner's confirmed recovery, the
    // broker stops only that agent's in-laptop process group (no exit receipt, so the laptop keeps running) and the
    // dead-pane recovery below relaunches it with the saved recipe and thread. Raw terminal output is not counted as
    // activity here: a stuck agent keeps redrawing its status line.
    if (!session.hasDeadPane?.() && recovery.forceRestart && laptopStop && process.env.REVERIE_WORKER_SOCKET) {
      if (employee.desiredRunning === false)
        return reply.code(409).send({ success: false, error: 'Enter the office before restarting this expert' });
      if (recovery.confirmSessionId !== session.id)
        return reply.code(409).send({ success: false, error: 'Confirm this current expert session before recovery' });
      // A start, restart or attach in progress may be about to create a process; a stop must not race it (the session refuses
      // any new process while a stop is recorded, see Session._refuseNewProcessWhileStopHeld).
      if (runtimeSwitches.has(session.id) || ownerStopPending(session.id) || session.paneLifecycleInFlight || session.runningTaskCount > 0 || session.paneDialog)
        return reply.code(409).send({ success: false, error: 'Wait for running tasks, an open dialog or an existing restart to finish' });
      if (session.lastSubmitAt > 0 && Date.now() - session.lastSubmitAt < 120_000)
        return reply.code(409).send({ success: false, error: 'Input reached this expert within two minutes; wait before recovering it' });
      // The checks above and this hold run with no await between them: from here no input (a person's included) can reach
      // the agent the owner confirmed as stalled, so the stop below cannot kill newly accepted work. Held until the stop resolves.
      const releaseInput = session.holdInputForRecovery();
      if (!releaseInput)
        return reply.code(409).send({ success: false, error: 'Input is being typed to this expert; wait before recovering it' });
      runtimeSwitches.add(session.id);
      const notAfter = Date.now() + stopBounds.dispatchMs, fence = randomBytes(16).toString('hex');
      // Written (fsync'd) before the request, so that a website restart keeps holding this agent's input until the stop is
      // settled: every Session for this id refuses input while the record exists, and startup resumes settling it.
      try { recordOwnerStop(session.id, { fence, notAfter }); }
      catch {
        runtimeSwitches.delete(session.id); releaseInput();
        return reply.code(503).send({ success: false, error: 'The stop could not be recorded safely, so nothing was stopped. Try again.' });
      }
      const settled = () => { clearOwnerStop(session.id, fence); runtimeSwitches.delete(session.id); releaseInput(); };
      let outcome: unknown;
      if (!authorized()) { settled(); return reply.code(409).send({success:false,error:'Office permission or employee binding changed'}); }
      try {
        outcome = await laptopStop.stop(session.id, notAfter, fence);
      } catch (error) {
        // Unknown outcome (timeout, lost connection, a failure after the signal): an engine exec the laptop accepted can
        // still run, however long ago the client gave up, and would signal whatever then holds the pane. Neither elapsed
        // time nor a dead pane releases anything: input, restarts and pane respawns stay held until the laptop settles
        // this stop's fence (it never signals, or its signal has run and exited).
        void settleOwnerStop(laptopStop, session.id, fence, stopBounds.settleRetryMs).finally(settled);
        return reply.code(409).send({ success: false, error: `The laptop did not confirm the stop (${error instanceof Error ? error.message : 'unknown error'}). ` +
          'This expert\'s input, restarts and any new process in its pane stay held until the laptop confirms whether the stop ran; then open Restart again.' });
      }
      if ((outcome as { dispatched?: unknown } | null)?.dispatched === false) {
        // Definitive: the broker sent no signal, so the agent keeps running and its input is given back now.
        settled();
        const why = (outcome as { error?: unknown }).error;
        return reply.code(409).send({ success: false, error: `The laptop agent was not stopped: ${typeof why === 'string' ? why : 'refused'}` });
      }
      try {
        // The terminal viewer notices the dead inner pane within its two-second check and the pane here exits.
        const deadline = Date.now() + deadPaneWaitMs;
        while (!session.hasDeadPane?.() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      } finally { settled(); }
      if (!session.hasDeadPane?.())
        return reply.code(409).send({ success: false, error: 'The agent was stopped but its session has not reported the exit yet. Open Restart again in a moment.' });
    }
    if (!authorized()) return reply.code(409).send({ success:false,error:'Office permission or employee binding changed' });
    // Preserve saved recipe/account/thread. Normal broker J decides whether
    // to reattach a live provider or stop/settle/recreate its dead inner pane.
    if (session.hasDeadPane?.()) {
      if (employee.desiredRunning === false)
        return reply.code(409).send({ success: false, error: 'Enter the office before restarting this expert' });
      if (recovery.forceRestart && recovery.confirmSessionId !== session.id)
        return reply.code(409).send({ success: false, error: 'Confirm this current expert session before recovery' });
      if (runtimeSwitches.has(session.id) || ownerStopPending(session.id) || session.runningTaskCount > 0)
        return reply.code(409).send({ success: false, error: 'Wait for running tasks or an existing restart to finish' });
      runtimeSwitches.add(session.id);
      let intent: RuntimeRestartIntent | undefined;
      try {
        intent = company?.prepareRuntimeRestart(session.id, ownerFor(req), authorized);
        if (!intent) return reply.code(409).send({ success: false, error: 'Current expert binding is unavailable' });
        const expectedRuntime = JSON.stringify(runtimeView(session));
        const current = () => authorized() && !!intent?.current() && ctx.sessions.get(session.id) === session &&
          JSON.stringify(runtimeView(session)) === expectedRuntime;
        await intent.claim();
        if (!current() || !await session.restartDeadCli(current))
          return reply.code(409).send({ success: false, error: 'Recovery was not confirmed; the expert changed, stopped or its pane is already live' });
        if (!current()) return reply.code(409).send({ success: false, error: 'This expert changed or stopped during recovery' });
        ctx.persistSessionStateNow(session);
        await onRuntimeSaved?.(session, current, true);
        if (!current()) return reply.code(409).send({ success: false, error: 'This expert changed or stopped during recovery' });
        const state = ctx.getSessionStateWithRespawn?.(session);
        if (state !== undefined) ctx.broadcast?.(SseEvent.SessionUpdated, { session: state });
        return { success: true, data: { employee: company?.view(ownerFor(req)).employees.find(e => e.id === employee.id),
          sessionId: session.id, recovery: 'normal-launch-requested' } };
      } catch (error) {
        if (error instanceof CompanyError) return reply.code(error.status).send({ success: false, error: error.message });
        // No automatic second launch, rollback restart, lease break or provider signal.
        return reply.code(409).send({ success: false, error: 'Recovery outcome is unconfirmed. Reconnect to inspect this expert before another action.' });
      } finally { intent?.finish(); runtimeSwitches.delete(session.id); }
    }
    // A live isolated laptop is never replaced in place: the runtime route refuses it before any work check, with
    // or without stalled-session recovery. Leaving and entering the office stops and starts that laptop under the same
    // identity, so the owner is told that instead of a refusal they cannot act on.
    if (process.env.REVERIE_WORKER_SOCKET && ctx.sessions.has(session.id))
      return reply.code(409).send({ success: false, error: `${employee.name || 'This expert'}’s laptop is running, so Restart cannot replace it in place. To recover them, use Leave office, then Enter office. That stops and starts their laptop and keeps their identity, saved conversation, memory and files.` });
    const runtime = runtimeView(session);
    if (!runtime.source) return reply.code(409).send({ success: false, error: 'Choose a plan or local model profile in runtime settings before restarting' });
    const result = await changeRuntime(req, reply, employee.sessionId, Input.parse({ ...runtime, ...recovery }), authorized, true);
    if (!result.success) return result;
    return {success:true,data:{employee:company?.view(ownerFor(req)).employees.find(e=>e.id===employee.id),sessionId:employee.sessionId,recovery:'normal-launch-requested'}};
  });
  app.get('/api/sessions/:id/runtime', async (req, reply) => {
    if (!authorize(req)) return reply.code(403).send({ success: false, error: 'Only the verified owner may view runtime settings' });
    const id = (req.params as { id: string }).id;
    const session = ctx.sessions.has(id) ? findSessionOrFail(ctx, id, req) : loadSession?.(id, req);
    if (!session) return reply.code(404).send({ success: false, error: 'Unknown expert runtime' });
    return { success: true, data: runtimeView(session) };
  });
  const changeRuntime = async (req: FastifyRequest, reply: import('fastify').FastifyReply, id: string,
    body: z.infer<typeof Input>, authorized: () => boolean, preserveRecipe = false) => {
    if (!authorized()) return reply.code(403).send({ success: false, error: 'Runtime action is no longer authorized' });
    const detached = !ctx.sessions.has(id);
    const session = detached ? loadSession?.(id, req) : findSessionOrFail(ctx, id, req);
    if (!session) return reply.code(404).send({ success: false, error: 'Unknown expert runtime' });
    const fail = (status: number, error: string) => reply.code(status).send({ success: false, error });
    // A worker transport respawn replaces the server's terminal viewer. The
    // broker may reuse its still-running laptop and ignore the new launch line,
    // so a new viewer PID cannot confirm a runtime switch. Keep the selected
    // recipe intact until a supported whole-session replacement is performed.
    if (!detached && process.env.REVERIE_WORKER_SOCKET)
      return fail(409, 'An isolated laptop cannot change runtime in place. Use a supported whole-session replacement; reconnecting its terminal does not restart the running agent.');
    const workBlocked = () => {
      const state = restartEligibility(session);
      if (body.forceRestart) return body.confirmSessionId !== id || !state.recoverable;
      return state.blocked;
    };
    if (switching.has(id) || workBlocked()) return fail(409, 'Wait for current work to finish. Recovery requires a confirmed stalled session with no running tasks or recent activity.');
    if (session.remote || session.docker) return fail(400, 'Remote and nested-container runtimes cannot be changed here');
    const entry = getCli(body.mode);
    if (!entry?.enabled || entry.kind !== 'agent') return fail(400, 'Choose an enabled agent harness');
    const effort = hireEffort(body.mode);
    if (body.effort && !effort.values.includes(body.effort)) return fail(400, 'Choose an effort supported by this harness');
    switching.add(id);
    let rollback: (() => void) | undefined;
    let configDir: string | undefined;
    let intent: RuntimeRestartIntent | undefined;
    let launchAttempted = false;
    const wasPinned = session.pinned;
    try {
      intent = company?.prepareRuntimeRestart?.(id, ownerFor(req), authorized);
      const requireIntent = () => {
        if (!authorized() || (intent && !intent.current())) throw new CompanyError('This expert changed or stopped during restart', 409);
      };
      let selection: typeof session.subscriptionProfile;
      let env: Record<string, string> = {};
      let custom: { endpointId: string; modelId: string; label: string; envKeys: string[]; configDir?: string; launchModel?: string } | undefined;
      let model = body.model;
      if (body.source.kind === 'subscription') {
        const account = await selectedSubscription(body.source.profileId, body.mode);
        selection = account.selection; env = account.env;
      } else {
        if (entry.capabilities.customModelInjection.kind === 'unsupported') return fail(400, 'This harness cannot use local models');
        const hosts = await readCustomModelHosts(getDataDir());
        const resolved = resolveLocalModelProfile(hosts, body.source.endpointId, body.model);
        const endpointId = body.source.endpointId;
        const host = hosts.find((h) => h.id === endpointId)!;
        // Config-directory injection rewrites files before restart and cannot safely roll back in place.
        if (entry.capabilities.customModelInjection.kind === 'configDir') return fail(400, 'This harness needs a separate session to change local model profiles safely');
        // The discovered window drives claude's CLAUDE_CODE_MAX_CONTEXT_TOKENS, as on quick-start.
        const contextLength = host.modelContextLengths?.[resolved.customModel.modelId];
        const applied = applyCustomModelInjection(entry, host, resolved.customModel.modelId, session.id, contextLength, session.workingDir);
        if (!applied) return fail(400, 'This harness cannot use the selected local profile');
        configDir = applied.configDir; env = applied.envOverrides;
        custom = { ...resolved.customModel, label: host.label, envKeys: applied.envKeys, configDir, launchModel: applied.launchModel };
        model = applied.launchModel;
      }
      if (!authorized() || workBlocked() || (!detached && ctx.sessions.get(id) !== session) || (detached && loadSession && !loadSession(id, req)))
        return fail(409, 'This expert changed or stopped while runtime settings were being validated');
      // The laptop broker reads this durable flag before accepting any launch.
      await intent?.claim();
      requireIntent();
      const sourceKey = body.source.kind === 'subscription' ? 'subscription:' + body.source.profileId : 'local:' + body.source.endpointId;
      rollback = session.configureRuntime({ mode: body.mode as SessionMode, selection, env, sourceKey, model, effort: body.effort, effortField: effort.field, preserveRecipe });
      ctx.mux?.updateSessionMode(id, session.mode);
      if (custom && !preserveRecipe) session.setCustomModel(custom, env);
      session.setPinned(true);
      launchAttempted = true;
      if (detached) {
        await session.startInteractive();
        requireIntent();
        await ctx.addSession(session);
        requireIntent();
        await ctx.setupSessionListeners(session);
      } else if (!await session.restartCli()) throw new Error('The selected runtime did not start');
      requireIntent();
      ctx.persistSessionStateNow(session);
      await onRuntimeSaved?.(session, () => authorized() && (!intent || intent.current()), preserveRecipe);
      requireIntent();
      const state = ctx.getSessionStateWithRespawn?.(session);
      if (state !== undefined) ctx.broadcast?.(detached ? SseEvent.SessionCreated : SseEvent.SessionUpdated,
        detached ? state : { session: state });
      return { success: true, data: runtimeView(session) };
    } catch (error) {
      if (rollback) {
        rollback(); session.setPinned(wasPinned);
        ctx.mux?.updateSessionMode(id, session.mode);
        // Restore the previous account environment in the pane as well as in memory.
        if (launchAttempted && detached) {
          // A failed start may have created a pane before registration; discard cannot see it yet.
          if (ctx.sessions.get(id) === session) await ctx.discardPartiallyBuiltSession(id).catch(() => undefined);
          else await session.stop().catch(() => undefined);
        } else if (launchAttempted && (!authorized() || intent?.originallyStopped || (intent && !intent.current()))) {
          await session.stop().catch(() => undefined);
        } else if (!preserveRecipe && launchAttempted && ctx.sessions.get(id) === session) await session.restartCli().catch(() => false);
        ctx.persistSessionStateNow(session);
      }
      await intent?.rollback();
      if (configDir) removeConfigDir(configDir);
      if (error instanceof CompanyError) return fail(error.status, error.message);
      return preserveRecipe
        ? fail(409, 'Runtime start outcome is unconfirmed. Inspect the expert before another explicit action.')
        : fail(400, 'Runtime change failed; previous settings were restored. Check the account and harness compatibility.');
    } finally { intent?.finish(); switching.delete(id); }
  };
  app.post('/api/sessions/:id/runtime', async (req, reply) => {
    if (!authorize(req)) return reply.code(403).send({success:false,error:'Only the verified owner may change runtime settings'});
    return changeRuntime(req, reply, (req.params as {id:string}).id, parseBody(Input,req.body), () => authorize(req));
  });
  // Internal closed same-recipe entry for an explicit attendance action. No HTTP identity is fabricated.
  return async (id: string, req: FastifyRequest, reply: import('fastify').FastifyReply, authorized: () => boolean) => {
    if (!authorized()) throw new CompanyError('Office permission or employee binding changed',409);
    const employee=company?.view(ownerFor(req)).employees.find(e=>e.id===id);
    if (!employee || employee.onVacation || employee.desiredRunning===false)
      throw new CompanyError('Employee is no longer in the office',409);
    const session=ctx.sessions.get(employee.sessionId) ?? loadSession?.(employee.sessionId,req);
    if (!session) throw new CompanyError('No saved runtime recipe is available for this expert',409);
    const runtime=runtimeView(session);
    if (!runtime.source) throw new CompanyError('Saved runtime source is unavailable',409);
    return changeRuntime(req,reply,employee.sessionId,Input.parse(runtime),authorized,true);
  };
}
