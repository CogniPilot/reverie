import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const publisher = resolve(import.meta.dirname, '../apps/host/gpu-publisher.ts');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reverie-gpu-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'telemetry', 'gpu.json'), provider = join(root, 'nvidia-smi');
  writeFileSync(provider, '#!' + process.execPath + '\n' +
    "process.stdout.write(process.env.QUERY_OUTPUT || ''); process.exit(Number(process.env.QUERY_STATUS || 0));");
  chmodSync(provider, 0o755);
  const run = (env = {}) => spawnSync(process.execPath, ['--experimental-strip-types', publisher, '--once', '--output', output],
    { encoding: 'utf8', env: { ...process.env, NVIDIA_SMI: provider, QUERY_OUTPUT: 'RTX 3090, 27, 754, 24576', ...env } });
  return { root, output, provider, run };
}
test('host publisher writes fresh bounded multi-device telemetry atomically', t => {
  const f = fixture(t), before = Date.now();
  const result = f.run({ QUERY_OUTPUT: 'RTX 3090, 27, 754, 24576\nA100, PCIe 40GB, 90, 1000, 40000\n' });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(readFileSync(f.output));
  assert.ok(body.updatedAt >= before && body.updatedAt <= Date.now());
  assert.deepEqual(body.gpus, [
    { name: 'RTX 3090', utilization: 27, memoryUsedMb: 754, memoryTotalMb: 24576 },
    { name: 'A100, PCIe 40GB', utilization: 90, memoryUsedMb: 1000, memoryTotalMb: 40000 },
  ]);
  assert.deepEqual(readdirSync(join(f.root, 'telemetry')), ['gpu.json']);
});
test('unavailable or invalid providers remove previous readings rather than refreshing them', t => {
  const f = fixture(t);
  for (const env of [
    { QUERY_STATUS: '1' }, { NVIDIA_SMI: join(f.root, 'missing-provider') },
    { QUERY_OUTPUT: '' }, { QUERY_OUTPUT: 'RTX, 101, 5, 24' },
    { QUERY_OUTPUT: 'RTX, 20, 25, 24' }, { QUERY_OUTPUT: 'RTX, N/A, 0, 24' },
    { QUERY_OUTPUT: 'RTX, 20, Infinity, 24' }, { QUERY_OUTPUT: 'RTX, 0, 0, 0' },
  ]) {
    assert.equal(f.run().status, 0);
    const result = f.run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.output), false, JSON.stringify(env));
  }
});
test('PATH provider discovery works without any host-driver installation', t => {
  const f = fixture(t);
  const result = f.run({ NVIDIA_SMI: '', PATH: f.root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(f.output)).gpus[0].utilization, 27);
});
test('output links are replaced without writing their targets; write errors fail once mode', t => {
  const f = fixture(t), victim = join(f.root, 'victim');
  writeFileSync(victim, 'untouched'); mkdirSync(join(f.root, 'telemetry'));
  symlinkSync(victim, f.output);
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  rmSync(f.output); mkdirSync(f.output);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.deepEqual(readdirSync(join(f.root, 'telemetry')), ['gpu.json']);
});
test('parser rejects excessive rows and unsupported numeric forms', () => {
  const source = "import {parseReading} from " + JSON.stringify(pathToFileURL(publisher).href) +
    "; console.log(JSON.stringify([parseReading('RTX, 0, 0, 10'), parseReading('RTX, -1, 0, 10'), parseReading(Array(65).fill('RTX, 0, 0, 10').join('\\n'))]));";
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body, [[{ name: 'RTX', utilization: 0, memoryUsedMb: 0, memoryTotalMb: 10 }], null, null]);
});
