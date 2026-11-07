import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * @fileoverview GET /api/agents/:id/profile: the read-only agent profile, built in the console
 * from its session, company and room state, with the runtime section and persona read from an
 * optional runtime policy. Port: N/A (app.inject()).
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerAgentProfileRoutes, type ProfileSources } from '../../src/web/routes/agent-profile-routes.js';
import {
  INSTANCE_BYTES,
  POLICY_BYTES,
  buildProfile,
  observedEffort,
  parseInstance,
} from '../../src/web/routes/agent-profile-report.js';
import { createMockSession } from '../mocks/index.js';

const CONVERSATION = '0123abcd-0000-4000-8000-00000000abcd';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-profile-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function sources(overrides: Partial<ProfileSources> = {}): ProfileSources {
  return {
    transcriptProjectsDir: join(dir, 'projects'),
    employees: () => [
      {
        id: 'e1',
        name: 'Alpha',
        icon: 'a.png',
        position: 'Engineer',
        expertise: ['rust'],
        sessionId: 'test-session-1',
      },
    ],
    rooms: () => [
      {
        id: 'r1',
        name: 'general',
        members: [{ sessionId: 'test-session-1', role: 'coordinator' }, { sessionId: 'other-session-2' }],
      },
      { id: 'r2', name: 'dm', kind: 'dm', members: [{ sessionId: 'test-session-1' }] },
      { id: 'r3', name: 'elsewhere', members: [{ sessionId: 'other-session-2' }] },
    ],
    ...overrides,
  };
}

async function setup(src: ProfileSources = sources(), authUser?: { username: string; role: 'admin' | 'user' }) {
  const h = await createRouteTestHarness((app, ctx) => registerAgentProfileRoutes(app, ctx, src, trustedFixtureOwner), {
    authUser,
  });
  for (const id of ['other-session-2', 'other-session-3']) h.ctx.sessions.set(id, createMockSession(id) as never);
  return h;
}

describe('GET /api/agents/:id/profile', () => {
  it("builds the owner's report from the console's own session, company and room state", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.session).toMatchObject({ id: 'test-session-1', alive: false, pinned: false });
    expect(data.employee).toEqual({
      id: 'e1',
      name: 'Alpha',
      icon: 'a.png',
      position: 'Engineer',
      expertise: ['rust'],
    });
    expect(data.rooms).toEqual([
      { id: 'r1', name: 'general', role: 'coordinator' },
      { id: 'r2', name: 'dm', role: null },
    ]);
    expect(data.runtime).toEqual({
      supervised: false,
      backend: null,
      phase: null,
      backends: [],
      switch: { available: false, reason: 'switching a backend is an owner action; it waits for owner authentication' },
    });
    expect(data.persona).toBeNull();
    expect(data.note).toBe('read-only profile; nothing was changed');
  });

  it('lets an agent read only its own profile, never its direct-message rooms', async () => {
    const { app } = await setup();
    const self = await app.inject({
      method: 'GET',
      url: '/api/agents/test-session-1/profile',
      headers: { 'x-reverie-parent-session': 'test-session-1' },
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().data.rooms).toEqual([{ id: 'r1', name: 'general', role: 'coordinator' }]);
    for (const header of ['other-session-2', 'not-a-session', '']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agents/test-session-1/profile',
        headers: { 'x-reverie-parent-session': header },
      });
      expect(res.statusCode, header).toBe(403);
    }
  });

  it('answers 404 for an unknown session', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/agents/nobody/profile' });
    expect(res.statusCode).toBe(404);
  });

  it('answers 502 with the reason when the configured runtime policy is unusable', async () => {
    writeFileSync(
      join(dir, 'policy.json'),
      JSON.stringify({
        state_file: 'state.json',
        fallback: 'local',
        backends: { local: { mode: 'claude', enabled: true } },
      })
    );
    const { app } = await setup(sources({ runtimePolicy: join(dir, 'policy.json') }));
    const res = await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('the fallback must use the local OpenCode adapter');
  });

  it('is single-user only, and still hides other users sessions in multi-user mode', async () => {
    vi.stubEnv('REVERIE_MULTIUSER', '1');
    const stranger = await setup(sources(), { username: 'someone-else', role: 'user' });
    const hidden = await stranger.app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(hidden.statusCode).toBe(404);
    const admin = await setup(sources(), { username: 'admin', role: 'admin' });
    const res = await admin.app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(res.statusCode).toBe(501);
  });
});

