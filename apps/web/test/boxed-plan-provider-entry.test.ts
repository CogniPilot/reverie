import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Ordinary managed argv validation only. Importing the external fake never launches it. */
import { expect, it } from 'vitest';
import { planProviderIsMain, planProviderLaunch } from './fixtures/boxed-plan-provider.mjs';
import { workerHookSettings } from '../src/worker-client-callback.js';
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
