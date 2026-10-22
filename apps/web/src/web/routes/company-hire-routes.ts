import type { RuntimeRecipe } from '../../expert-runtime-recipe.js';
/** Owner hiring: create a fresh runtime, then bind a persistent expert identity. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CompanyError, type CompanyService } from '../../company-service.js';
import { EmployeeSchema } from '../../company-types.js';
import { COMPANY_ROLE_TEMPLATES } from '../../company-role-templates.js';
import { getCli, listClis } from '../../config/cli-registry/registry.js';
import { EFFORT_LEVELS } from '../../types/session.js';
import { ModelIdSchema, sessionCreateBody } from '../../experts.js';
import { subscriptionBinding, type SubscriptionProfile } from '../../subscription-profiles.js';
import type { CustomModelHost } from '../../custom-model-hosts.js';
import { resolveLocalModelProfile } from '../../local-model-profile.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { isAdmin, ownerFor, parseBody } from '../route-helpers.js';

const HireSchema = EmployeeSchema.pick({
  name: true,
  icon: true,
  position: true,
  expertise: true,
  responsibilities: true,
  personality: true,
  permissions: true,
  sleepEnabled: true,
  dreamEnabled: true,
  reportsTo: true,
  pronouns: true,
  voice: true,
})
  .extend({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('subscription'), profileId: z.string().min(1).max(100) }).strict(),
      z.object({ kind: z.literal('local'), endpointId: z.string().min(1).max(100) }).strict(),
    ]),
    mode: z.string().min(1).max(100),
    model: ModelIdSchema.optional(),
    effort: z.string().max(30).optional(),
  })
  .strict();

export function hireEffort(mode: string): { values: readonly string[]; field?: string } {
  const entry = getCli(mode);
  if (mode === 'claude') return { values: EFFORT_LEVELS };
  for (const name of ['reasoningEffort', 'thinking', 'effort']) {
    const param = entry?.launch.params?.[name];
    if (param?.type === 'enum') return { values: param.values, field: name };
  }
  return { values: [] };
}

export interface CompanyHireDeps {
  company: CompanyService;
  verifiedOwner(req: FastifyRequest): boolean;
  profiles(): Promise<SubscriptionProfile[]>;
  endpoints(): Promise<CustomModelHost[]>;
  /** Normal quick-start route, with the owner's credentials and Origin preserved. */
  start(req: FastifyRequest, body: Record<string, unknown>): Promise<string>;
  captureRuntime?(sessionId: string): RuntimeRecipe;
  stop(sessionId: string): Promise<void>;
  forget(owner: string | undefined, sessionId: string): Promise<void>;
}

