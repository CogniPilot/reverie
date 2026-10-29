import { CompanyError, type CompanyService, type RuntimeRestartIntent } from '../../company-service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionPort } from '../ports/session-port.js';
import type { EventPort } from '../ports/event-port.js';
import { SseEvent } from '../sse-events.js';
import type { Session } from '../../session.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { selectedSubscription } from '../../subscription-profiles.js';
import { readCustomModelHosts } from '../../custom-model-hosts.js';
import { resolveLocalModelProfile } from '../../local-model-profile.js';
import { applyCustomModelInjection, removeConfigDir } from '../../custom-model-injection-apply.js';
import { getDataDir } from '../../config/instance.js';
import { findSessionOrFail, parseBody, ownerFor } from '../route-helpers.js';
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

export function registerSessionRuntimeRoutes(app: FastifyInstance, ctx: SessionPort & Partial<EventPort> & { mux?: { updateSessionMode(id: string, mode: SessionMode): unknown } }, verifiedOwner: (req: FastifyRequest) => boolean, loadSession?: (id: string, req: FastifyRequest) => Session | undefined, company?: CompanyService, onRuntimeSaved?: (session: Session) => Promise<void>) {
  const switching = runtimeSwitches;
  const authorize = (req: FastifyRequest) => req.headers['x-reverie-parent-session'] === undefined && verifiedOwner(req);
  app.post('/api/company/employees/:id/restart', async (req, reply) => {
    if (!authorize(req)) return reply.code(403).send({ success: false, error: 'Only the verified owner may restart an expert' });
    const recovery = parseBody(Recovery, req.body ?? {});
    const employee = company?.view(ownerFor(req)).employees.find((e) => e.id === (req.params as { id: string }).id);
    if (!employee) return reply.code(404).send({ success: false, error: 'Unknown active company expert' });
    if (employee.onVacation) return reply.code(409).send({ success: false, error: 'Return this expert from vacation before restarting' });
    const session = ctx.sessions.get(employee.sessionId) ?? loadSession?.(employee.sessionId, req);
    if (!session) return reply.code(409).send({ success: false, error: 'No saved runtime recipe is available for this expert. Restore their runtime settings before restarting.' });
    // Preserve saved recipe/account/thread. Normal broker J decides whether
    // to reattach a live provider or stop/settle/recreate its dead inner pane.
    if (session.hasDeadPane?.()) {
      if (employee.desiredRunning === false)
        return reply.code(409).send({ success: false, error: 'Enter the office before restarting this expert' });
      if (recovery.forceRestart && recovery.confirmSessionId !== session.id)
        return reply.code(409).send({ success: false, error: 'Confirm this current expert session before recovery' });
      if (runtimeSwitches.has(session.id) || session.runningTaskCount > 0)
        return reply.code(409).send({ success: false, error: 'Wait for running tasks or an existing restart to finish' });
      runtimeSwitches.add(session.id);
      let intent: RuntimeRestartIntent | undefined;
      try {
        intent = company?.prepareRuntimeRestart(session.id, ownerFor(req));
        if (!intent) return reply.code(409).send({ success: false, error: 'Current expert binding is unavailable' });
        const expectedRuntime = JSON.stringify(runtimeView(session));
        const current = () => !!intent?.current() && ctx.sessions.get(session.id) === session &&
          JSON.stringify(runtimeView(session)) === expectedRuntime;
        await intent.claim();
        if (!current() || !await session.restartDeadCli(current))
          return reply.code(409).send({ success: false, error: 'Recovery was not confirmed; the expert changed, stopped or its pane is already live' });
        if (!current()) return reply.code(409).send({ success: false, error: 'This expert changed or stopped during recovery' });
        ctx.persistSessionStateNow(session);
        await onRuntimeSaved?.(session);
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
    const runtime = runtimeView(session);
    if (!runtime.source) return reply.code(409).send({ success: false, error: 'Choose a plan or local model profile in runtime settings before restarting' });
    const headers: Record<string, string> = {};
    for (const name of ['cookie', 'authorization', 'origin', 'host']) {
      const value = req.headers[name]; if (typeof value === 'string') headers[name] = value;
    }
    const response = await app.inject({ method: 'POST', url: '/api/sessions/' + encodeURIComponent(employee.sessionId) + '/runtime', headers, payload: { ...runtime, ...recovery } });
    if (response.statusCode >= 400) return reply.code(response.statusCode).send(response.json());
    return { success: true, data: { employee: company?.view(ownerFor(req)).employees.find((e) => e.id === employee.id), sessionId: employee.sessionId } };
  });
  app.get('/api/sessions/:id/runtime', async (req, reply) => {
    if (!authorize(req)) return reply.code(403).send({ success: false, error: 'Only the verified owner may view runtime settings' });
    const id = (req.params as { id: string }).id;
    const session = ctx.sessions.has(id) ? findSessionOrFail(ctx, id, req) : loadSession?.(id, req);
    if (!session) return reply.code(404).send({ success: false, error: 'Unknown expert runtime' });
    return { success: true, data: runtimeView(session) };
  });
  app.post('/api/sessions/:id/runtime', async (req, reply) => {
    if (!authorize(req)) return reply.code(403).send({ success: false, error: 'Only the verified owner may change runtime settings' });
    const { id } = req.params as { id: string };
    const detached = !ctx.sessions.has(id);
    const session = detached ? loadSession?.(id, req) : findSessionOrFail(ctx, id, req);
    if (!session) return reply.code(404).send({ success: false, error: 'Unknown expert runtime' });
    const fail = (status: number, error: string) => reply.code(status).send({ success: false, error });
    const body = parseBody(Input, req.body);
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
      intent = company?.prepareRuntimeRestart?.(id, ownerFor(req));
      const requireIntent = () => {
        if (intent && !intent.current()) throw new CompanyError('This expert changed or stopped during restart', 409);
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
      if (workBlocked() || (!detached && ctx.sessions.get(id) !== session) || (detached && loadSession && !loadSession(id, req)))
        return fail(409, 'This expert changed or stopped while runtime settings were being validated');
      // The laptop broker reads this durable flag before accepting any launch.
      await intent?.claim();
      requireIntent();
      const sourceKey = body.source.kind === 'subscription' ? 'subscription:' + body.source.profileId : 'local:' + body.source.endpointId;
      rollback = session.configureRuntime({ mode: body.mode as SessionMode, selection, env, sourceKey, model, effort: body.effort, effortField: effort.field });
      ctx.mux?.updateSessionMode(id, session.mode);
      if (custom) session.setCustomModel(custom, env);
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
      await onRuntimeSaved?.(session);
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
        } else if (launchAttempted && (intent?.originallyStopped || (intent && !intent.current()))) {
          await session.stop().catch(() => undefined);
        } else if (launchAttempted && ctx.sessions.get(id) === session) await session.restartCli().catch(() => false);
        ctx.persistSessionStateNow(session);
      }
      await intent?.rollback();
      if (configDir) removeConfigDir(configDir);
      if (error instanceof CompanyError) return fail(error.status, error.message);
      return fail(400, 'Runtime change failed; previous settings were restored. Check the account and harness compatibility.');
    } finally { intent?.finish(); switching.delete(id); }
  });
}
