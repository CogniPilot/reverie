/** Ordinary managed argv validation only. Importing the external fake never launches it. */
import { expect, it } from 'vitest';
import { planProviderLaunch } from './fixtures/boxed-plan-provider.mjs';
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
