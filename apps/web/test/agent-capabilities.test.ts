import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCapabilities, githubCredentialReferences } from '../src/cli-agent-capabilities.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';
import type { AgentCapabilities } from '../src/agent-capabilities.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
const snapshot = (): AgentCapabilities => ({
  checkedAt: 1,
  identity: { kind: 'agent', sessionId: 'self-session', employeeId: 'employee-one', name: 'Jinx' },
  board: {
    read: true,
    fileIssue: true,
    createDecision: true,
    manageBoard: false,
    clearDecision: true,
    reason: 'Owner-made coordinator membership.',
  },
  company: { recoverEmployees: true, moveOwnPlan: false, managePlans: false, planPreconditions: 'Grant only; target/runtime checks remain.' },
});
const refs = async () => ({
  directory: '/home/agent/.config/reverie/credentials/github',
  bindings: [],
  note: 'No credentials installed.',
});
function fixture() {
  let current = snapshot();
  const calls: RequestOptions[] = [],
    output: string[] = [];
  const deps: AgentDeps = {
    ctx: { selfId: 'self-session', apiUrl: 'http://synthetic.test' },
    json: true,
    io: { out: (text) => output.push(text), err: (text) => output.push(text) },
    request: async (_context, request) => {
      calls.push(request);
      if (request.path === '/api/publication/credentials') return {
        status: 200, text: '', json: { success: true,
          data: { employeeId: 'employee-one', sessionId: 'self-session', credentials: [] } },
      };
      return {
        status: 200,
        text: '',
        json: {
          success: true,
          data: { capabilities: current, roster: [{ sessionId: 'self-session', coordinator: true }] },
        },
      };
    },
  };
  return {
    deps,
    calls,
    output,
    set: (value: AgentCapabilities) => {
      current = value;
    },
  };
}
describe('current agent capability command', () => {
  it('uses the authenticated server snapshot, performs only GET, and sees a revoked grant on the next call', async () => {
    const f = fixture();
    expect(await agentCapabilities(f.deps, refs)).toBe(0);
    expect(JSON.parse(f.output[0]).board.createDecision).toBe(true);
    expect(JSON.parse(f.output[0]).commands.refreshRuntime).toContain('--restart');
    expect(JSON.parse(f.output[0]).company.moveOwnPlan).toBe(false);
    const next = snapshot();
    next.board.createDecision = next.board.manageBoard = false;
    next.checkedAt = 2;
    f.set(next);
    expect(await agentCapabilities(f.deps, refs)).toBe(0);
    expect(JSON.parse(f.output[1]).board.createDecision).toBe(false);
    expect(f.calls).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/board' }),
      expect.objectContaining({ method: 'GET', path: '/api/publication/credentials' }),
      expect.objectContaining({ method: 'GET', path: '/api/board' }),
      expect.objectContaining({ method: 'GET', path: '/api/publication/credentials' }),
    ]);
    expect(f.calls.every((call) => call.body === undefined)).toBe(true);
    expect(JSON.parse(f.output[0]).website.redeploy.status).toBe('unavailable');
    expect(JSON.parse(f.output[0]).website.restart.status).toBe('unknown');
  });
  it('refuses to infer grants from roster, title or forged local session identity', async () => {
    const f = fixture();
    const next = snapshot();
    next.identity.sessionId = 'other-agent';
    f.set(next);
    expect(await agentCapabilities(f.deps, refs)).toBe(4);
    expect(f.output.join(' ')).toContain('Authenticated caller differs');
    f.deps.request = async () => ({
      status: 200,
      text: '',
      json: { success: true, data: { roster: [{ sessionId: 'self-session', coordinator: true }] } },
    });
    expect(await agentCapabilities(f.deps, refs)).toBe(1);
    expect(f.output.join(' ')).toContain('no permissions were inferred');
  });
  it('does not relabel an older broad Board report as full owner authority', async () => {
    const f=fixture(),old=snapshot();
    delete (old.board as Partial<typeof old.board>).clearDecision;
    f.set(old);
    expect(await agentCapabilities(f.deps,refs)).toBe(1);
    expect(f.output.join(' ')).toContain('no permissions were inferred');
  });
  it('reports a real API refusal without converting it into an empty deny-all report', async () => {
    const f = fixture();
    f.deps.request = async () => ({ status: 403, text: '', json: { success: false, error: 'Unknown caller session SECRET /private/owner' } });
    expect(await agentCapabilities(f.deps, refs)).toBe(4);
    expect(JSON.parse(f.output[0])).toEqual({
      success: false,
      error: expect.stringContaining('HTTP 403'),
    });
    expect(f.output.join(' ')).not.toContain('Unknown caller session');
    expect(f.output.join(' ')).not.toMatch(/SECRET|\/private/);
  });
  it('reports named PAT metadata without retrieving or printing secret material', async () => {
    const f = fixture();
    f.deps.request = async (_context, request) => {
      f.calls.push(request);
      return { status: 200, text: '', json: { success: true, data: request.path === '/api/board'
        ? { capabilities: snapshot() }
        : { employeeId: 'employee-one', sessionId: 'self-session', credentials: [{
          id: '44444444-4444-4444-8444-444444444444', name: 'project-publish',
          repositories: ['example/project'], createdAt: 1, updatedAt: 1,
          token: 'SYNTHETIC-SECRET-MUST-NOT-PRINT',
        }] } } };
    };
    expect(await agentCapabilities(f.deps, refs)).toBe(0);
    const report = JSON.parse(f.output[0]);
    expect(report.publication).toMatchObject({ status: 'verified', credentials: [{ name: 'project-publish' }] });
    expect(f.output.join(' ')).not.toContain('SYNTHETIC-SECRET');
    expect(f.calls.every(call => call.method === 'GET' && !call.path.includes('/material'))).toBe(true);
    expect(report.commands.installPublicationCredential).toContain('credentials install');
  });
  it('lists only private regular named token references and never reads their bytes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'capability-credentials-'));
    temporary.push(home);
    const folder = join(home, '.config/reverie/credentials/github');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, 'cognipilot.token'), 'SECRET-SENTINEL-DO-NOT-READ', { mode: 0o600 });
    await writeFile(join(folder, 'public.token'), 'SECRET-UNSAFE', { mode: 0o644 });
    await chmod(join(folder, 'public.token'), 0o644); // Exercise unsafe mode even under a private test umask.
    await symlink(join(folder, 'cognipilot.token'), join(folder, 'linked.token'));
    await writeFile(join(folder, 'bad name.token'), 'SECRET-BAD-NAME', { mode: 0o600 });
    const result = await githubCredentialReferences(home);
    expect(result.bindings).toEqual([{ name: 'cognipilot', path: join(folder, 'cognipilot.token') }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    await chmod(folder, 0o755);
    expect((await githubCredentialReferences(home)).bindings).toEqual([]);
  });
  it('capability output omits local locator paths and free-form credential labels', async () => {
    const f = fixture();
    const request = f.deps.request;
    f.deps.request = async (ctx, options) => options.path === '/api/publication/credentials'
      ? { status: 200, text: '', json: { success: true, data: { employeeId: 'employee-one', sessionId: 'self-session', credentials: [{
        id: '44444444-4444-4444-8444-444444444444', name: 'release', repositories: ['example/project'],
        createdAt: 1, updatedAt: 1, label: '/private/free-form-label',
      }] } } }
      : request(ctx, options);
    expect(await agentCapabilities(f.deps, async () => ({ directory: '/private/token-directory',
      bindings: [{ name: 'release', path: '/private/token-directory/release.token' }], note: '/private/note' }))).toBe(0);
    const result = JSON.parse(f.output[0]!);
    expect(result.github.bindings).toEqual([{ name: 'release' }]);
    expect(result.commands.publicationCredentialStatus).toBe('reverie agent credentials status --json');
    expect(f.output.join(' ')).not.toContain('/private/');
  });
  it('gives useful plain-language commands and distinguishes filing from approval', async () => {
    const f = fixture();
    f.deps.json = false;
    expect(await agentCapabilities(f.deps, refs)).toBe(0);
    expect(f.output.join('\n')).toContain('Board decision cards: allowed');
    expect(f.output.join('\n')).toContain('reverie board decision add');
    expect(f.output.join('\n')).toContain('not approval');
    expect(f.output.join('\n')).toContain('manage board tasks and schedule: denied');
    expect(f.output.join('\n')).toContain('Plan preconditions:');
    expect(f.output.join('\n')).toContain('/handbook/operations');
  });
});