export function registerCompanyHireRoutes(app: FastifyInstance, deps: CompanyHireDeps): void {
  const authorize = (req: FastifyRequest) => {
    if (req.headers['x-reverie-parent-session'] !== undefined || !deps.verifiedOwner(req))
      throw new CompanyError('Only the verified owner may hire an expert', 403);
    if (isMultiUserMode() && !isAdmin(req)) throw new CompanyError('Plan and model selection is admin-only', 403);
  };
  const run = async (req: FastifyRequest, reply: { code(n: number): unknown }, work: () => Promise<unknown>) => {
    try {
      authorize(req);
      return { success: true, data: await work() };
    } catch (error) {
      if (!(error instanceof CompanyError)) throw error;
      reply.code(error.status);
      return { success: false, error: error.message };
    }
  };
  app.get('/api/company/hire-options', async (req, reply) =>
    run(req, reply, async () => {
      const harnesses = listClis().filter((c) => c.enabled && c.kind === 'agent');
      const [profiles, endpoints] = await Promise.all([deps.profiles(), deps.endpoints()]);
      const localHarnesses = harnesses.filter((c) => c.capabilities.customModelInjection.kind !== 'unsupported');
      const localDefault = localHarnesses.find((c) => c.id === 'opencode') ?? localHarnesses.find((c) => !c.stock) ?? localHarnesses[0];
      return {
        roles: COMPANY_ROLE_TEMPLATES,
        harnesses: harnesses.map((c) => ({ id: c.id, label: c.label, efforts: hireEffort(c.id).values })),
        sources: [
          ...profiles.map((p) => {
            const compatible = harnesses.filter((c) => subscriptionBinding(c.id, p.provider));
            const official = p.provider === 'openai' ? 'codex' : 'claude';
            const modes = [
              ...compatible.filter((c) => c.id === official),
              ...compatible.filter((c) => c.id !== official && subscriptionBinding(c.id, p.provider) === 'native'),
              ...compatible.filter((c) => subscriptionBinding(c.id, p.provider) !== 'native'),
            ].map((c) => c.id);
            return {
            kind: 'subscription',
            id: p.id,
            label: p.label,
            modes,
            defaultMode: modes[0],
            models: [],
            };
          }),
          ...endpoints.map((p) => ({
            kind: 'local',
            id: p.id,
            label: p.label,
            modes: localHarnesses.map((c) => c.id),
            defaultMode: localDefault?.id,
            models: p.models,
            defaultModel: p.defaultModelId,
          })),
        ],
      };
    })
  );
  app.post('/api/company/hire', async (req, reply) =>
    run(req, reply, async () => {
      const body = parseBody(HireSchema, req.body);
      const source = body.source;
      const entry = getCli(body.mode);
      if (!entry?.enabled || entry.kind !== 'agent') throw new CompanyError('Choose an enabled agent harness');
      const effort = hireEffort(body.mode);
      if (body.effort && !effort.values.includes(body.effort))
        throw new CompanyError('Choose an effort supported by this harness');
      const owner = ownerFor(req);
      if (deps.company.view(owner).employees.some(e => e.name.normalize('NFKC').toLowerCase() === body.name.trim().normalize('NFKC').toLowerCase()))
        throw new CompanyError('That name is already used in this company. Choose a distinct name.', 409);
      const profile =
        source.kind === 'subscription' ? (await deps.profiles()).find((p) => p.id === source.profileId) : undefined;
      if (source.kind === 'subscription' && (!profile || !subscriptionBinding(body.mode, profile.provider)))
        throw new CompanyError('Choose a plan compatible with this harness');
      let customModel: { endpointId: string; modelId: string } | undefined;
      if (source.kind === 'local') {
        if (entry.capabilities.customModelInjection.kind === 'unsupported')
          throw new CompanyError('This harness cannot use a local model profile');
        try {
          customModel = resolveLocalModelProfile(await deps.endpoints(), source.endpointId, body.model).customModel;
        } catch (error) {
          throw new CompanyError(error instanceof Error ? error.message : 'Invalid local model profile');
        }
      }
      const launch = sessionCreateBody({
        workingDir: '/',
        name: body.name,
        icon: body.icon,
        mode: body.mode,
        ...(!customModel && body.model ? { model: body.model } : {}),
        ...(profile ? { accountProfileId: profile.id } : {}),
      });
      delete launch.workingDir;
      delete launch.name;
      if (launch.model) {
        launch.modelOverride = launch.model;
        delete launch.model;
      }
      if (body.effort) {
        if (effort.field && entry.launch.legacyConfigField) {
          const field = entry.launch.legacyConfigField;
          launch[field] = { ...((launch[field] as object) ?? {}), [effort.field]: body.effort };
        } else launch.effort = body.effort;
      }
      const sessionId = await deps.start(req, {
        ...launch,
        pinned: true,
        caseName: 'expert-' + randomUUID(),
        sessionName: body.name,
        ...(customModel ? { customModel } : {}),
      });
      try {
        const employee = await deps.company.hire({
          name: body.name,
          icon: body.icon,
          position: body.position,
          expertise: body.expertise,
          responsibilities: body.responsibilities,
          personality: body.personality,
          permissions: body.permissions,
          reportsTo: body.reportsTo,
          pronouns: body.pronouns,
          voice: body.voice,
          sessionId,
          runtimeRecipe: deps.captureRuntime?.(sessionId),
          owner,
          researchEnabled: false,
          sleepEnabled: body.sleepEnabled,
          dreamEnabled: body.dreamEnabled,
          desiredRunning: true,
        });
        return { employee, sessionId };
      } catch (error) {
        // Never leave a running anonymous replacement when durable registration fails.
        await deps.stop(sessionId);
        await deps.forget(owner, sessionId);
        throw error;
      }
    })
  );
}
