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
