/** Fixed launcher DATA only. Every installed history release still checks the
 * canonical current-session API; parsing this object never grants permission.
 */
import { z } from 'zod';
import { InstalledMemorySummarySchema } from './installed-memory-context.js';
import { InstalledMemoryBridge } from './installed-memory-bridge.js';
import { resolveMcpConfig, type McpConfig } from './mcp-server.js';
import type { MemoryToolsConfig } from './mcp-memory-tools.js';

const bootstrapSchema = z
  .object({
    schema: z.literal('reverie-installed-mcp-bootstrap-v1'),
    nativeMemory: z.string(),
    context: InstalledMemorySummarySchema,
    options: z.object({ url: z.string().nullable(), allowAnySession: z.boolean(), chat: z.boolean() }).strict(),
  })
  .strict();

export function installedMcpBootstrap(
  args: string[],
  version: string,
  env: NodeJS.ProcessEnv = process.env
): {
  config: McpConfig;
  memory: MemoryToolsConfig;
} {
  const [count, ...parts] = args;
  if (
    !count ||
    !/^[1-9][0-9]?$/.test(count) ||
    Number(count) !== parts.length ||
    parts.some((part) => Buffer.byteLength(part) > 32 * 1024) ||
    parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0) > 512 * 1024
  )
    throw new Error('Installed MCP bootstrap unavailable');
  const bootstrap = bootstrapSchema.parse(JSON.parse(parts.join('')));
  const native = InstalledMemoryBridge.capture(bootstrap.nativeMemory, env);
  const installed = bootstrap.context.data;
  const options = { ...bootstrap.options, url: bootstrap.options.url ?? undefined, version };
  if (installed) {
    if (options.url && options.url !== bootstrap.context.officeApiUrl)
      throw new Error('Installed MCP uses its fixed Office connection');
    // A context describes the selected session. The actual Office phone and
    // canonical API authenticate it; no ambient password enters this channel.
    const config = resolveMcpConfig({ ...options, url: bootstrap.context.officeApiUrl }, {}, () => ({}));
    config.selfId = installed.employee.sessionId;
    config.auth = undefined;
    return { config, memory: { native, installed } };
  }
  const instance = env.REVERIE_MCP_MEMORY_INSTANCE?.trim();
  return {
    config: resolveMcpConfig(options, env),
    memory: { native, instance: instance?.startsWith('/') ? instance : undefined },
  };
}
