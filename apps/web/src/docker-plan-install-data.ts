/** Closed path/receipt DATA for the fixed native installer. None of these values
 * provides source-stop, account, request, paid-dispatch or provider authority. */
import { z } from 'zod';
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .regex(/^[0-9a-f-]{36}$/),
  decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const selection = z
  .object({
    operationId: uuid,
    projectionDigest: digest,
    provider: z.enum(['anthropic', 'openai']),
  })
  .strict();
export const DockerPlanGeneration = selection.extend({ containerId: digest });
export type DockerPlanGeneration = z.infer<typeof DockerPlanGeneration>;
function generation(input: z.infer<typeof selection>): string {
  return '/home/agent/.reverie/plan-moves/' + input.operationId + '/generation-' + input.projectionDigest;
}
export function dockerPlanGeneration(input: DockerPlanGeneration): Readonly<{
  generation: string;
  configDir: string;
  identityFile: string;
}> {
  const value = DockerPlanGeneration.parse(input),
    root = generation(value);
  return Object.freeze({
    generation: root,
    configDir: root + (value.provider === 'anthropic' ? '/claude' : '/codex'),
    identityFile: root + '/worker-identity-' + value.containerId,
  });
}
/** Account routing belongs to the selected subscription, not inherited source
 * image credentials. Ordinary tool/workspace environment remains intact. */
function accountEnvironment(key: string): boolean {
  return (
    [
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'CODEX_API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_ORGANIZATION',
      'OPENAI_ORG_ID',
      'OPENAI_PROJECT_ID',
      'CLAUDE_CODE_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
      'REVERIE_WORKER_IDENTITY_FILE',
      'REVERIE_SESSION_ID',
      'REVERIE_DOCKER_OPERATION_ID',
      'REVERIE_HOOK_GENERATION',
      'REVERIE_WORKER',
      'REVERIE_WORKER_SOCKET',
      'REVERIE_WORKER_VIEWER_SOCKET',
    ].includes(key) || key.startsWith('ANTHROPIC_FOUNDRY_')
  );
}
export function dockerPlanDestinationEnvironment(
  source: readonly string[],
  input: Omit<DockerPlanGeneration, 'containerId'>
): readonly string[] {
  const selected = selection.parse(input),
    seen = new Set<string>(),
    result: string[] = [];
  if (source.length > 512) throw Error('Docker source environment unconfirmed');
  for (const entry of source) {
    const at = entry.indexOf('='),
      key = entry.slice(0, at);
    if (
      at < 1 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      entry.includes('\0') ||
      entry.length > 16384 ||
      seen.has(key)
    )
      throw Error('Docker source environment unconfirmed');
    seen.add(key);
    if (!accountEnvironment(key)) result.push(entry);
  }
  result.push(
    (selected.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR=' : 'CODEX_HOME=') +
      generation(selected) +
      (selected.provider === 'anthropic' ? '/claude' : '/codex')
  );
  return Object.freeze(result);
}
const receipt = {
  version: z.literal(1),
  operationId: uuid,
  sessionId: uuid,
  containerId: digest,
  projectionDigest: digest,
  accountId: z.string().min(1).max(100),
  provider: z.enum(['anthropic', 'openai']),
  contextInputDigest: digest,
  installedAuthDigest: digest,
  observedAuthDigest: digest,
  tokenDigest: digest,
  contextDigest: digest,
  observedContextDigest: digest,
  homeDev: decimal,
  homeIno: decimal,
  configDev: decimal,
  configIno: decimal,
};
export const DockerPlanInitialReceipt = z
  .object({
    ...receipt,
    purpose: z.literal('reverie-plan-installed-v1'),
    readMode: z.literal('initial'),
  })
  .strict()
  .refine(
    (value) =>
      value.installedAuthDigest === value.observedAuthDigest && value.contextDigest === value.observedContextDigest
  );
export type DockerPlanInitialReceipt = z.infer<typeof DockerPlanInitialReceipt>;
/** Historical installed facts are distinct from fresh SDK observations. This
 * never asserts the provider's current authenticated account or launch credit. */
export const DockerPlanLiveReceipt = z
  .object({
    ...receipt,
    purpose: z.literal('reverie-plan-live-observation-v1'),
    readMode: z.literal('live'),
  })
  .strict();
export type DockerPlanLiveReceipt = z.infer<typeof DockerPlanLiveReceipt>;
