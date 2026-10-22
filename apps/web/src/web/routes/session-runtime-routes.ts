import type { CompanyService } from '../../company-service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionPort } from '../ports/session-port.js';
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

const Input = z.object({
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

export function registerSessionRuntimeRoutes(app: FastifyInstance, ctx: SessionPort & { mux?: { updateSessionMode(id: string, mode: SessionMode): unknown } }, verifiedOwner: (req: FastifyRequest) => boolean, loadSession?: (id: string, req: FastifyRequest) => Session | undefined, company?: CompanyService, onRuntimeSaved?: (session: Session) => Promise<void>) {
  const switching = runtimeSwitches;
  const authorize = (req: FastifyRequest) => req.headers['x-reverie-parent-session'] === undefined && verifiedOwner(req);
  app.post('/api/company/employees/:id/restart', async (req, reply) => {
    if (!authorize(req)) return reply.code(403).send({ success: false, error: 'Only the verified owner may restart an expert' });
    parseBody(z.object({}).strict(), req.body ?? {});
    const employee = company?.view(ownerFor(req)).employees.find((e) => e.id === (req.params as { id: string }).id);
    if (!employee) return reply.code(404).send({ success: false, error: 'Unknown active company expert' });
    if (employee.onVacation) return reply.code(409).send({ success: false, error: 'Return this expert from vacation before restarting' });
    const session = ctx.sessions.get(employee.sessionId) ?? loadSession?.(employee.sessionId, req);
    if (!session) return reply.code(409).send({ success: false, error: 'No saved runtime recipe is available for this expert. Restore their runtime settings before restarting.' });
    const runtime = runtimeView(session);
    if (!runtime.source) return reply.code(409).send({ success: false, error: 'Choose a plan or local model profile in runtime settings before restarting' });
    const headers: Record<string, string> = {};
    for (const name of ['cookie', 'authorization', 'origin', 'host']) {
      const value = req.headers[name]; if (typeof value === 'string') headers[name] = value;
    }
    const response = await app.inject({ method: 'POST', url: '/api/sessions/' + encodeURIComponent(employee.sessionId) + '/runtime', headers, payload: runtime });
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
    if (switching.has(id) || session.isBusy()) return fail(409, 'Wait for this expert to finish before changing runtime');
    if (session.remote || session.docker) return fail(400, 'Remote and nested-container runtimes cannot be changed here');
    const body = parseBody(Input, req.body);
    const entry = getCli(body.mode);
    if (!entry?.enabled || entry.kind !== 'agent') return fail(400, 'Choose an enabled agent harness');
    const effort = hireEffort(body.mode);
    if (body.effort && !effort.values.includes(body.effort)) return fail(400, 'Choose an effort supported by this harness');
    switching.add(id);
    let rollback: (() => void) | undefined;
    let configDir: string | undefined;
    const wasPinned = session.pinned;
    try {
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
        const applied = applyCustomModelInjection(entry, host, resolved.customModel.modelId, session.id, undefined, session.workingDir);
        if (!applied) return fail(400, 'This harness cannot use the selected local profile');
        configDir = applied.configDir; env = applied.envOverrides;
        custom = { ...resolved.customModel, label: host.label, envKeys: applied.envKeys, configDir, launchModel: applied.launchModel };
        model = applied.launchModel;
      }
      if (session.isBusy() || (!detached && ctx.sessions.get(id) !== session) || (detached && loadSession && !loadSession(id, req)))
        return fail(409, 'This expert changed or stopped while runtime settings were being validated');
      const sourceKey = body.source.kind === 'subscription' ? 'subscription:' + body.source.profileId : 'local:' + body.source.endpointId;
      rollback = session.configureRuntime({ mode: body.mode as SessionMode, selection, env, sourceKey, model, effort: body.effort, effortField: effort.field });
      ctx.mux?.updateSessionMode(id, session.mode);
      if (custom) session.setCustomModel(custom, env);
      session.setPinned(true);
      if (detached) {
        await session.startInteractive();
        await ctx.addSession(session);
        await ctx.setupSessionListeners(session);
      } else if (!await session.restartCli()) throw new Error('The selected runtime did not start');
      ctx.persistSessionStateNow(session);
      await onRuntimeSaved?.(session);
      return { success: true, data: runtimeView(session) };
    } catch {
      if (rollback) {
        rollback(); session.setPinned(wasPinned);
        ctx.mux?.updateSessionMode(id, session.mode);
        // Restore the previous account environment in the pane as well as in memory.
        if (detached) await ctx.discardPartiallyBuiltSession(id).catch(() => undefined);
        else if (ctx.sessions.get(id) === session) await session.restartCli().catch(() => false);
        ctx.persistSessionStateNow(session);
      }
      if (configDir) removeConfigDir(configDir);
      return fail(400, 'Runtime change failed; previous settings were restored. Check the account and harness compatibility.');
    } finally { switching.delete(id); }
  });
}
