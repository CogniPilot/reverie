import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Ordinary managed argv validation only. Importing the external fake never launches it. */
import { expect, it, vi } from 'vitest';
import {
  planProviderIsMain,
  planProviderLaunch,
  observedPlanFixtureCli,
  planFixtureStage,
} from './fixtures/boxed-plan-provider.mjs';
import { workerHookSettings } from '../src/worker-client-callback.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { runPlanOfficePermissionProbe, PlanOfficePermissionProbe } from './helpers/plan-office-permission-probe.js';
import {
  DockerWorkerIdentityAuthentication,
  registerDockerWorkerIdentity,
  dockerWorkerIdentityOf,
} from '../src/docker-worker-identity.js';
import { registerPlanRequestRoutes } from '../src/web/routes/plan-request-routes.js';
import { agentPlanRequestExecution } from '../src/agent-plan-request.js';
import type { PlanMoveRuntime } from '../src/plan-move-runtime.js';
import type { PlanMoveRequests } from '../src/plan-request.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { PlanProviderFixtureFiles } from './helpers/boxed-plan-provider-files.js';
const sid = '11111111-1111-4111-8111-111111111111',
  thread = '22222222-2222-4222-8222-222222222222';
const env = {
  HOME: '/home/agent',
  REVERIE_SESSION_ID: sid,
  REVERIE_HOOK_GENERATION: '33333333-3333-4333-8333-333333333333',
};
const args = ['--dangerously-skip-permissions', '--settings', JSON.stringify(workerHookSettings()), '--resume', thread];
it('observes real HMAC route grant/revocation status without creating work or publishing hostile payloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-probe-'));
  fs.chmodSync(root, 0o700);
  const eid = '33333333-3333-4333-8333-333333333333',
    targetId = '44444444-4444-4444-8444-444444444444';
  const binding = {
    employeeId: eid,
    sessionId: sid,
    sessionGeneration: 1,
    owner: undefined,
    containerId: 'a'.repeat(64),
    credentialId: '55555555-5555-4555-8555-555555555555',
  };
  const auth = new DockerWorkerIdentityAuthentication('66666666-6666-4666-8666-666666666666', Buffer.alloc(32, 65), {
    binding: () => binding,
    keyCurrent: () => true,
  });
  const token = auth.issue(binding, () => true),
    credential = path.join(root, 'identity');
  fs.writeFileSync(credential, token + '\n', { mode: 0o600 });
  const actualEnv = {
    HOME: '/home/agent',
    REVERIE_API_URL: '',
    REVERIE_SESSION_ID: sid,
    REVERIE_WORKER_IDENTITY_FILE: credential,
    REVERIE_PASSWORD: 'HOSTILE_HUMAN_PASSWORD',
  };
  const app = Fastify();
  const employees = [
    {
      id: eid,
      sessionId: sid,
      owner: undefined,
      desiredRunning: true,
      permissions: { moveOwnPlan: false, managePlans: false },
    },
    {
      id: targetId,
      sessionId: thread,
      owner: undefined,
      desiredRunning: true,
      permissions: { moveOwnPlan: true, managePlans: false },
    },
  ];
  const runtime = {
    sessions: new Map([
      [sid, { id: sid, owner: undefined }],
      [thread, { id: thread, owner: undefined }],
    ]),
    company: { view: () => ({ employees }) },
    plans: {},
    chat: {},
    mux: {},
    cleanup: vi.fn(),
  } as unknown as Omit<PlanMoveRuntime, 'authorized' | 'request'>;
  const create = vi.fn();
  registerDockerWorkerIdentity(app, auth);
  app.get('/api/company', (req) => {
    expect(dockerWorkerIdentityOf(req)?.employeeId).toBe(eid);
    expect(req.headers.authorization).toBeUndefined();
    return { success: true, data: { employees }, hostile: token };
  });
  registerPlanRequestRoutes(
    app,
    { create, bindingOf: () => thread, pendingForEmployee: () => [] } as unknown as PlanMoveRequests,
    { sessions: runtime.sessions, authSessions: new Map() } as unknown as Parameters<
      typeof registerPlanRequestRoutes
    >[2],
    undefined,
    () => {
      throw Error('Owner authority must not be used');
    },
    (req, input) =>
      agentPlanRequestExecution(req, input, runtime, async () => {
        throw Error('No native executor in transport unit test');
      }),
    () => ({ sessionId: sid })
  );
  const records: unknown[] = [];
  const record = (kind: 'intent' | 'returned', value: unknown) => {
    records.push({ kind, value });
  };
  const base = {
    version: 1,
    purpose: 'reverie-ci-team-permission-probe-v1',
    callerEmployeeId: eid,
    callerSessionId: sid,
    employeeId: targetId,
    sessionId: thread,
    toAccount: 'ci-plan-b',
  };
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    actualEnv.REVERIE_API_URL = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
    for (const [index, granted] of [false, true, false].entries()) {
      employees[0]!.permissions.managePlans = granted;
      const receipt = await runPlanOfficePermissionProbe(
        {
          ...base,
          id: `00000000-0000-4000-8000-00000000000${index}`,
          scope: granted ? 'team-pending' : 'team-request',
        },
        eid,
        record,
        actualEnv
      );
      expect(receipt).toMatchObject({
        status: granted ? 200 : 403,
        code: granted ? null : 'FORBIDDEN',
        success: granted,
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain(actualEnv.REVERIE_PASSWORD);
    expect(records.map((r) => (r as { kind: string }).kind)).toEqual([
      'intent',
      'returned',
      'intent',
      'returned',
      'intent',
      'returned',
    ]);
    for (const change of [
      { employeeId: eid },
      { callerSessionId: thread },
      { url: '/api/sessions' },
      { scope: 'owner-force' },
    ]) {
      expect(() => PlanOfficePermissionProbe.parse({ ...base, id: sid, scope: 'team-request', ...change })).toThrow();
    }
    const unavailable = vi.fn(async () => {
      throw Error('HOSTILE_TRANSPORT_TOKEN');
    });
    await expect(
      runPlanOfficePermissionProbe({ ...base, id: sid, scope: 'team-request' }, eid, record, actualEnv, unavailable)
    ).rejects.toThrow();
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect((records.at(-1) as { kind: string }).kind).toBe('intent');
    expect(JSON.stringify(records)).not.toContain('HOSTILE_TRANSPORT_TOKEN');
    const noIdentity = vi.fn();
    await expect(
      runPlanOfficePermissionProbe(
        { ...base, id: sid, scope: 'team-request' },
        eid,
        record,
        { ...actualEnv, REVERIE_WORKER_IDENTITY_FILE: undefined, REVERIE_MUX: '1' },
        noIdentity
      )
    ).rejects.toThrow();
    expect(noIdentity).not.toHaveBeenCalled();
    fs.mkdirSync(path.join(root, '.fixture'), 0o700);
    const files = new PlanProviderFixtureFiles(root, undefined);
    const attempted = { ...base, id: '99999999-9999-4999-8999-999999999999', scope: 'team-request' };
    fs.writeFileSync(
      path.join(root, '.fixture', 'plan-permission-probe-' + attempted.id + '.json'),
      JSON.stringify(attempted),
      { mode: 0o600 }
    );
    expect(files.permissionProbe(attempted.id)).toEqual(attempted);
    const published = (kind: 'intent' | 'returned', value: unknown) => files.permissionProbeRecord(kind, value);
    await runPlanOfficePermissionProbe(attempted, eid, published, actualEnv);
    const replay = vi.fn();
    await expect(runPlanOfficePermissionProbe(attempted, eid, published, actualEnv, replay)).rejects.toThrow();
    expect(replay).not.toHaveBeenCalled();
    expect(files.allowApproval(attempted.id)).toBe(false);
    fs.writeFileSync(
      path.join(root, '.fixture', 'plan-team-cooperation-' + attempted.id + '.json'),
      JSON.stringify({ version: 1, purpose: 'reverie-ci-team-positive-cooperation-v1', id: attempted.id }),
      { mode: 0o600 }
    );
    expect(files.allowApproval(attempted.id)).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true });
  }
});
it('parses ordinary actual managed settings and full resume thread without launching a child', () => {
  expect(planProviderLaunch(args, env)).toMatchObject({
    sessionId: sid,
    providerThread: thread,
    hookGeneration: env.REVERIE_HOOK_GENERATION,
  });
  expect(planProviderLaunch([...args.slice(0, -2), '--session-id', thread], env).providerThread).toBe(thread);
});
it('rejects duplicate or missing threads/settings and non-managed callback commands', () => {
  for (const invalid of [
    args.concat('--session-id', thread),
    args.concat('--settings', '{}'),
    args.slice(0, -2),
    ['--resume', thread, '--settings', '{}'],
  ])
    expect(() => planProviderLaunch(invalid, env)).toThrow();
  const settings = workerHookSettings();
  settings.hooks.Stop[0]!.hooks[0]!.command = 'arbitrary caller command';
  expect(() => planProviderLaunch(['--resume', thread, '--settings', JSON.stringify(settings)], env)).toThrow();
});
it('refuses missing actual session/generation and arbitrary HOME', () => {
  for (const altered of [
    { ...env, HOME: '/fixture/accounts' },
    { ...env, REVERIE_SESSION_ID: 'shortsid' },
    { ...env, REVERIE_HOOK_GENERATION: '' },
  ])
    expect(() => planProviderLaunch(args, altered)).toThrow();
});

