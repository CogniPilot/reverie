import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './voice-ci-launch.mjs';

// This checks real Playwright argv generation, not a working browser sandbox.
test('voice browser enables the sandbox in real Playwright argv; the unsafe default is a negative control', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'voice-ci-argv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = join(root, 'chromium');
  await writeFile(recorder, '#!/bin/sh\nprintf "%s\\n" "$@" > "$VOICE_CI_ARGV_CAPTURE"\nexit 1\n', { mode: 0o755 });
  const options = chromiumLaunchOptions({ CHROMIUM_PATH: recorder });
  for (const chromiumSandbox of [true, undefined]) {
    const output = join(root, chromiumSandbox ? 'enabled.txt' : 'unsafe-default.txt');
    await assert.rejects(
      chromium.launch({
        ...options,
        chromiumSandbox,
        headless: true,
        timeout: 5000,
        env: { ...process.env, VOICE_CI_ARGV_CAPTURE: output },
      })
    );
    const argv = (await readFile(output, 'utf8')).trim().split('\n');
    assert.equal(argv.includes('--no-sandbox'), chromiumSandbox !== true);
    assert.equal(argv.includes('--disable-gpu-sandbox'), false);
  }
});
