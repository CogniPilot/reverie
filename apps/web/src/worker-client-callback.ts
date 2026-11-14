/** Fixed callback targets; credential bytes live only in the actual private file. */
import { Readable } from 'node:stream';
import { HookEventSchema, StatusTelemetrySchema } from './worker-callback-data.js';
import { httpRequest, resolveAgentContext, type ApiRequest } from './cli-agent.js';
import { WORKER_CLIENT_ENTRY } from './worker-client-manifest.js';
import { HOOK_TIMEOUT_SECONDS } from './config/auth-config.js';
const MAX_INPUT = 64 * 1024;
async function inputJson(input: Readable): Promise<Record<string, unknown>> {
  const timer = setTimeout(() => input.destroy(Error('Worker callback input timeout')), 2000);
  timer.unref();
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const part of input) {
      const bytes = Buffer.from(part);
      total += bytes.length;
      if (total > MAX_INPUT) throw Error('Worker callback input bound exceeded');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks),
      raw = bytes.toString('utf8'),
      value: unknown = JSON.parse(raw);
    if (!Buffer.from(raw).equals(bytes) || !value || typeof value !== 'object' || Array.isArray(value))
      throw Error('Worker callback input refused');
    return value as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}
export async function workerCallback(
  kind: 'hook-event' | 'status-telemetry',
  event: string | undefined,
  input: Readable = process.stdin,
  env: NodeJS.ProcessEnv = process.env,
  request: ApiRequest = httpRequest
): Promise<string | undefined> {
  if (env.REVERIE_WORKER_IDENTITY_FILE === undefined) throw Error('Bound worker callback credential required');
  const ctx = resolveAgentContext(env);
  if (!ctx.workerIdentity) throw Error('Bound worker callback credential required');
  const data = await inputJson(input),
    headers: Record<string, string> = {};
  const generation = env.REVERIE_HOOK_GENERATION;
  if (generation !== undefined) {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(generation)) throw Error('Worker hook generation refused');
    headers['X-Reverie-Hook-Generation'] = generation;
  }
  if (kind === 'hook-event' && !generation) throw Error('Current worker hook generation required');
  const body =
    kind === 'hook-event'
      ? HookEventSchema.parse({ event, sessionId: ctx.selfId, data })
      : StatusTelemetrySchema.parse({ sessionId: ctx.selfId, data });
  const response = await request(ctx, {
    method: 'POST',
    path: kind === 'hook-event' ? '/api/hook-event' : '/api/status-telemetry',
    body,
    headers,
    bounds: { maxBytes: 64 * 1024, deadlineMs: 5000 },
    timeoutMs: 5000,
  });
  if (response.status < 200 || response.status >= 300 || response.json?.success !== true)
    throw Error('Worker callback delivery unconfirmed');
  if (kind === 'status-telemetry' && typeof response.json.data === 'string') {
    const text = response.json.data;
    if (text.length > 4096 || Array.from(text).some((char) => char.charCodeAt(0) < 32 && char !== '\t'))
      throw Error('Worker status text refused');
    return text;
  }
  return undefined;
}
/** A separate explicit managed settings file. Never rewrites an existing HOME/profile. */
export function workerHookSettings() {
  const report = (event: string) => ({
    type: 'command',
    command: WORKER_CLIENT_ENTRY + ' worker-callback hook-event --event ' + event,
    timeout: HOOK_TIMEOUT_SECONDS,
  });
  return {
    hooks: {
      Notification: [
        'idle_prompt',
        'permission_prompt',
        'elicitation_dialog',
        'elicitation_complete',
        'elicitation_response',
      ].map((event) => ({ matcher: event, hooks: [report(event)] })),
      Stop: [{ hooks: [report('stop')] }],
      UserPromptSubmit: [{ hooks: [report('prompt_submitted')] }],
      PreCompact: [{ hooks: [report('compact_started')] }],
      SessionStart: [{ matcher: 'compact', hooks: [report('compact_finished')] }],
      TeammateIdle: [{ hooks: [report('teammate_idle')] }],
      TaskCompleted: [{ hooks: [report('task_completed')] }],
    },
    statusLine: { type: 'command', command: WORKER_CLIENT_ENTRY + ' worker-callback status-telemetry' },
  };
}
