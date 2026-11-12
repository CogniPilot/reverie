/**
 * @fileoverview Pins the environment isolation `test/setup.ts` provides.
 *
 * The suite's hermeticity rests on a temp `HOME` plus a short list of env vars that are
 * deleted before any application module loads. That list is easy to under-maintain: it grew
 * once for auth (`REVERIE_PASSWORD`/`REVERIE_USERNAME`) and once for `REVERIE_GESTURE`, both
 * times only after a leak had already produced a confusing failure, and it was still missing
 * the three INSTANCE-selection vars.
 *
 * Those three matter more than the ones already on the list, because `src/config/instance.ts`
 * derives BOTH the data dir and the tmux socket from them, and `REVERIE_DATA_DIR` is an
 * absolute path that bypasses `HOME` entirely — so a developer who exports it has the suite
 * reading and writing their real `state.json` rather than a throwaway tree.
 *
 * ⚠️ The runtime half of this file cannot fail on a machine where the vars were never set, so
 * it is not enough on its own: a `delete` line removed from `setup.ts` would still pass here
 * on almost every developer's box and on CI. The STATIC half is what actually guards the
 * list — it reads `setup.ts` and asserts each name is deleted there, which fails wherever the
 * suite runs. Both halves are deliberate; do not drop the static one as redundant.
 *
 * Port: none (pure, over process.env and one source file).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

/** Every env var `setup.ts` must strip, with why it would otherwise leak. */
const STRIPPED_ENV_VARS: Array<[name: string, why: string]> = [
  ['REVERIE_PASSWORD', 'auth from a running instance would make protected routes behave differently'],
  ['REVERIE_USERNAME', 'same, and it changes which owner scoping resolves to'],
  ['REVERIE_GESTURE', 'flips renderIndexHtml output and breaks byte-identity assertions'],
  ['REVERIE_BASE_URL', 'mounts the server under a sub-path and breaks the root-install byte-identity assertions'],
  ['REVERIE_INSTANCE', 'moves the data dir to ~/.reverie-<name> and the tmux socket to reverie-<name>'],
  ['REVERIE_DATA_DIR', 'ABSOLUTE override: bypasses the temp HOME and points the suite at a real data dir'],
  ['REVERIE_TMUX_SOCKET', 'renames the socket resolveTmuxSocketName() returns'],
  ['CLAUDE_CONFIG_DIR', 'relocates the Claude tree, so transcript fixtures under the temp HOME read as missing'],
  ['CODEX_HOME', 'relocates the Codex login and transcript tree outside temporary HOME'],
  ['DSH_HOME', 'relocates executable provider profile configuration'],
  ['GEMINI_CLI_HOME', 'relocates provider configuration and login files'],
  ['GROK_HOME', 'relocates provider configuration and login files'],
  ['PI_CODING_AGENT_DIR', 'relocates agent configuration and login files'],
  ['OPENCODE_CONFIG', 'selects an external provider configuration file'],
  ['OPENCODE_CONFIG_DIR', 'selects an external provider configuration directory'],
  ['OPENCODE_CONFIG_CONTENT', 'injects provider configuration and credentials directly'],
  ['GOOGLE_APPLICATION_CREDENTIALS', 'selects an external provider credential file'],
  ['ANTHROPIC_AUTH_TOKEN', 'authenticates external provider requests'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'authenticates external provider requests'],
  ['OPENAI_ACCESS_TOKEN', 'authenticates external provider requests'],
  ['CODEX_AUTH_TOKEN', 'authenticates external provider requests'],
  ['GOOGLE_OAUTH_ACCESS_TOKEN', 'authenticates external provider requests'],
  ['OMP_AUTH_BROKER_TOKEN', 'authenticates external provider broker requests'],
  ['REVERIE_CASES_PATH', 'bypasses the temporary HOME and points case routes at a deployment bind mount'],
];

const SETUP_SOURCE = readFileSync(fileURLToPath(new URL('./setup.ts', import.meta.url)), 'utf-8');

/**
 * Just the top-of-file STRIP section, cut at the first hook.
 *
 * The teardown below it restores HOME/USERPROFILE/VITEST/PLAYWRIGHT_BROWSERS_PATH with the
 * same `delete` syntax, and those are the opposite of a strip — counting them would make the
 * anti-drift check demand a reason for a var the suite deliberately puts back.
 */