describe('buildProfile', () => {
  const live = {
    id: 'sess-1',
    name: 'alpha',
    status: 'busy',
    pid: 0,
    mode: 'claude',
    model: '',
    displayModel: { model: 'model-x' },
    effort: 'high',
    claudeSessionChain: ['older', CONVERSATION],
    tokens: { input: 5, total: 9 },
    outputTokens: 4,
    totalCost: 0.5,
    messageCount: 3,
    workingDir: '/work',
  };

  it('reads the session state like the runtime did: display model, counters and liveness', () => {
    const data = buildProfile(sources(), 'sess-1', { session: live }, { includeDms: true });
    expect(data.session).toEqual({
      id: 'sess-1',
      name: 'alpha',
      status: 'busy',
      alive: true,
      pinned: false,
      created_at: null,
      last_activity_at: null,
      working_dir: '/work',
    });
    expect(data.backend).toEqual({ mode: 'claude', model: 'model-x', display_model: 'model-x' });
    expect(data.usage).toEqual({
      input_tokens: 5,
      output_tokens: 4,
      total_tokens: 9,
      cost: 0.5,
      messages: 3,
      scope: 'console counters for this session since created_at; no per-day history is recorded yet',
    });
    expect(data.effort).toEqual({ configured: 'high', observed: null });
    expect(
      (
        buildProfile(sources(), 'sess-1', { ...live, paneExit: { code: 1 } }, { includeDms: true }).session as {
          alive: boolean;
        }
      ).alive
    ).toBe(false);
  });

  it('refuses an invalid session id', () => {
    expect(() => buildProfile(sources(), '-bad', {}, { includeDms: true })).toThrow('invalid session id');
  });

  it("reports the newest effort in the newest transcript's tail", () => {
    const projects = join(dir, 'projects');
    for (const [project, lines, age] of [
      ['old', [{ effort: 'low' }], 100],
      [
        'new',
        [{ effort: 'medium', timestamp: 't1' }, { effort: 'max', timestamp: 't2' }, { effort: 'bogus' }, 'not json'],
        0,
      ],
    ] as const) {
      mkdirSync(join(projects, project), { recursive: true });
      const path = join(projects, project, `${CONVERSATION}.jsonl`);
      writeFileSync(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));
      const when = Date.now() / 1000 - age;
      utimesSync(path, when, when);
    }
    expect(observedEffort(CONVERSATION, projects)).toEqual({ level: 'max', at: 't2' });
    expect(
      (buildProfile(sources(), 'sess-1', live, { includeDms: true }).effort as { observed: unknown }).observed
    ).toEqual({ level: 'max', at: 't2' });
    expect(observedEffort('not-a-uuid', projects)).toBeNull();
    expect(observedEffort(CONVERSATION, join(dir, 'missing'))).toBeNull();
  });

  it('never follows a transcript symlink', () => {
    const projects = join(dir, 'projects');
    mkdirSync(join(projects, 'p'), { recursive: true });
    writeFileSync(join(dir, 'real.jsonl'), JSON.stringify({ effort: 'max' }));
    symlinkSync(join(dir, 'real.jsonl'), join(projects, 'p', `${CONVERSATION}.jsonl`));
    expect(observedEffort(CONVERSATION, projects)).toBeNull();
  });

  describe('with a runtime policy', () => {
    const instance = (persona = 'Careful and kind.') =>
      JSON.stringify({
        id: 'alpha',
        agent_name: 'Alpha',
        owner_name: 'Owner',
        data_dir: '../state/alpha',
        persona,
        role: 'Engineer',
        kind: 'expert',
      });

    function policy(
      extra: Record<string, unknown> = {},
      state: Record<string, unknown> | null = { current: 'sess-1', backend: 'local', phase: 'running' }
    ) {
      mkdirSync(join(dir, 'instances'), { recursive: true });
      writeFileSync(
        join(dir, 'policy.json'),
        JSON.stringify({
          state_file: 'state.json',
          fallback: 'local',
          instances_dir: 'instances',
          backends: {
            local: { mode: 'opencode', model: 'm/local', enabled: true },
            cloud: { mode: 'claude', model: 'c' },
          },
          ...extra,
        })
      );
      if (state) writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
      return sources({ runtimePolicy: join(dir, 'policy.json') });
    }

    it('reports the supervised runtime and its backends for the current session only', () => {
      const src = policy();
      expect(buildProfile(src, 'sess-1', live, { includeDms: true }).runtime).toMatchObject({
        supervised: true,
        backend: 'local',
        phase: 'running',
        backends: [
          { name: 'local', mode: 'opencode', model: 'm/local', enabled: true },
          { name: 'cloud', mode: 'claude', model: 'c', enabled: false },
        ],
      });
      expect(buildProfile(src, 'other-1', live, { includeDms: true }).runtime).toMatchObject({
        supervised: false,
        backends: [],
      });
    });

    it("reads the persona from the policy's agent_instances map, confined to instances_dir", () => {
      const src = policy({ agent_instances: { 'other-1': 'instances/alpha.json', 'other-2': '../outside.json' } });
      writeFileSync(join(dir, 'instances', 'alpha.json'), instance('x'.repeat(2500)));
      writeFileSync(join(dir, 'outside.json'), instance());
      const persona = buildProfile(src, 'other-1', live, { includeDms: true }).persona as Record<string, unknown>;
      expect(persona).toMatchObject({
        agent_name: 'Alpha',
        role: 'Engineer',
        kind: 'expert',
        source: join(dir, 'instances', 'alpha.json'),
      });
      expect((persona.persona as string).length).toBe(2000);
      expect(buildProfile(src, 'other-2', live, { includeDms: true }).persona).toBeNull();
    });

    it("uses the current session's workspace marker, and reports an unreadable config instead of hiding it", () => {
      mkdirSync(join(dir, 'work'), { recursive: true });
      writeFileSync(
        join(dir, 'work', '.reverie-instance'),
        JSON.stringify({ instance: join(dir, 'instances', 'missing.json') })
      );
      const src = policy();
      expect(
        buildProfile(src, 'sess-1', { ...live, workingDir: join(dir, 'work') }, { includeDms: true }).persona
      ).toEqual({
        error: 'instance config unreadable',
        source: join(dir, 'instances', 'missing.json'),
      });
      writeFileSync(join(dir, 'instances', 'missing.json'), ' '.repeat(INSTANCE_BYTES + 1));
      expect(
        (
          buildProfile(src, 'sess-1', { ...live, workingDir: join(dir, 'work') }, { includeDms: true }).persona as {
            error: string;
          }
        ).error
      ).toBe('instance config unreadable');
    });

    it('treats a missing state file as no supervised session', () => {
      expect(buildProfile(policy({}, null), 'sess-1', live, { includeDms: true }).runtime).toMatchObject({
        supervised: false,
      });
    });

    it('never blocks on an agent-writable state file: a FIFO, symlink, oversize or malformed file reads as unsupervised', () => {
      const src = policy({}, null);
      const statePath = join(dir, 'state.json');
      const variants: Array<[string, () => void]> = [
        ['fifo', () => execFileSync('mkfifo', [statePath])],
        [
          'symlink to a fifo',
          () => {
            rmSync(join(dir, 'target-fifo'), { force: true });
            execFileSync('mkfifo', [join(dir, 'target-fifo')]);
            symlinkSync(join(dir, 'target-fifo'), statePath);
          },
        ],
        [
          'oversize',
          () => writeFileSync(statePath, JSON.stringify({ current: 'sess-1', pad: 'x'.repeat(POLICY_BYTES) })),
        ],
        ['malformed', () => writeFileSync(statePath, '{"current": ')],
      ];
      for (const [name, make] of variants) {
        rmSync(statePath, { force: true });
        make();
        const started = Date.now();
        const runtime = buildProfile(src, 'sess-1', live, { includeDms: true }).runtime;
        expect(runtime, name).toMatchObject({ supervised: false, backends: [] });
        expect(Date.now() - started, name).toBeLessThan(2000);
      }
    });

    it("follows a state-file symlink to a regular file, as the runtime's path resolution did", () => {
      const src = policy({}, null);
      writeFileSync(join(dir, 'real-state.json'), JSON.stringify({ current: 'sess-1', phase: 'running' }));
      symlinkSync(join(dir, 'real-state.json'), join(dir, 'state.json'));
      expect(buildProfile(src, 'sess-1', live, { includeDms: true }).runtime).toMatchObject({
        supervised: true,
        phase: 'running',
      });
    });

    it('refuses a policy file that is a FIFO promptly instead of stalling the server', async () => {
      const fifo = join(dir, 'policy-fifo');
      execFileSync('mkfifo', [fifo]);
      const { app } = await setup(sources({ runtimePolicy: fifo }));
      const started = Date.now();
      const res = await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('not a regular file');
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});

describe('parseInstance', () => {
  const base = { id: 'alpha', agent_name: 'A', owner_name: 'O', data_dir: '/state/a', persona: 'P' };
  it('accepts a valid config with defaults', () => {
    expect(parseInstance(JSON.stringify(base), '/cfg/a.json')).toEqual({
      agent_name: 'A',
      role: 'Expert',
      kind: 'agent',
      persona: 'P',
    });
  });
  it.each([
    [{ ...base, extra: 1 }, 'supported fields only'],
    [{ ...base, persona: ' ' }, 'nonempty persona'],
    [{ ...base, id: '-x' }, 'invalid instance id'],
    [{ ...base, data_dir: '/cfg' }, 'separate state directory'],
    [{ ...base, data_dir: '/' }, 'separate state directory'],
    [{ ...base, kind: 'boss' }, 'invalid agent kind'],
    [{ ...base, role: null }, 'role must be nonempty text'],
    [{ ...base, shared_room_tone: 'loud' }, 'shared_room_tone'],
    [{ ...base, employee_id: 'ABC' }, 'lowercase UUID'],
    [{ ...base, initial_self: { consciousness: 'c', directives: [''] } }, 'initial_self'],
  ])('refuses %j', (config, message) => {
    expect(() => parseInstance(JSON.stringify(config), '/cfg/a.json')).toThrow(message);
  });
});

/**
 * The reference fixture holds the unmodified runtime's `profile()` output for each case, run once
 * over the same files and API data with a fake console API. Paths are written relative to `<ROOT>`.
 */
describe('parity with the runtime profile report', () => {
  type Reference = {
    inputs: {
      files: Record<string, unknown>;
      pad_persona: { path: string; repeat: number };
      mtimes: Record<string, number>;
      sessions: Record<string, unknown>;
      company: { employees: ProfileSources['employees'] extends () => infer E ? E : never };
      rooms: ReturnType<ProfileSources['rooms']>;
      cases: Array<[string, boolean]>;
    };
    outputs: unknown[];
  };
  const reference = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'agent-profile-reference.json'), 'utf8')
  ) as Reference;

  it('matches every recorded case', () => {
    const root = realpathSync(dir);
    const inputs = JSON.parse(JSON.stringify(reference.inputs).replaceAll('<ROOT>', root)) as Reference['inputs'];
    for (const [rel, content] of Object.entries(inputs.files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), typeof content === 'string' ? content : JSON.stringify(content));
    }
    const padded = join(root, inputs.pad_persona.path);
    const config = JSON.parse(readFileSync(padded, 'utf8')) as { persona: string };
    config.persona += 'y'.repeat(inputs.pad_persona.repeat);
    writeFileSync(padded, JSON.stringify(config));
    for (const [rel, when] of Object.entries(inputs.mtimes)) utimesSync(join(root, rel), when, when);
    const src: ProfileSources = {
      transcriptProjectsDir: join(root, 'cli', 'projects'),
      runtimePolicy: join(root, 'policy.json'),
      employees: () => inputs.company.employees,
      rooms: () => inputs.rooms,
    };
    inputs.cases.forEach(([sessionId, includeDms], index) => {
      const state = { session: inputs.sessions[sessionId] };
      const actual = JSON.parse(
        JSON.stringify(buildProfile(src, sessionId, state, { includeDms })).replaceAll(root, '<ROOT>')
      );
      expect(actual, `case ${index}: ${sessionId} dms=${includeDms}`).toEqual(reference.outputs[index]);
    });
  });
});
