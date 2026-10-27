/** Read-only capabilities and local credential references. Never reads token bytes. */
import { credentialReferences } from './credential-references.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT as EXIT } from './agent-exit-codes.js';
import type { AgentCapabilities } from './agent-capabilities.js';
import { fetchGrantedCredentials, type GrantedCredentialMetadata } from './cli-agent-credentials.js';

export const GITHUB_CREDENTIAL_DIRECTORY = '.config/reverie/credentials/github';

export async function githubCredentialReferences(home = process.env.REVERIE_AGENT_HOME || homedir()): Promise<{
  directory: string;
  bindings: { name: string; path: string; declaredRepositories?: string[] }[];
  note: string;
}> {
  const directory = join(home, GITHUB_CREDENTIAL_DIRECTORY);
  const bindings: { name: string; path: string; declaredRepositories?: string[] }[] = [];
  try {
    bindings.push(...(await credentialReferences(directory)));
  } catch {
    /* Unavailable/unsafe directory: no search, token read or raw filesystem error. */
  }

  return {
    directory,
    bindings,
    note: 'File presence is not proof of GitHub repository scope. Use only owner-provided bindings; never print tokens. Ask the owner/operator to install a missing named binding.',
  };
}

export async function agentCapabilities(deps: AgentDeps, references = githubCredentialReferences): Promise<number> {
  const response = await deps.request(deps.ctx, { method: 'GET', path: '/api/board', timeoutMs: 10000 });
  if (!response.json?.success) {
    const reason =
      typeof response.json?.error === 'string'
        ? response.json.error.slice(0, 300).replace(/[\r\n\t]/g, ' ')
        : `HTTP ${response.status}`;
    const error = `Capabilities could not be verified: ${reason}. Do not guess grants from a title or old chat.`;
    if (deps.json) deps.io.out(JSON.stringify({ success: false, error }));
    else deps.io.err(error);
    return response.status === 401 || response.status === 403 ? EXIT.refused : EXIT.error;
  }
  const capabilities = (response.json.data as { capabilities?: AgentCapabilities } | undefined)?.capabilities;
  if (
    !capabilities ||
    !['owner', 'agent'].includes(capabilities.identity?.kind) ||
    typeof capabilities.board?.createDecision !== 'boolean' ||
    typeof capabilities.board?.clearDecision !== 'boolean' ||
    typeof capabilities.board?.manageBoard !== 'boolean' ||
    typeof capabilities.company?.planPreconditions !== 'string'
  ) {
    deps.io.err(
      'This server predates the capabilities report. Read /handbook/permissions and ask the operator to update it; no permissions were inferred.'
    );
    return EXIT.error;
  }
  if (capabilities.identity.kind !== 'agent' || capabilities.identity.sessionId !== deps.ctx.selfId) {
    deps.io.err(
      'Authenticated caller differs from this agent session. Check your office phone/session binding; do not reuse another identity.'
    );
    return EXIT.refused;
  }
  const github = await references();
  let publication: { status: 'verified' | 'unavailable'; credentials: GrantedCredentialMetadata[]; note: string };
  try {
    const granted = await fetchGrantedCredentials(deps, capabilities.identity);
    publication = { status: 'verified', credentials: granted.credentials,
      note: 'These named PAT grants permit retrieval only. Repository descriptions are owner-declared; GitHub enforces the actual token permissions. Revoking a grant prevents new retrieval, not use of a previously copied token.' };
  } catch {
    publication = { status: 'unavailable', credentials: [],
      note: 'Current named PAT grants could not be verified. Local credential files do not establish a current grant.' };
  }
  const report = {
    ...capabilities,
    website: {
      restart: {
        status: 'unknown',
        reason: 'Separate host maintenance-session grant; company and Board permissions do not grant it.',
        endpoint: 'POST /api/system/restart-website',
        body: { confirmed: true },
      },
      redeploy: {
        status: 'unavailable',
        reason:
          'The isolated-laptop updater is not yet connected to a reviewed host image-swap executor. A restart does not install source.',
        next: 'Prepare the exact source/image acceptance handoff for the owner-appointed host operator. See /handbook/operations.',
      },
    },
    github,
    publication,
    commands: {
      fileDecision: 'reverie board decision add "<request>" --id <stable-id> --where "<source room>" --option "<choice 1>" --option "<choice 2>" --recommend "<choice 1>" --json',
      inspectBoard: 'reverie board show --json',
      plans: 'reverie plans --json',
      refreshRuntime: 'reverie agent plan-move request "<current-account-id>" --restart --id "<stable-id>" --json',
      channels: 'reverie agent chat rooms --json',
      readChannel: 'reverie agent chat read --room "<name or ID>" -n 20 --json',
      publicationCredentials: 'reverie agent credentials list --json',
      installPublicationCredential: 'reverie agent credentials install "<name>" --json',
    },
    context:
      'A decision request is not approval to execute its proposed action. Check current grants again after role/session changes or an actual refusal. Documentation and job titles grant no authority.',
    handbook: '/handbook/operations',
    memoryGuide: '/handbook/memory',
  };
  if (deps.json) deps.io.out(JSON.stringify(report, null, 2));
  else {
    deps.io.out(`${capabilities.identity.name} · current session ${capabilities.identity.sessionId}`);
    deps.io.out(
      `Board decision cards: ${capabilities.board.createDecision ? 'allowed' : 'denied'}; clear: ${capabilities.board.clearDecision ? 'allowed' : 'denied'} — ${capabilities.board.reason}`
    );
    deps.io.out(
      `File an issue: ${capabilities.board.fileIssue ? 'allowed' : 'denied'}; manage board tasks and schedule: ${capabilities.board.manageBoard ? 'allowed' : 'denied'}`
    );
    if (typeof capabilities.board.editBoardIssues === 'boolean')
      deps.io.out(`Update own board work: ${capabilities.board.editBoardIssues ? 'allowed' : 'denied'}. Only the verified owner answers decision requests.`);
    deps.io.out(
      `Recover colleagues: ${capabilities.company.recoverEmployees ? 'allowed' : 'denied'}; move own plan: ${capabilities.company.moveOwnPlan ? 'allowed' : 'denied'}; manage team plans: ${capabilities.company.managePlans ? 'allowed' : 'denied'}`
    );
    deps.io.out(`Plan preconditions: ${capabilities.company.planPreconditions}`);
    deps.io.out(
      `Website restart: host grant must be checked. Redeploy: host operator required; restart does not install new code.`
    );
    deps.io.out(
      `GitHub credential references: ${github.bindings.length ? github.bindings.map((b) => `${b.name}: ${b.path}${b.declaredRepositories?.length ? ' (owner-declared: ' + b.declaredRepositories.join(', ') + ')' : ''}`).join(', ') : 'none installed'} (${github.directory})`
    );
    deps.io.out(`Named PAT grants: ${publication.status === 'verified' ? publication.credentials.map(item => item.name).join(', ') || 'none' : 'unavailable'}. ${publication.note}`);
    deps.io.out(`PATs: ${report.commands.publicationCredentials}; install privately: ${report.commands.installPublicationCredential}`);
    deps.io.out(`Decision command: ${report.commands.fileDecision}`);
    deps.io.out(
      `Channels: ${report.commands.channels}; read: ${report.commands.readChannel}. Memory: ${report.memoryGuide}`
    );
    deps.io.out(`${report.context} Handbook: ${report.handbook}`);
  }
  return EXIT.ok;
}
