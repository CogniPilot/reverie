/**
 * An agent may only create a session that resumes a conversation of its own: a row created "resuming" another agent's thread would pass
 * for that agent's successor (the chat's place-handover rule), so POST /api/sessions refuses it at the source. The owner is unaffected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentOwnsConversation, registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';

const P = '0000002d-0035-4000-8000-000000000047';
const Q = '00000038-0043-4000-8000-000000000060';
const T_P = '0000003e-004c-4000-8000-000000000071';
const T_OLD = '0000003e-004c-4000-8000-000000000070';
const T_Q = '00000043-0053-4000-8000-00000000007e';

describe('an agent resumes only its own conversations', () => {
  it('knows its own id, native thread and earlier chain, and nothing else', () => {
    const s = { id: P, claudeSessionId: T_P, claudeSessionChain: [T_OLD, T_P] };
    expect(agentOwnsConversation(s, P)).toBe(true);
    expect(agentOwnsConversation(s, T_P)).toBe(true);
    expect(agentOwnsConversation(s, T_OLD)).toBe(true);
    expect(agentOwnsConversation(s, Q)).toBe(false);
    expect(agentOwnsConversation(s, T_Q)).toBe(false);
    expect(agentOwnsConversation(undefined, P)).toBe(false);
    expect(agentOwnsConversation({ id: P }, 'x')).toBe(false);
  });

  const setup = async () => {
    const h = await createRouteTestHarness(registerSessionRoutes);
    for (const [id, name] of [[P, 'alpha'], [Q, 'bravo']] as const) {
      const s = createMockSession(id);
      s.name = name;
      h.ctx.sessions.set(id, s as never);
    }
    const p = h.ctx.sessions.get(P) as unknown as { claudeSessionId: string | null; claudeSessionChain: string[] };
    p.claudeSessionId = T_P;
    p.claudeSessionChain = [T_OLD, T_P];
    return h;
  };
  const create = (h: Awaited<ReturnType<typeof setup>>, body: object, as?: string) =>
    h.app.inject({ method: 'POST', url: '/api/sessions', headers: as ? { 'x-codeman-parent-session': as } : {}, payload: { workingDir: '/nonexistent-resume-guard', ...body } });

  it('refuses a row that resumes another agent\'s conversation, in any of the three places it can be asked for', async () => {
    const h = await setup();
    for (const body of [{ resumeSessionId: Q }, { resumeSessionId: T_Q }, { mode: 'codex', codexConfig: { resumeSessionId: T_Q } }]) {
      const res = await create(h, body, P);
      expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(403);
      expect(res.json().errorCode).toBe('FORBIDDEN');
    }
  });

  it('lets an agent resume its own conversation (it is not refused here), and does not touch the owner', async () => {
    const h = await setup();
    for (const body of [{ resumeSessionId: T_P }, { resumeSessionId: T_OLD }, { resumeSessionId: P }]) {
      const res = await create(h, body, P);
      expect(res.statusCode, JSON.stringify(body)).not.toBe(403);
    }
    const owner = await create(h, { resumeSessionId: T_Q });
    expect(owner.statusCode).not.toBe(403);
  });
});

describe('82d: every resume field, both creating routes, and no silent fresh or stale resume', () => {
  afterEach(() => vi.unstubAllEnvs());
  const setup = async () => {
    const h = await createRouteTestHarness(registerSessionRoutes);
    for (const [id, name] of [[P, 'alpha'], [Q, 'bravo']] as const) {
      const s = createMockSession(id);
      s.name = name;
      h.ctx.sessions.set(id, s as never);
    }
    (h.ctx.sessions.get(P) as unknown as { claudeSessionId: string }).claudeSessionId = T_P;
    return h;
  };
  const post = (h: Awaited<ReturnType<typeof setup>>, url: string, body: object, as?: string) =>
    h.app.inject({ method: 'POST', url, headers: as ? { 'x-codeman-parent-session': as } : {}, payload: { workingDir: '/nonexistent-resume-guard', ...body } });

  const foreign: object[] = [
    { mode: 'opencode', openCodeConfig: { continueSession: 'ses_foreign' } },
    { mode: 'gemini', geminiConfig: { resumeSession: 'foreign-g' } },
    { mode: 'antigravity', antigravityConfig: { resumeConversationId: 'foreign-a' } },
    { mode: 'pi', piConfig: { resumeSessionId: 'foreign-p' } },
    { mode: 'grok', grokConfig: { resumeSessionId: 'foreign-x' } },
    { mode: 'deepseek', deepSeekConfig: { resumeSessionId: 'foreign-d' } },
    { mode: 'pi', piConfig: { continueSession: true } },
    { mode: 'omp', ompConfig: { continueSession: true } },
    { mode: 'gemini', geminiConfig: { resumeSession: 'latest' } },
  ];

  it('POST /api/sessions refuses every other CLI field and every "latest" form for an agent', async () => {
    const h = await setup();
    for (const body of foreign) {
      const res = await post(h, '/api/sessions', body, P);
      expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(403);
    }
  });

  it('POST /api/quick-start applies the same guard (it had none), and leaves the owner alone', async () => {
    const h = await setup();
    for (const body of [{ mode: 'codex', codexConfig: { resumeSessionId: T_Q } }, ...foreign]) {
      const res = await post(h, '/api/quick-start', { caseName: 'resume-guard', ...body }, P);
      expect(res.json().errorCode, `${JSON.stringify(body)} ${res.body}`).toBe('FORBIDDEN');
    }
    const owner = await post(h, '/api/quick-start', { caseName: 'resume-guard', mode: 'codex', codexConfig: { resumeSessionId: T_Q } });
    expect(owner.json().errorCode).not.toBe('FORBIDDEN');
  });

  it('a Claude resume with no transcript anywhere is refused (404), not started fresh', async () => {
    const h = await setup();
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'resume-home-')));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const res = await post(h, '/api/sessions', { resumeSessionId: T_Q, workingDir: mkdtempSync(join(tmpdir(), 'resume-wd-')) });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error).toContain('refusing to start a fresh thread');
  });

  it('a transcript only in the console home but asked for under another account dir is refused (409), and refreshed on request', async () => {
    const h = await setup();
    const home = mkdtempSync(join(tmpdir(), 'resume-home-'));
    const acct = mkdtempSync(join(tmpdir(), 'resume-acct-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const context = JSON.stringify({ type: 'user', sessionId: T_Q, message: { role: 'user', content: 'context' } }) + '\n';
    mkdirSync(join(home, '.claude', 'projects', '-w'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-w', `${T_Q}.jsonl`), context);
    const wd = mkdtempSync(join(tmpdir(), 'resume-wd-'));
    const refused = await post(h, '/api/sessions', { resumeSessionId: T_Q, envOverrides: { CLAUDE_CONFIG_DIR: acct }, workingDir: wd });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toContain(join(home, '.claude', 'projects', '-w', `${T_Q}.jsonl`));
    const refreshed = await post(h, '/api/sessions', { resumeSessionId: T_Q, envOverrides: { CLAUDE_CONFIG_DIR: acct }, refreshResumeFromNewest: true, workingDir: wd });
    expect([404, 409]).not.toContain(refreshed.statusCode);
    expect(readFileSync(join(acct, 'projects', '-w', `${T_Q}.jsonl`), 'utf8')).toBe(context);
  });

  it('resuming the live copy while an older, different copy sits in another account succeeds, with a warnings[] entry naming it', async () => {
    const h = await setup();
    const home = mkdtempSync(join(tmpdir(), 'resume-home-'));
    const acct = mkdtempSync(join(tmpdir(), 'resume-acct-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const line = (extra: string) => JSON.stringify({ type: 'user', sessionId: T_Q, message: { role: 'user', content: extra } }) + '\n';
    const old = join(home, '.claude', 'projects', '-w', `${T_Q}.jsonl`);
    mkdirSync(join(home, '.claude', 'projects', '-w'), { recursive: true });
    writeFileSync(old, line('before the switch'));
    utimesSync(old, 1000, 1000);
    mkdirSync(join(acct, 'projects', '-w'), { recursive: true });
    writeFileSync(join(acct, 'projects', '-w', `${T_Q}.jsonl`), line('before the switch') + line('after it'));
    const res = await post(h, '/api/sessions', { resumeSessionId: T_Q, envOverrides: { CLAUDE_CONFIG_DIR: acct }, workingDir: mkdtempSync(join(tmpdir(), 'resume-wd-')) });
    expect(res.statusCode, res.body).toBe(200);
    const warnings = res.json().warnings as string[]; // the server's envelope hook makes it data.warnings; this harness has none
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(old);
    expect(warnings[0]).toContain(acct);
  });

  it('an agent asking to refresh a conversation it does not own is refused (403) by the source guard, before any copy', async () => {
    const h = await setup();
    const home = mkdtempSync(join(tmpdir(), 'resume-home-'));
    const acct = mkdtempSync(join(tmpdir(), 'resume-acct-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    mkdirSync(join(home, '.claude', 'projects', '-w'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-w', `${T_Q}.jsonl`), JSON.stringify({ type: 'user', sessionId: T_Q }) + '\n');
    const wd = mkdtempSync(join(tmpdir(), 'resume-wd-'));
    const res = await post(h, '/api/sessions', { resumeSessionId: T_Q, envOverrides: { CLAUDE_CONFIG_DIR: acct }, refreshResumeFromNewest: true, workingDir: wd }, P);
    expect(res.statusCode, res.body).toBe(403);
    expect(existsSync(join(acct, 'projects'))).toBe(false);
  });

  it('a transcript with no conversation entry (an empty file) is refused (422), not resumed into "No conversation found"', async () => {
    const h = await setup();
    const home = mkdtempSync(join(tmpdir(), 'resume-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    mkdirSync(join(home, '.claude', 'projects', '-w'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-w', `${T_Q}.jsonl`), '');
    const res = await post(h, '/api/sessions', { resumeSessionId: T_Q, workingDir: mkdtempSync(join(tmpdir(), 'resume-wd-')) });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
  });
});

describe('a coordinator continues a gone agent (resume takeover)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const COORD = '0000002d-0035-4000-8000-00000000004b';
  const PEER = '00000038-0043-4000-8000-000000000061';
  const VERIFIER = '00000046-0058-4000-8000-000000000087';
  const T_STAN = '00000046-0058-4000-8000-000000000088';

  const setup = async (opts: { stanRunning?: boolean; rooms?: unknown[]; auditFails?: boolean } = {}) => {
    const audit: Array<Record<string, unknown>> = [];
    const rooms = (opts.rooms ?? [
      { id: 'r1', name: 'reverie', members: [{ sessionId: COORD, role: 'coordinator' }, { sessionId: PEER, role: 'member' }, { sessionId: VERIFIER, role: 'member' }] },
    ]) as never;
    const h = await createRouteTestHarness((app, ctx) =>
      registerSessionRoutes(app, ctx, {
        resumeTakeover: {
          rooms: () => rooms,
          audit: async (e) => {
            if (opts.auditFails) throw new Error('disk full');
            audit.push(e);
          },
        },
      })
    );
    for (const [id, name] of [[COORD, 'reviewer'], [PEER, 'coordinator'], [VERIFIER, 'verifier']] as const) {
      const s = createMockSession(id);
      s.name = name;
      (s as unknown as { isRunning: () => boolean }).isRunning = () => id !== VERIFIER || !!opts.stanRunning;
      h.ctx.sessions.set(id, s as never);
    }
    (h.ctx.sessions.get(VERIFIER) as unknown as { claudeSessionId: string }).claudeSessionId = T_STAN;
    return { h, audit };
  };
  const create = (h: Awaited<ReturnType<typeof setup>>['h'], as: string, body: object = { resumeSessionId: T_STAN }) =>
    h.app.inject({ method: 'POST', url: '/api/sessions', headers: { 'x-codeman-parent-session': as }, payload: { workingDir: '/nonexistent-resume-guard', ...body } });

  it('lets the room\'s coordinator resume the gone agent\'s thread, and writes one audit line', async () => {
    const { h, audit } = await setup();
    const res = await create(h, COORD);
    expect(res.statusCode, res.body).not.toBe(403);
    expect(audit).toEqual([{ action: 'resume-takeover', by: COORD, conversation: T_STAN, member: VERIFIER, roomId: 'r1', room: 'reverie' }]);
  });
  it('refuses a member who is not the coordinator, with no audit line', async () => {
    const { h, audit } = await setup();
    const res = await create(h, PEER);
    expect(res.statusCode).toBe(403);
    expect(audit).toEqual([]);
  });
  it('refuses while the agent is still running', async () => {
    const { h, audit } = await setup({ stanRunning: true });
    expect((await create(h, COORD)).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });
  it('refuses a room the caller does not coordinate', async () => {
    const { h, audit } = await setup({
      rooms: [{ id: 'r2', name: 'other', members: [{ sessionId: COORD, role: 'member' }, { sessionId: VERIFIER, role: 'member' }] }],
    });
    expect((await create(h, COORD)).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });
  it('still refuses another agent\'s unrelated conversation and every "latest" form', async () => {
    const { h, audit } = await setup();
    expect((await create(h, COORD, { resumeSessionId: '0000003e-004c-4000-8000-000000000072' })).statusCode).toBe(403);
    expect((await create(h, COORD, { mode: 'pi', piConfig: { continueSession: true } })).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });
  it('starts nothing when the audit line cannot be written', async () => {
    const { h } = await setup({ auditFails: true });
    const res = await create(h, COORD);
    expect(res.statusCode).toBe(500);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
  });
  it('writes an audit line when an agent caller launches codex with approvals bypassed', async () => {
    const { h, audit } = await setup();
    const res = await create(h, COORD, { mode: 'codex', codexConfig: { dangerouslyBypassApprovals: true } });
    expect(res.statusCode, res.body).not.toBe(403);
    expect(audit).toEqual([{ action: 'agent-bypass-approvals', by: COORD, mode: 'codex' }]);
  });
  it('writes no bypass line when approvals are not bypassed', async () => {
    const { h, audit } = await setup();
    await create(h, COORD, { mode: 'codex', codexConfig: { reasoningEffort: 'high' } });
    expect(audit).toEqual([]);
  });
  it('starts nothing when the bypass audit line cannot be written', async () => {
    const { h } = await setup({ auditFails: true });
    const res = await create(h, COORD, { mode: 'codex', codexConfig: { dangerouslyBypassApprovals: true } });
    expect(res.statusCode).toBe(500);
  });
  it('treats a row only in the persisted state (not loaded after a restart) as gone, matching a Codex thread in codexConfig', async () => {
    const { h, audit } = await setup();
    h.ctx.sessions.delete(VERIFIER);
    const THREAD = 'codex-thread-aaaa';
    (h.ctx.store.getSessions as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
      [VERIFIER]: { id: VERIFIER, status: 'busy', claudeSessionId: null, codexConfig: { resumeSessionId: THREAD } },
    });
    const codex = { mode: 'codex', codexConfig: { resumeSessionId: THREAD } };
    const res = await create(h, COORD, codex);
    expect(res.statusCode, res.body).not.toBe(403);
    expect(audit).toEqual([{ action: 'resume-takeover', by: COORD, conversation: THREAD, member: VERIFIER, roomId: 'r1', room: 'reverie' }]);
    expect((await create(h, PEER, codex)).statusCode).toBe(403);
  });
  it('fails closed with a 409 and no audit line when the grant disappears between the check and the audit', async () => {
    const calls = { n: 0 };
    const room = { id: 'r1', name: 'reverie', members: [{ sessionId: COORD, role: 'coordinator' }, { sessionId: VERIFIER, role: 'member' }] };
    const { h, audit } = await setup({ rooms: [] });
    // rooms() answers the coordinator room once (the check) and nothing after (the audit).
    const reg = await createRouteTestHarness((app, ctx) =>
      registerSessionRoutes(app, ctx, {
        resumeTakeover: { rooms: () => (calls.n++ === 0 ? ([room] as never) : []), audit: async (e) => void audit.push(e) },
      })
    );
    for (const [id, name] of [[COORD, 'reviewer'], [VERIFIER, 'verifier']] as const) {
      const s = createMockSession(id);
      s.name = name;
      (s as unknown as { isRunning: () => boolean }).isRunning = () => id === COORD;
      reg.ctx.sessions.set(id, s as never);
    }
    (reg.ctx.sessions.get(VERIFIER) as unknown as { claudeSessionId: string }).claudeSessionId = T_STAN;
    void h;
    const res = await create(reg as never, COORD);
    expect(res.statusCode).toBe(409);
    expect(audit).toEqual([]);
  });
  it('ignores a coordinator named only in the body: the header and the parent must be the same session', async () => {
    const { h, audit } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-codeman-parent-session': PEER },
      payload: { workingDir: '/nonexistent-resume-guard', resumeSessionId: T_STAN, parentSessionId: COORD },
    });
    expect(res.statusCode).toBe(403);
    expect(audit).toEqual([]);
  });
  it('is off when the setting says owner', async () => {
    vi.stubEnv('REVERIE_RESUME_TAKEOVER', 'owner');
    const { h, audit } = await setup();
    expect((await create(h, COORD)).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });
});
