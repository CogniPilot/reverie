/** Bounded current self context and a receipt referencing only a server-issued snapshot. */
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT } from './agent-exit-codes.js';
import type { EmployeeContextView, ManagedContextReport } from './employee-context.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max: number): value is string => typeof value === 'string' && Buffer.byteLength(value) <= max;
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const sections = (value: unknown): boolean => Array.isArray(value) && value.length <= 8 &&
  value.every(section => object(section) && keys(section, ['id', 'label', 'status', 'text', 'source']) && string(section.id, 100) && string(section.label, 300) &&
    ['configured', 'missing', 'captured'].includes(String(section.status)) && string(section.text, 65536) &&
    (section.source === undefined || string(section.source, 2000))) &&
  value.reduce((sum, section) => sum + Buffer.byteLength(section.text), 0) <= 65536;
const report = (value: unknown, employeeId: string): value is ManagedContextReport =>
  object(value) && keys(value, ['employeeId', 'sessionId', 'sessionGeneration', 'runtimeBinding', 'generatedAt', 'digest', 'context', 'sections', 'stage', 'reportedAt', 'assurance', 'retention']) && (value.runtimeBinding === undefined || sha(value.runtimeBinding)) && value.employeeId === employeeId && string(value.sessionId, 100) &&
  natural(value.sessionGeneration) && value.sessionGeneration > 0 && natural(value.generatedAt) && natural(value.reportedAt) &&
  value.reportedAt >= value.generatedAt && sha(value.digest) && string(value.context, 65536) && sections(value.sections) &&
  ['startup', 'model-request'].includes(String(value.stage)) && value.assurance === 'harness-reported-input' && value.retention === 'website-process-lifetime';

export function validEmployeeContext(value: unknown, selfId: string): value is EmployeeContextView {
  if (!object(value) || !keys(value, ['employeeId', 'sessionId', 'sessionGeneration', 'runtimeBinding', 'generatedAt', 'context', 'sections', 'startup', 'digest', 'retention', 'lastManagedDelivery']) || (value.runtimeBinding !== undefined && !sha(value.runtimeBinding)) || !string(value.employeeId, 100) || !value.employeeId || value.sessionId !== selfId ||
      !natural(value.sessionGeneration) || value.sessionGeneration < 1 || !natural(value.generatedAt) ||
      !string(value.context, 65536) || !sections(value.sections) || !sha(value.digest) ||
      value.retention !== 'website-process-lifetime' || !object(value.startup) || !keys(value.startup, ['status', 'reason', 'report']) ||
      !['unavailable', 'captured'].includes(String(value.startup.status)) || !string(value.startup.reason, 2000)) return false;
  if (value.startup.status === 'captured' && (!report(value.startup.report, value.employeeId) ||
      value.startup.report.sessionId !== selfId || value.startup.report.sessionGeneration !== value.sessionGeneration || value.startup.report.runtimeBinding !== value.runtimeBinding)) return false;
  if (value.startup.status === 'unavailable' && value.startup.report !== undefined) return false;
  return value.lastManagedDelivery === undefined || report(value.lastManagedDelivery, value.employeeId);
}
function refused(deps: AgentDeps): number {
  const error = 'Current self context or managed-input receipt unavailable; no startup consumption is inferred.';
  if (deps.json) deps.io.out(JSON.stringify({ success: false, error })); else deps.io.err(error);
  return AGENT_EXIT.refused;
}
export async function agentContext(deps: AgentDeps): Promise<number> {
  try {
    const response = await deps.request(deps.ctx, { method: 'GET', path: '/api/agent/context', bounds: { maxBytes: 512 * 1024, deadlineMs: 5000 } });
    const data = response.json?.data;
    if (response.status !== 200 || !response.json?.success || !validEmployeeContext(data, deps.ctx.selfId)) return refused(deps);
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data })); else deps.io.out(data.context);
    return AGENT_EXIT.ok;
  } catch { return refused(deps); }
}
export async function agentContextReceipt(deps: AgentDeps, digest: string, stage: string): Promise<number> {
  if (!sha(digest) || !['startup', 'model-request'].includes(stage)) return refused(deps);
  try {
    const response = await deps.request(deps.ctx, { method: 'POST', path: '/api/agent/context/receipt', body: { digest, stage },
      bounds: { maxBytes: 8192, deadlineMs: 5000 } });
    const data = response.json?.data;
    if (response.status !== 200 || !response.json?.success || !object(data) || !string(data.employeeId, 100) || !data.employeeId ||
        data.sessionId !== deps.ctx.selfId || !natural(data.sessionGeneration) || data.sessionGeneration < 1 ||
        data.digest !== digest || data.stage !== stage || !natural(data.reportedAt) ||
        (data.runtimeBinding !== undefined && !sha(data.runtimeBinding)) ||
        data.assurance !== 'harness-reported-input' || data.retention !== 'website-process-lifetime') return refused(deps);
    const selected = { employeeId: data.employeeId, sessionId: data.sessionId, sessionGeneration: data.sessionGeneration,
      ...(data.runtimeBinding === undefined ? {} : { runtimeBinding: data.runtimeBinding }),
      digest, stage, reportedAt: data.reportedAt, assurance: data.assurance, retention: data.retention };
    if (deps.json) deps.io.out(JSON.stringify({ success: true, data: selected })); else deps.io.out('Managed input reported; this is not model-read proof.');
    return AGENT_EXIT.ok;
  } catch { return refused(deps); }
}
