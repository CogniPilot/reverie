import assert from 'node:assert/strict';
import test from 'node:test';
import { hardwareVerdict, readMemory, runProbe } from '../scripts/browser-gpu-probe.mjs';

const gpu = 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const hardware = { webgl: { renderer: 'ANGLE (NVIDIA, NVIDIA RTX 3090, Vulkan)', pixelOK: true },
  webgpu: { vendor: 'nvidia', description: 'RTX 3090', computeOK: true, fallback: false }, modelDuring: { status: 'pass' } };
const options = { gpu, requester: 'synthetic-test', browser: 'unused', taskRoot: 'unused' };

test('requires NVIDIA identity and checked WebGL/WebGPU output, rejects software fallbacks', () => {
  assert.equal(hardwareVerdict(hardware), true);
  for (const renderer of ['ANGLE (Google, SwiftShader)', 'llvmpipe', 'NVIDIA SwiftShader', 'Mesa Intel UHD']) {
    assert.equal(hardwareVerdict({ ...hardware, webgl: { ...hardware.webgl, renderer } }), false);
  }
  for (const change of [{ computeOK: false }, { fallback: true }, { fallback: undefined }, { vendor: 'google', description: 'SwiftShader' }]) {
    assert.equal(hardwareVerdict({ ...hardware, webgpu: { ...hardware.webgpu, ...change } }), false);
  }
  assert.equal(hardwareVerdict({ ...hardware, webgl: { ...hardware.webgl, pixelOK: false } }), false);
});

test('GPU metric parsing rejects another GPU, malformed or impossible values', () => {
  assert.deepEqual(readMemory(gpu, () => `${gpu}, 4096, 24576\n`), { freeMiB: 4096, totalMiB: 24576 });
  for (const value of [`${gpu}, N/A, 24576`, `${gpu}, -1, 24576`, `${gpu}, 24577, 24576`,
    `GPU-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee, 4096, 24576`, `${gpu}, 4096, 24576\n${gpu}, 4096, 24576`]) {
    assert.throws(() => readMemory(gpu, () => value));
  }
});

test('low or unavailable VRAM skips without starting browser or inference', async () => {
  const forbidden = () => { throw new Error('Must not start'); };
  for (const metrics of [() => ({ freeMiB: 4095, totalMiB: 24576 }), () => { throw new Error('No metrics'); }]) {
    const result = await runProbe(options, { metrics, browser: forbidden, model: forbidden });
    assert.equal(result.result, 'skip');
    assert.equal(result.modelBefore.status, 'unverified');
  }
});

test('rechecks VRAM after model preflight before starting browser', async () => {
  let reads = 0, launches = 0;
  const report = await runProbe(options, { metrics: () => ({ freeMiB: ++reads === 1 ? 5000 : 4000 }),
    model: async () => ({ status: 'pass' }), browser: () => { launches++; } });
  assert.equal(report.result, 'skip');
  assert.equal(launches, 0);
});

test('hardware-only verification never claims model coexistence acceptance', async () => {
  const report = await runProbe(options, { metrics: () => ({ freeMiB: 5000, totalMiB: 24576 }),
    model: async () => ({ status: 'unverified' }), browser: async () => hardware });
  assert.equal(report.result, 'hardware-pass');
  assert.equal(report.coexistence, false);
  assert.equal(report.after.freeMiB, 5000);
});

test('model failure prevents launch, and software rendering fails acceptance', async () => {
  let launches = 0;
  const dependencies = { metrics: () => ({ freeMiB: 5000, totalMiB: 24576 }), model: async () => ({ status: 'fail' }),
    browser: async () => { launches++; return hardware; } };
  assert.equal((await runProbe(options, dependencies)).result, 'skip');
  assert.equal(launches, 0);
  dependencies.model = async () => ({ status: 'pass' });
  dependencies.browser = async () => ({ ...hardware, webgpu: { ...hardware.webgpu, fallback: true } });
  assert.equal((await runProbe(options, dependencies)).result, 'fail');
});

test('requested coexistence must pass every model probe to return success', async () => {
  const requested = { ...options, modelUrl: 'http://synthetic.invalid/v1/chat/completions' };
  const dependencies = { metrics: () => ({ freeMiB: 5000, totalMiB: 24576 }),
    model: async () => ({ status: 'pass' }), browser: async () => hardware };
  assert.equal((await runProbe(requested, dependencies)).result, 'pass');
  dependencies.browser = async () => ({ ...hardware, modelDuring: { status: 'fail' } });
  const failed = await runProbe(requested, dependencies);
  assert.equal(failed.hardware, true);
  assert.equal(failed.coexistence, false);
  assert.equal(failed.result, 'fail');
});
