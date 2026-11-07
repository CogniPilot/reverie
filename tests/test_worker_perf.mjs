import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { imageArguments, restricted } from '../.github/ci/worker-perf.mjs';
const row = () => ({ State: { Running: true }, Config: { Labels: {
  'reverie.worker': 'fixture', 'reverie.session': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
} }, HostConfig: { Privileged: false, CapAdd: ['SETUID', 'SETGID'], SecurityOpt: ['no-new-privileges', 'seccomp=/nix/store/fixed.json'] } });
test('symlinked CLI still executes argument validation instead of reporting zero-work success', () => {
  const root = mkdtempSync(join(tmpdir(), 'reverie-perf-cli-'));
  try {
    const selected = join(root, 'driver.mjs');
    symlinkSync(fileURLToPath(new URL('../.github/ci/worker-perf.mjs', import.meta.url)), selected);
    const result = spawnSync(process.execPath, [selected, '--invalid'], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /use cargo xtask verify-worker-perf/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real local acceptance refuses privilege, stale ownership and unconfined shortcuts', () => {
  restricted(row(), 'fixture');
  for (const mutate of [
    value => { value.State.Running = false; },
    value => { value.Config.Labels['reverie.worker'] = 'foreign'; },
    value => { value.HostConfig.Privileged = true; },
    value => { value.HostConfig.PidMode = 'host'; },
    value => { value.HostConfig.CapAdd = ['CAP_PERFMON']; },
    value => { value.HostConfig.CapAdd = ['SYS_ADMIN']; },
    value => { value.HostConfig.SecurityOpt = ['seccomp=unconfined']; },
    value => { value.HostConfig.SecurityOpt = []; },
  ]) { const value = row(); mutate(value); assert.throws(() => restricted(value, 'fixture')); }
});
test('fixture image invocation cannot add privileged host overrides or execute option-like images', () => {
  assert.throws(() => imageArguments('--privileged', '/nix/store/fixed.json'));
  assert.throws(() => imageArguments('fixture', '/tmp/caller-profile.json'));
  const args = imageArguments('sha256:' + 'a'.repeat(64), '/nix/store/fixed.json');
  assert.ok(args.includes('ALL')); assert.ok(args.includes('no-new-privileges'));
  assert.ok(!args.includes('--privileged')); assert.ok(!args.includes('--cap-add'));
});
