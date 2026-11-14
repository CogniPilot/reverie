/** Thin agent transport over the same continuation API; no policy editing,
 * engine command, authentication fallback or automatic retry is exposed here.
 */
import type { Command } from 'commander';
import type { AgentDeps } from './cli-agent.js';
import { DockerEmployeeContinuationRequest } from './docker-employee-continuation-data.js';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Run = (json: boolean, verb: (deps: AgentDeps) => Promise<number>) => Promise<void>;
export async function agentDockerContinuation(
  deps: AgentDeps,
  employeeId: string,
  action: 'policy' | 'continue' | 'observe',
  body?: unknown
): Promise<number> {
  if (!uuid.test(employeeId)) {
    deps.io.err('Use the full canonical employee UUID.');
    return 4;
  }
  let payload: Record<string, unknown> | undefined;
  if (action === 'continue') {
    const parsed = DockerEmployeeContinuationRequest.safeParse(body);
    if (!parsed.success) {
      deps.io.err('Invalid bounded continuation selection. No request was sent.');
      return 4;
    }
    payload = { request: parsed.data };
  } else if (action === 'observe') {
    const operationId = (body as { operationId?: unknown } | undefined)?.operationId;
    if (typeof operationId !== 'string' || !uuid.test(operationId)) {
      deps.io.err('Use the full original operation UUID.');
      return 4;
    }
    payload = { operationId };
  }
  const path =
    '/api/company/employees/' +
    employeeId +
    (action === 'policy'
      ? '/docker-policy'
      : action === 'observe'
        ? '/docker-continuation/observe'
        : '/docker-continuation');
  try {
    const result = await deps.request(deps.ctx, {
      method: action === 'policy' ? 'GET' : 'POST',
      path,
      ...(payload ? { body: payload } : {}),
      bounds: { maxBytes: 65536, deadlineMs: 35000 },
    });
    if (!result.json?.success) {
      deps.io.err(
        'Docker continuation refused (HTTP ' +
          result.status +
          '). Inspect the original operation; do not repeat an uncertain start.'
      );
      return [401, 403, 409].includes(result.status) ? 4 : 1;
    }
    const data = result.json.data ?? result.json;
    deps.io.out(JSON.stringify(data));
    if (action === 'policy') return 0;
    const state = (data as { state?: unknown }).state;
    return state === 'ready' ? 0 : state === 'pending' ? 3 : state === 'held' ? 2 : 1;
  } catch {
    deps.io.err(
      'Docker continuation outcome is unconfirmed. Inspect the same original operation; no second action was sent.'
    );
    return 1;
  }
}
interface ContinueOptions {
  operation: string;
  session: string;
  generation: string;
  container: string;
  image: string;
  destinationImage: string;
  policyDigest: string;
  enterOffice?: boolean;
  json?: boolean;
}
export function registerDockerEmployeeContinuationCommands(agent: Command, run: Run): void {
  agent
    .command('docker-policy <employee-id>')
    .description('Read current boxed continuation selection and owner-approved resource policy')
    .option('--json', 'Machine-readable selection')
    .action((employeeId: string, options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentDockerContinuation(deps, employeeId, 'policy'))
    );
  agent
    .command('observe-docker-continuation <employee-id>')
    .description('Observe the same original boxed operation; sends no create/start/provider action')
    .requiredOption('--operation <uuid>', 'Exact original operation UUID')
    .option('--json', 'Machine-readable original status')
    .action((employeeId: string, options: { operation: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentDockerContinuation(deps, employeeId, 'observe', { operationId: options.operation })
      )
    );
  agent
    .command('continue-employee <employee-id>')
    .description('Continue an approved employee on a Docker-contained destination under current recovery permission')
    .requiredOption('--operation <uuid>', 'Unique operation UUID; retain it after any lost reply')
    .requiredOption('--session <uuid>', 'Exact full current session UUID')
    .requiredOption('--generation <integer>', 'Exact current logical binding generation')
    .requiredOption('--container <full-id>', 'Exact stopped source container ID from the selection')
    .requiredOption('--image <sha256-id>', 'Exact source image ID from the selection')
    .requiredOption('--destination-image <sha256-id>', 'Exact server-selected qualified destination image ID')
    .requiredOption('--policy-digest <sha256>', 'Exact current owner-approved policy digest')
    .option('--enter-office', 'Explicit office intent; requires independent manageOffice permission')
    .option('--json', 'Machine-readable original operation result')
    .action((employeeId: string, options: ContinueOptions) =>
      run(Boolean(options.json), (deps) =>
        agentDockerContinuation(deps, employeeId, 'continue', {
          operationId: options.operation,
          sessionId: options.session,
          sessionGeneration: Number(options.generation),
          containerId: options.container,
          imageId: options.image,
          expectedDestinationImageId: options.destinationImage,
          expectedPolicyDigest: options.policyDigest,
          enterOffice: options.enterOffice === true,
        })
      )
    );
}
