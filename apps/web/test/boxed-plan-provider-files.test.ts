/** Actual private fake-SDK files only; no image/API/provider/domain authority. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PlanProviderFixtureFiles,
  PlanFixtureDiagnostic,
  preparePlanOfficeWorkerHome,
} from './helpers/boxed-plan-provider-files.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-files-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, 0o700);
  fs.mkdirSync(path.join(home, '.fixture'), 0o700);
  const config = {
    version: 1,
    purpose: 'reverie-ci-plan-provider-v1',
    employeeId: '11111111-1111-4111-8111-111111111111',
    accounts: ['plan-a', 'plan-b'],
    autoApprove: true,
    exhausted: false,
    refreshAccountId: 'plan-a',
    pauseBeforeApproval: false,
  };
  fs.writeFileSync(path.join(home, '.fixture/plan-provider.json'), JSON.stringify(config), { mode: 0o600 });
  const generation = path.join(
    home,
    '.reverie/plan-moves/22222222-2222-4222-8222-222222222222/generation-' + 'a'.repeat(64) + '/claude'
  );
  fs.mkdirSync(generation, { recursive: true, mode: 0o700 });
  const original = JSON.stringify({
    claudeAiOauth: { accessToken: 'synthetic-original-plan-a', refreshToken: 'synthetic-refresh-token' },
  });
  fs.writeFileSync(path.join(generation, '.credentials.json'), original, { mode: 0o600 });
  const canonical = path.join(root, 'canonical-credentials.json');
  fs.writeFileSync(canonical, original, { mode: 0o600 });
  return { root, home, generation, canonical, original, files: new PlanProviderFixtureFiles(home, generation), config };
}
it('loads only the closed private contract and keeps each original approval latch durable without overwrite', () => {
  const f = fixture();
  expect(f.files.contract()).toEqual(f.config);
  expect(f.files.prepareApproval('request-1', 'synthetic handoff')).toBe('prepared');
  expect(f.files.prepareApproval('request-1', 'different content')).toBe('existing');
  expect(fs.readFileSync(path.join(f.home, '.fixture/plan-handoff-request-1.txt'), 'utf8')).toBe('synthetic handoff');
  expect(fs.statSync(path.join(f.home, '.fixture/plan-intent-request-1.json')).mode & 0o777).toBe(0o600);
  expect(new PlanProviderFixtureFiles(f.home, f.generation).prepareApproval('request-1', 'no replay')).toBe('existing');
  expect(() => f.files.prepareApproval('../escape', 'not written')).toThrow();
});
it('rotates only private generation SDK auth once and never changes canonical account bytes or stamp', () => {
  const f = fixture(),
    before = fs.statSync(f.canonical);
  f.files.refreshAuthOnce('plan-a');
  expect(
    JSON.parse(fs.readFileSync(path.join(f.generation, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken
  ).toBe('synthetic-refreshed-plan-a');
  const rotated = fs.statSync(path.join(f.generation, '.credentials.json'));
  f.files.refreshAuthOnce('plan-a');
  expect(fs.statSync(path.join(f.generation, '.credentials.json')).ino).toBe(rotated.ino);
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe(f.original);
  expect(fs.statSync(f.canonical).ino).toBe(before.ino);
  expect(fs.statSync(f.canonical).mtimeMs).toBe(before.mtimeMs);
  const marker = JSON.parse(fs.readFileSync(path.join(f.home, '.fixture/plan-refresh-plan-a.json'), 'utf8'));
  expect(marker.beforeDigest).not.toBe(marker.afterDigest);
});
it('refuses canonical or non-generation environment paths without writing them', () => {
  const f = fixture();
  for (const directory of [f.root, path.join(f.home, '.claude'), path.join(f.home, '.reverie/plan-moves/../canonical')])
    expect(() => new PlanProviderFixtureFiles(f.home, directory).refreshAuthOnce('plan-a')).toThrow();
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe(f.original);
  expect(() => f.files.refreshAuthOnce('plan-b')).toThrow('account refused');
});
it('refuses symlink and hardlink credentials instead of modifying an alias', () => {
  const f = fixture(),
    leaf = path.join(f.generation, '.credentials.json');
  fs.unlinkSync(leaf);
  fs.symlinkSync(f.canonical, leaf);
  expect(() => f.files.refreshAuthOnce('plan-a')).toThrow();
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe(f.original);
  fs.unlinkSync(leaf);
  fs.linkSync(f.canonical, leaf);
  expect(() => f.files.refreshAuthOnce('plan-a')).toThrow();
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe(f.original);
});
it('refuses nonprivate directories and non-synthetic credentials', () => {
  const f = fixture();
  fs.chmodSync(path.join(f.home, '.fixture'), 0o755);
  expect(() => f.files.contract()).toThrow();
  fs.chmodSync(path.join(f.home, '.fixture'), 0o700);
  fs.writeFileSync(
    path.join(f.generation, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-synthetic-fixture' } })
  );
  expect(() => f.files.refreshAuthOnce('plan-a')).toThrow('Only fake SDK');
});

it('reports only selected synthetic SDK auth and never exports credential bytes', () => {
  const f = fixture();
  expect(f.files.authStatus()).toEqual({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'ci-plan-fixture@example.invalid',
  });
  expect(() => new PlanProviderFixtureFiles(f.home, f.root).authStatus()).toThrow();
  const legacy = path.join(f.home, '.claude');
  fs.mkdirSync(legacy, 0o700);
  fs.writeFileSync(path.join(legacy, '.credentials.json'), f.original, { mode: 0o600 });
  expect(new PlanProviderFixtureFiles(f.home, undefined).authStatus().loggedIn).toBe(true);
});

it('keeps separate process receipts when a replacement container reuses the same namespace PID and SID', () => {
  const f = fixture();
  const report = {
    version: 1 as const,
    purpose: 'synthetic-plan-provider-turn-v1' as const,
    employeeId: f.config.employeeId,
    sessionId: '11111111-1111-4111-8111-111111111111',
    providerThread: '22222222-2222-4222-8222-222222222222',
    namespacePid: 485,
    hookGenerationSha256: 'a'.repeat(64),
    requestId: null,
    accountId: null,
    state: 'idle' as const,
    probes: [],
    limitation: 'External fake provider only; no native, permission, policy or paid-dispatch proof.' as const,
  };
  f.files.record(report);
  new PlanProviderFixtureFiles(f.home, f.generation).record(report);
  const names = fs.readdirSync(path.join(f.home, '.fixture')).filter((name) => name.startsWith('plan-turn-'));
  expect(names).toHaveLength(2);
  expect(new Set(names).size).toBe(2);
  for (const name of names)
    expect(JSON.parse(fs.readFileSync(path.join(f.home, '.fixture', name), 'utf8'))).toEqual(report);
});

it('prepares only private initial fake files and a matching real synthetic conversation without native authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-prep-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, 0o700);
  const provider = {
    version: 1,
    purpose: 'reverie-ci-plan-provider-v1',
    employeeId: '11111111-1111-4111-8111-111111111111',
    accounts: ['ci-plan-a', 'ci-plan-b'],
    autoApprove: true,
    exhausted: false,
    refreshAccountId: 'ci-plan-a',
    pauseBeforeApproval: false,
  };
  const input = {
    version: 1,
    purpose: 'reverie-ci-plan-worker-home-v1',
    sessionId: '22222222-2222-4222-8222-222222222222',
    nativeThreadId: '33333333-3333-4333-8333-333333333333',
    initialAccountId: 'ci-plan-a',
    provider,
  };
  const result = preparePlanOfficeWorkerHome(home, input);
  expect(result.home.uid).toBe(process.getuid!());
  expect(result.nativeThreadId).toBe(input.nativeThreadId);
  expect(new PlanProviderFixtureFiles(home, undefined).contract()).toEqual(provider);
  const history = path.join(
    home,
    '.claude/projects/-reverie-workspace-cases-boxed-canary',
    input.nativeThreadId + '.jsonl'
  );
  const lines = fs
    .readFileSync(history, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines.map((line) => line.sessionId)).toEqual([input.nativeThreadId, input.nativeThreadId]);
  expect(fs.statSync(history).mode & 0o777).toBe(0o600);
  const before = fs.readFileSync(history, 'utf8');
  expect(() => preparePlanOfficeWorkerHome(home, input)).toThrow('already exists');
  expect(fs.readFileSync(history, 'utf8')).toBe(before);
  expect(fs.readdirSync(home).sort()).toEqual(['.claude', '.fixture']);
});
it('refuses malformed initial scope and alias/nonprivate HOME before writing initial fake files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-prep-deny-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, 0o700);
  expect(() => preparePlanOfficeWorkerHome(home, { nativeThreadId: '../escape' })).toThrow();
  expect(fs.readdirSync(home)).toEqual([]);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(home, alias);
  const input = {
    version: 1,
    purpose: 'reverie-ci-plan-worker-home-v1',
    sessionId: '22222222-2222-4222-8222-222222222222',
    nativeThreadId: '33333333-3333-4333-8333-333333333333',
    initialAccountId: 'ci-plan-a',
    provider: {
      version: 1,
      purpose: 'reverie-ci-plan-provider-v1',
      employeeId: '11111111-1111-4111-8111-111111111111',
      accounts: ['ci-plan-a', 'ci-plan-b'],
      autoApprove: true,
      exhausted: false,
      refreshAccountId: null,
      pauseBeforeApproval: false,
    },
  };
  expect(() => preparePlanOfficeWorkerHome(alias, input)).toThrow();
  fs.chmodSync(home, 0o755);
  expect(() => preparePlanOfficeWorkerHome(home, input)).toThrow();
  expect(fs.readdirSync(home)).toEqual([]);
});

it('startup SDK refresh declines the other actual synthetic account without mutation or a false refresh marker', () => {
  const f = fixture(),
    file = path.join(f.generation, '.credentials.json');
  const other = JSON.stringify({
    claudeAiOauth: { accessToken: 'synthetic-original-plan-b', refreshToken: 'synthetic-refresh-plan-b' },
  });
  fs.writeFileSync(file, other);
  const before = fs.statSync(file);
  f.files.refreshAuthOnce('plan-a');
  expect(fs.readFileSync(file, 'utf8')).toBe(other);
  expect(fs.statSync(file).ino).toBe(before.ino);
  expect(fs.existsSync(path.join(f.home, '.fixture/plan-refresh-plan-a.json'))).toBe(false);
});

it('publishes distinct private stage diagnostics without authority, raw output or readiness claims', () => {
  const f = fixture();
  f.files.diagnostic('capabilities', 'issued');
  f.files.diagnostic('capabilities', 'failed', {
    exitCode: 4,
    signal: null,
    stdoutSha256: 'a'.repeat(64),
    stderrSha256: 'b'.repeat(64),
  });
  const names = fs.readdirSync(path.join(f.home, '.fixture')).filter((name) => name.startsWith('plan-diagnostic-'));
  expect(names).toHaveLength(2);
  const values = names.map((name) => {
    const file = path.join(f.home, '.fixture', name),
      stat = fs.lstatSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    return PlanFixtureDiagnostic.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  });
  expect(values.map((value) => value.state).sort()).toEqual(['failed', 'issued']);
  for (const value of values) {
    expect(value.namespacePid).toBe(process.pid);
    expect(value.purpose).toBe('synthetic-plan-provider-diagnostic-v1');
    for (const forbidden of ['stdout', 'stderr', 'token', 'isIdle', 'ready', 'identity', 'allowedActions'])
      expect(Object.hasOwn(value, forbidden)).toBe(false);
  }
  expect(() => f.files.diagnostic('not-a-stage' as never, 'issued')).toThrow();
  expect(() =>
    f.files.diagnostic('capabilities', 'failed', {
      exitCode: 4,
      signal: null,
      stdoutSha256: 'a'.repeat(64),
      stderrSha256: 'b'.repeat(64),
      stdout: 'secret',
    } as never)
  ).toThrow();
  expect(
    fs.readdirSync(path.join(f.home, '.fixture')).filter((name) => name.startsWith('plan-diagnostic-'))
  ).toHaveLength(2);
});
