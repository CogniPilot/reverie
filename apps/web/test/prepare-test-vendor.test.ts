/** Actual source-browser preparation in an owned fixture, never a developer's vendor tree. */
import { mkdtemp, mkdir, cp, symlink, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('prepares every shipped xterm asset and repairs a predictive bundle missing its production global aliases', async () => {
  const source = resolve(import.meta.dirname, '..');
  const fixture = await mkdtemp(join(tmpdir(), 'vendor-fixture-'));
  try {
    await mkdir(join(fixture, 'scripts'));
    await cp(join(source, 'scripts/prepare-test-vendor.mjs'), join(fixture, 'scripts/prepare-test-vendor.mjs'));
    await mkdir(join(fixture, 'packages/xterm-zerolag-input'), { recursive: true });
    await cp(join(source, 'packages/xterm-zerolag-input/src'), join(fixture, 'packages/xterm-zerolag-input/src'), {
      recursive: true,
    });
    await symlink(join(source, 'node_modules'), join(fixture, 'node_modules'), 'dir');
    const prepare = () =>
      execFileSync(process.execPath, [join(fixture, 'scripts/prepare-test-vendor.mjs')], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: dirname(process.execPath) + delimiter + process.env.PATH,
          npm_config_offline: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    prepare();
    const index = await readFile(join(source, 'src/web/public/index.html'), 'utf8');
    const references = [...index.matchAll(/(?:src|href)=["'](vendor\/xterm[^"']+\.(?:js|css))["']/g)].map(
      (match) => match[1]
    );
    expect(references).toContain('vendor/xterm-predictive-echo.js');
    for (const asset of references)
      expect((await stat(join(fixture, 'src/web/public', asset))).size).toBeGreaterThan(100);
    const predictive = join(fixture, 'src/web/public/vendor/xterm-predictive-echo.js');
    const context = { window: {} as Record<string, unknown> };
    runInNewContext(await readFile(predictive, 'utf8'), context);
    expect(typeof context.window.PredictiveEchoAddon).toBe('function');
    expect(typeof context.window.PredictiveEchoOverlay).toBe('function');
    const truncated = (await readFile(predictive, 'utf8')).split('// Global aliases for browser usage')[0];
    await writeFile(predictive, truncated);
    expect(prepare()).toContain('1 built');
    expect(await readFile(predictive, 'utf8')).toContain('window.PredictiveEchoOverlay');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
