/** Read-only own credential availability. Never inspects local files or fetches material. */
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT } from './agent-exit-codes.js';
import { OwnCredentialStatusSchema } from './publication-credential-status.js';

const NOTE =
  'Only current own grants are visible; this does not enumerate the owner registry or credentials elsewhere. ' +
  'Expiry is not recorded by this store. Repository labels are owner-declared, not verified GitHub access. ' +
  'Registration remains owner-only; no repository probe or credential installation was performed.';
type Unavailability = 'forbidden' | 'unsupported-server' | 'unavailable' | 'invalid-response';

export async function agentCredentialStatus(deps: AgentDeps): Promise<number> {
  let reason: Unavailability = 'unavailable';
  try {
    const identity = await deps.request(deps.ctx, {
      method: 'GET',
      path: '/api/board',
      bounds: { maxBytes: 1024 * 1024, deadlineMs: 10000 },
    });
    if (identity.status === 401 || identity.status === 403) {
      reason = 'forbidden';
      throw Error();
    }
    const actor = (
      identity.json?.data as
        | { capabilities?: { identity?: { kind?: string; sessionId?: string; employeeId?: string } } }
        | undefined
    )?.capabilities?.identity;
    if (
      identity.status !== 200 ||
      !identity.json?.success ||
      actor?.kind !== 'agent' ||
      actor.sessionId !== deps.ctx.selfId ||
      !actor.employeeId
    ) {
      reason = 'invalid-response';
      throw Error();
    }
    const response = await deps.request(deps.ctx, {
      method: 'GET',
      path: '/api/publication/credentials/status',
      bounds: { maxBytes: 128 * 1024, deadlineMs: 10000 },
    });
    if (response.status !== 200 || !response.json?.success) {
      reason =
        response.status === 401 || response.status === 403
          ? 'forbidden'
          : response.status === 404
            ? 'unsupported-server'
            : 'unavailable';
      throw Error();
    }
    const parsed = OwnCredentialStatusSchema.safeParse(response.json.data);
    if (!parsed.success || parsed.data.employeeId !== actor.employeeId || parsed.data.sessionId !== deps.ctx.selfId) {
      reason = 'invalid-response';
      throw Error();
    }
    const report = { success: true, ...parsed.data, note: NOTE };
    if (deps.json) deps.io.out(JSON.stringify(report));
    else {
      deps.io.out(
        parsed.data.credentials.length
          ? parsed.data.credentials
              .map(
                (entry) =>
                  `${'name' in entry ? entry.name : entry.id}: registration ${entry.registration}; grant ${entry.grant}; ` +
                  `expiry unknown; repository access not verified${entry.repositories.length ? ' (' + entry.repositories.join(', ') + ')' : ''}`
              )
              .join('\n')
          : 'No current own publication grants are configured.'
      );
      deps.io.out(NOTE);
    }
    return AGENT_EXIT.ok;
  } catch {
    const report = {
      success: false,
      availability: 'unknown',
      reason,
      error: 'Current named publication credential metadata could not be verified.',
      note: NOTE,
    };
    if (deps.json) deps.io.out(JSON.stringify(report));
    else deps.io.err(`${report.error} ${reason}. ${NOTE}`);
    return reason === 'forbidden' ? AGENT_EXIT.refused : AGENT_EXIT.error;
  }
}
