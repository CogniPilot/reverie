/** Real owned process/PTY delivery; not Docker or authenticated vendor qualification. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux')(
  'repairs only the real viewer, confirms one native input separately, and retains failed-readiness/unknown/stop fences',
  () => {
    const helper = process.env.NIX_TEST_VIEWER_WORKSPACES;
    if (!helper)
      throw Error('Build .#leaseCli and set NIX_TEST_VIEWER_WORKSPACES to its reverie-workspaces executable');
    const root = mkdtempSync(join(tmpdir(), 'v-'));
    const web = resolve(import.meta.dirname, '..');
    const evidence = join(root, 'evidence');
    mkdirSync(evidence, { mode: 0o700 });
    const registry = mkdtempSync('/tmp/rvw-');
    const env: NodeJS.ProcessEnv = { ...process.env, REVERIE_LEASE_DIR: join(registry, 'leases') };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    delete env.VITEST_POOL_ID;
    const manage = (args: string[], timeout = 5000) =>
      execFileSync(helper, ['--root', join(registry, 'tasks'), ...args], {
        env,
        timeout,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
    try {
      const workspace = manage(['create', 'viewer']);
      manage(
        [
          'run',
          'viewer',
          process.execPath,
          join(web, 'node_modules/tsx/dist/cli.mjs'),
          join(web, 'test/fixtures/native-worker-viewer-runner.ts'),
          workspace,
          evidence,
        ],
        95_000
      );
      const result = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8'));
      expect(result.passed).toBe(true);
      expect(result.nativeInputCount).toBe(1);
      expect(result.realCommercialProviderExercised).toBe(false);
      expect(result.events.some((e: { phase: string }) => e.phase === 'readiness-failure-retained-chat')).toBe(true);
      expect(result.events.some((e: { phase: string }) => e.phase === 'unknown-and-stop-fence-preserved')).toBe(true);
      const settled = JSON.parse(readFileSync(join(evidence, 'native-settlement.json'), 'utf8'));
      expect(settled.provider_and_inner_server_settled).toBe(true);
    } catch (error) {
      let detail = '';
      for (const name of ['result.json', 'node.log', 'helper.log']) {
        try {
          detail += `\n${name}:\n${readFileSync(join(evidence, name), 'utf8')}`;
        } catch {
          /* early startup */
        }
      }
      throw new Error(`Owned native fixture failed: ${String(error)}${detail}`);
    } finally {
      // Never remove a possibly live socket tree after uncertain teardown.
      const settlement = join(evidence, 'native-settlement.json');
      if (existsSync(settlement) && JSON.parse(readFileSync(settlement, 'utf8')).provider_and_inner_server_settled) {
        manage(['finish', 'viewer', '--handoff', settlement]);
        manage(['clean', '--apply', 'viewer']);
        rmSync(registry, { recursive: true });
        rmSync(root, { recursive: true, force: true });
      } else console.error(`Retained uncertain native fixture for review: ${root} and ${registry}`);
    }
  },
  110_000
);
