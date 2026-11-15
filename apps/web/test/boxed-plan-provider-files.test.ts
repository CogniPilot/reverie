/** Actual private fake-SDK files only; no image/API/provider/domain authority. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanProviderFixtureFiles } from './helpers/boxed-plan-provider-files.js';
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