const SETUP_STRIP_SECTION = SETUP_SOURCE.split(/^afterEach\(/m)[0];

describe('test environment isolation', () => {
  it('keeps XDG configuration, cache and data inside temporary HOME', () => {
    expect(process.env.XDG_CONFIG_HOME).toBe(join(process.env.HOME!, '.config'));
    expect(process.env.XDG_CACHE_HOME).toBe(join(process.env.HOME!, '.cache'));
    expect(process.env.XDG_DATA_HOME).toBe(join(process.env.HOME!, '.local', 'share'));
    expect(Object.keys(process.env).filter((key) => key.endsWith('_API_KEY'))).toEqual([]);
  });
  it('removes every inherited REVERIE_* environment variable', () => {
    expect(Object.keys(process.env).filter((key) => key.startsWith('REVERIE_'))).toEqual([]);
  });

  it.each(STRIPPED_ENV_VARS)('%s is unset while the suite runs', (name) => {
    expect(process.env[name], `${name} leaked into the test environment`).toBeUndefined();
  });

  it.each(STRIPPED_ENV_VARS)('setup.ts deletes %s (%s)', (name) => {
    // The half that fails everywhere, not just on a machine that happens to export the var.
    expect(SETUP_SOURCE, `setup.ts no longer deletes ${name}`).toContain(`delete process.env.${name};`);
  });

  it('runs against a throwaway HOME, not the real one', () => {
    // The property every other test's isolation is built on: `~/.reverie` and `~/reverie-cases`
    // both resolve under here, so a test that writes state cannot reach the developer's own.
    const home = process.env.HOME ?? process.env.USERPROFILE;
    expect(home).toBeTruthy();
    expect(home).toContain('reverie-vitest-');
  });

  it('lists every name the setup file strips (anti-drift)', () => {
    // Catches the other direction: a var added to setup.ts but never given a reason here, so
    // the next person cannot tell whether it is load-bearing or left over.
    const deleted = [...SETUP_STRIP_SECTION.matchAll(/delete process\.env\.([A-Z0-9_]+);/g)].map((m) => m[1]).sort();
    expect(deleted).toEqual(STRIPPED_ENV_VARS.map(([name]) => name).sort());
  });

  it('isolates actual module discovery in a child seeded with external provider homes and keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-isolation-'));
    try {
      const external = join(root, 'external');
      const childTemp = join(root, 'tmp');
      mkdirSync(external);
      mkdirSync(childTemp);
      const marker = join(external, 'auth.json');
      const registry = join(external, 'subscription-profiles.json');
      writeFileSync(marker, 'synthetic-external-credential');
      writeFileSync(registry, 'synthetic-external-registry');
      const snapshot = () =>
        readdirSync(external)
          .sort()
          .map((name) => {
            const file = join(external, name),
              info = statSync(file);
            return { name, bytes: readFileSync(file, 'utf8'), mode: info.mode, ino: info.ino, modified: info.mtimeMs };
          });
      const before = snapshot();
      const output = join(root, 'child.mjs');
      await build({
        stdin: {
          contents: `
            import './test/setup.ts';
            import fs from 'node:fs';
            import assert from 'node:assert/strict';
            import { syncBuiltinESMExports } from 'node:module';
            import { join } from 'node:path';
            let reads = 0;
            for (const name of ['readFile', 'stat', 'access', 'readdir', 'realpath', 'open']) {
              const original = fs.promises[name];
              fs.promises[name] = function(path, ...args) {
                if (String(path).startsWith(process.env.FIXTURE_EXTERNAL)) { reads++; throw Error('External fixture access'); }
                return original.call(this, path, ...args);
              };
            }
            syncBuiltinESMExports();
            const { readSubscriptionProfiles, defaultSubscriptionProfiles } = await import('./src/subscription-profiles.ts');
            assert.deepEqual(await readSubscriptionProfiles(), []);
            for (const profile of defaultSubscriptionProfiles()) {
              assert.ok(profile.configDir.startsWith(process.env.HOME + '/'));
              assert.ok(profile.openCodeDataDir.startsWith(process.env.HOME + '/'));
            }
            for (const key of ${JSON.stringify(STRIPPED_ENV_VARS.map(([key]) => key))}) assert.equal(process.env[key], undefined);
            assert.equal(Object.keys(process.env).filter(key => key.startsWith('REVERIE_')).length, 0);
            assert.equal(Object.keys(process.env).filter(key => key.endsWith('_API_KEY')).length, 0);
            assert.equal(reads, 0);
            assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, 'synthetic-browser-installation');
            assert.equal(process.env.NIX_REVERIE_TEST_ROOT_CUSTODY, '1');
            assert.equal(process.env.NIX_VIEWER_FIXTURE_IMAGE, 'synthetic-native-opt-in');
            for (const hook of globalThis.fixtureAfterAll) await hook();
            process.stdout.write('isolated');`,
          resolveDir: fileURLToPath(new URL('..', import.meta.url)),
          sourcefile: 'synthetic-setup-child.ts',
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: output,
        logLevel: 'silent',
        plugins: [
          {
            name: 'owned-hook-registration',
            setup(builder) {
              builder.onResolve({ filter: /^vitest$/ }, () => ({ path: 'vitest', namespace: 'owned-hooks' }));
              builder.onLoad({ filter: /.*/, namespace: 'owned-hooks' }, () => ({
                contents: `
            globalThis.fixtureAfterAll = [];
            export const afterAll = hook => globalThis.fixtureAfterAll.push(hook);
            export const afterEach = () => {};
            export const vi = { clearAllMocks(){}, useRealTimers(){} };`,
              }));
            },
          },
        ],
      });
      const overrides = Object.fromEntries(STRIPPED_ENV_VARS.map(([key]) => [key, external]));
      expect(
        execFileSync(process.execPath, [output], {
          encoding: 'utf8',
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            HOME: external,
            USERPROFILE: external,
            TMPDIR: childTemp,
            ...overrides,
            XDG_CONFIG_HOME: external,
            XDG_CACHE_HOME: external,
            XDG_DATA_HOME: external,
            OPENAI_API_KEY: 'synthetic-key',
            CUSTOM_PROVIDER_API_KEY: 'synthetic-custom-key',
            PLAYWRIGHT_BROWSERS_PATH: 'synthetic-browser-installation',
            NIX_REVERIE_TEST_ROOT_CUSTODY: '1',
            NIX_VIEWER_FIXTURE_IMAGE: 'synthetic-native-opt-in',
            REVERIE_UNKNOWN_FUTURE_FLAG: 'synthetic-instance-override',
            FIXTURE_EXTERNAL: external,
          },
        })
      ).toBe('isolated');
      expect(readFileSync(marker, 'utf8')).toBe('synthetic-external-credential');
      expect(readFileSync(registry, 'utf8')).toBe('synthetic-external-registry');
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
