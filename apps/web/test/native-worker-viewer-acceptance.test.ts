/** Real owned process/PTY delivery; not Docker or authenticated vendor qualification. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux')(
  'repairs only the real viewer, confirms one native input separately, and retains failed-readiness/unknown/stop fences',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'v-'));
    const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const repository = resolve(web, '../..');
    const source = existsSync(join(repository, 'python/reverie/worker.py')) ? repository : web;
    const evidence = join(root, 'evidence');
    const env = { ...process.env };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    delete env.VITEST_POOL_ID;
    try {
      execFileSync(
        'python3',
        [join(web, 'test/fixtures/native-worker-viewer-runner.py'), source, '@leased', evidence],
        {
          env,
          timeout: 110_000,
          stdio: 'pipe',
          maxBuffer: 4 * 1024 * 1024,
        }
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
      if (existsSync(settlement) && JSON.parse(readFileSync(settlement, 'utf8')).provider_and_inner_server_settled)
        rmSync(root, { recursive: true, force: true });
      else console.error(`Retained uncertain native fixture for review: ${root}`);
    }
  },
  90_000
);