it('recognizes the actual executable through a Nix-style alias without activating imported fixtures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-main-alias-'));
  try {
    const entry = fileURLToPath(new URL('./fixtures/boxed-plan-provider.mts', import.meta.url)),
      alias = path.join(root, 'claude');
    fs.symlinkSync(entry, alias);
    expect(planProviderIsMain(alias)).toBe(true);
    expect(planProviderIsMain(entry)).toBe(true);
    expect(planProviderIsMain(fileURLToPath(import.meta.url))).toBe(false);
    expect(planProviderIsMain(path.join(root, 'absent'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function diagnosticFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-diagnostics-'));
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, '.fixture'), 0o700);
  const files = new PlanProviderFixtureFiles(home, undefined);
  const records = () =>
    fs
      .readdirSync(path.join(home, '.fixture'))
      .sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(home, '.fixture', name), 'utf8')));
  return { home, files, records };
}
it('closes an issued diagnostic before the physical CLI and retains original failed exit digests only', async () => {
  const f = diagnosticFixture(),
    stdout = 'synthetic private stdout',
    stderr = 'synthetic private stderr';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    const run = vi.fn(async () => {
      expect(f.records()).toMatchObject([{ stage: 'capabilities', state: 'issued' }]);
      return { exitCode: 4, signal: null, stdout, stderr, stdoutSha256: hash(stdout), stderrSha256: hash(stderr) };
    });
    const reply = await observedPlanFixtureCli(f.files, run)(['agent', 'capabilities', '--json']);
    expect(reply.exitCode).toBe(4);
    expect(run).toHaveBeenCalledOnce();
    expect(f.records()).toMatchObject([
      { state: 'issued' },
      { stage: 'capabilities', state: 'failed', exitCode: 4, stdoutSha256: hash(stdout), stderrSha256: hash(stderr) },
    ]);
    expect(JSON.stringify(f.records())).not.toContain(stdout);
    expect(JSON.stringify(f.records())).not.toContain(stderr);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
it('never retries an unknown probe, emits a composer, or dispatches after diagnostic custody failure', async () => {
  const f = diagnosticFixture();
  try {
    const run = vi.fn(async () => {
      throw Error('original transport outcome unknown');
    });
    await expect(observedPlanFixtureCli(f.files, run)(['agent', 'capabilities', '--json'])).rejects.toThrow(
      'original transport outcome unknown'
    );
    expect(run).toHaveBeenCalledOnce();
    expect(f.records()).toMatchObject([
      { state: 'issued' },
      { state: 'failed', exitCode: null, stdoutSha256: null, stderrSha256: null },
    ]);
    fs.chmodSync(path.join(f.home, '.fixture'), 0o755);
    await expect(observedPlanFixtureCli(f.files, run)(['agent', 'capabilities', '--json'])).rejects.toThrow(
      'Private fixture directory'
    );
    expect(run).toHaveBeenCalledOnce();
    await expect(observedPlanFixtureCli(f.files, run)(['arbitrary', 'command'])).rejects.toThrow('stage refused');
    expect(run).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
it('retains a failed launch-parser stage without converting it into readiness', async () => {
  const f = diagnosticFixture();
  try {
    await expect(planFixtureStage(f.files, 'launch-parse', () => planProviderLaunch([], env))).rejects.toThrow();
    expect(f.records()).toMatchObject([
      { stage: 'launch-parse', state: 'issued' },
      { stage: 'launch-parse', state: 'failed', exitCode: null },
    ]);
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
it('feeds actual stock renderer and metadata-selected argv into the same SDK parser without invoking a provider', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-renderer-'));
  fs.chmodSync(root, 0o700);
  try {
    const bin = path.join(root, 'bin'),
      config = path.join(root, '.claude'),
      project = path.join(config, 'projects', 'synthetic-project');
    fs.mkdirSync(bin, 0o700);
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(project, thread + '.jsonl'), 'metadata-only synthetic transcript\n', { mode: 0o600 });
    // This capture executable only prints argv; it cannot call an API or run the SDK.
    fs.writeFileSync(
      path.join(bin, 'claude'),
      '#!' + process.execPath + '\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o700 }
    );
    const command = buildSpawnCommand({
      mode: 'claude',
      boxedWorkerHooks: true,
      sessionId: sid,
      resumeSessionId: thread,
      claudeResumeCandidates: [thread],
    });
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: root,
      env: { HOME: root, CLAUDE_CONFIG_DIR: config, PATH: bin + ':' + process.env.PATH, LANG: 'C.UTF-8' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const launch = planProviderLaunch(JSON.parse(result.stdout), env);
    expect(launch.providerThread).toBe(thread);
    expect(launch.sessionId).toBe(sid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
