import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import { guestFor, imageArguments, restricted } from '../.github/ci/worker-perf.mjs';
const row = () => ({ State: { Running: true }, Config: { Labels: {
  'reverie.worker': 'fixture', 'reverie.session': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
} }, HostConfig: { Privileged: false, CapDrop: ['ALL'], CapAdd: ['SETUID', 'SETGID'], SecurityOpt: ['seccomp=/nix/store/fixed.json', 'systempaths=unconfined'] } });
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
test('canonical rootless metadata permits its systempaths exception without NNP and refuses broad privilege', () => {
  restricted(row(), 'fixture');
  for (const mutate of [
    value => { value.State.Running = false; },
    value => { value.Config.Labels['reverie.worker'] = 'foreign'; },
    value => { value.HostConfig.Privileged = true; },
    value => { value.HostConfig.PidMode = 'host'; },
    value => { value.HostConfig.CapAdd = ['CAP_PERFMON']; },
    value => { value.HostConfig.CapAdd = ['SYS_ADMIN']; },
    value => { value.HostConfig.SecurityOpt = ['seccomp=unconfined']; },
    value => { value.HostConfig.SecurityOpt = ['apparmor:unconfined']; },
  ]) { const value = row(); mutate(value); assert.throws(() => restricted(value, 'fixture')); }
});
test('generated guest checks actual kernel fields and applies NNP only to the strict image purpose', () => {
  const missing = new Error('owned perf executable sentinel');
  function execute(purpose, { nnp = 0, caps = '0', seccomp = 2 } = {}) {
    const status = `CapEff:\t${caps}\nCapPrm:\t0\nCapBnd:\t0\nSeccomp:\t${seccomp}\nNoNewPrivs:\t${nnp}\n`;
    const modules = {
      'node:assert/strict': assert,
      'node:fs': { readFileSync: () => status, mkdtempSync: () => '/owned/perf-fixture', rmSync() {} },
      'node:os': { tmpdir: () => '/owned' }, 'node:path': path,
      'node:child_process': { spawnSync: () => ({ error: missing }) },
    };
    runInNewContext(guestFor(purpose), {
      require: name => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; },
      process: { getuid: () => 2000, env: {}, execPath: '/node' },
    });
  }
  for (const purpose of ['image', 'laptop']) {
    assert.throws(() => execute(purpose, { nnp: 1 }), error => error.actual === missing);
  }
  assert.throws(() => execute('laptop'), error => error.actual === missing);
  assert.throws(() => execute('image'), /strict image fixture requires no-new-privileges/);
  assert.throws(() => execute('laptop', { caps: '1' }), /CapEff must be empty/);
  assert.throws(() => execute('laptop', { seccomp: 0 }), /seccomp filter must be active/);
});
test('fixture image invocation cannot add privileged host overrides or execute option-like images', () => {
  assert.throws(() => imageArguments('--privileged', '/nix/store/fixed.json'));
  assert.throws(() => imageArguments('fixture', '/tmp/caller-profile.json'));
  const args = imageArguments('sha256:' + 'a'.repeat(64), '/nix/store/fixed.json');
  assert.ok(args.includes('ALL')); assert.ok(args.includes('no-new-privileges'));
  assert.ok(!args.includes('--privileged')); assert.ok(!args.includes('--cap-add'));
});
