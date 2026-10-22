import { z } from 'zod';
import type { Session } from './session.js';

const CONFIG_KEYS = ['openCodeConfig', 'codexConfig', 'geminiConfig', 'antigravityConfig', 'piConfig', 'grokConfig', 'deepSeekConfig', 'ompConfig'];
const config = z.object({
  model: z.string().optional(), continueSession: z.string().optional(), resumeSessionId: z.string().optional(),
  forkSession: z.boolean().optional(), reasoningEffort: z.string().optional(), thinking: z.string().optional(),
  effort: z.string().optional(), autoAllowTools: z.boolean().optional(), dangerouslyBypassApprovals: z.boolean().optional(),
  approvalMode: z.string().optional(), sandboxMode: z.string().optional(),
}).strict();
export const RuntimeRecipeSchema = z.object({
  mode: z.string().min(1), workingDir: z.string().min(1), model: z.string().optional(), effort: z.string().optional(),
  subscriptionProfile: z.object({ id: z.string(), label: z.string(), provider: z.enum(['openai', 'anthropic']) }).optional(),
  customModel: z.object({ endpointId: z.string(), modelId: z.string() }).optional(),
  runtimeThreads: z.record(z.string(), z.string()).optional(),
  configs: z.record(z.string().refine((name) => CONFIG_KEYS.includes(name), 'Unknown harness configuration block'), config).default({}),
}).strict();
export type RuntimeRecipe = z.infer<typeof RuntimeRecipeSchema>;

const SAFE_KEYS = new Set(['model', 'continueSession', 'resumeSessionId', 'forkSession', 'reasoningEffort', 'thinking', 'effort', 'autoAllowTools', 'dangerouslyBypassApprovals', 'approvalMode', 'sandboxMode']);
/** A launch recipe carries references and switches only, never environment/config blobs or credentials. */
export function expertRuntimeRecipe(session: Session): RuntimeRecipe {
  const state = session.toState();
  const configs: RuntimeRecipe['configs'] = {};
  for (const name of CONFIG_KEYS) {
    const value = (state as unknown as Record<string, unknown>)[name];
    if (value && typeof value === 'object') configs[name] = config.parse(Object.fromEntries(Object.entries(value).filter(([key, v]) => SAFE_KEYS.has(key) && ['string', 'boolean', 'number'].includes(typeof v))));
  }
  const custom = session.getCustomModelForPersist();
  return RuntimeRecipeSchema.parse({ mode: session.mode, workingDir: session.workingDir, model: state.model, effort: state.effort,
    subscriptionProfile: session.subscriptionProfile, runtimeThreads: state.runtimeThreads, configs,
    customModel: custom ? { endpointId: custom.endpointId, modelId: custom.modelId } : undefined });
}
