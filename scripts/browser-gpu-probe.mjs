#!/usr/bin/env node
// Tiny local workload; no browser downloads or external test pages. Node >= 22.
import { spawn, execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

export const MIN_FREE_MIB = 4096;
const GPU_UUID = /^GPU-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|software|microsoft basic/i;

export function readMemory(gpu, execute = execFileSync) {
  if (!GPU_UUID.test(gpu)) throw new Error('Select a physical GPU UUID');
  const binary = process.env.REVERIE_NVIDIA_SMI || 'nvidia-smi';
  const output = execute(binary, ['--id=' + gpu, '--query-gpu=uuid,memory.free,memory.total',
    '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 }).trim();
  const fields = output.split(',').map(value => value.trim());
  if (fields.length !== 3 || fields[0].toLowerCase() !== gpu.toLowerCase() ||
      !fields.slice(1).every(value => /^\d+$/.test(value))) throw new Error('Invalid GPU metrics');
  const freeMiB = Number(fields[1]);
  const totalMiB = Number(fields[2]);
  if (!Number.isSafeInteger(freeMiB) || !Number.isSafeInteger(totalMiB) ||
      totalMiB < MIN_FREE_MIB || freeMiB > totalMiB) throw new Error('Invalid GPU memory range');
  return { freeMiB, totalMiB };
}

export function hardwareVerdict(result) {
  const gl = result?.webgl;
  const gpu = result?.webgpu;
  const renderer = String(gl?.renderer || '');
  const adapter = [gpu?.vendor, gpu?.architecture, gpu?.device, gpu?.description].filter(Boolean).join(' ');
  return Boolean(gl?.pixelOK && gpu?.computeOK && gpu?.fallback === false &&
    /nvidia/i.test(renderer) && /nvidia|0x10de/i.test(adapter) &&
    !SOFTWARE.test(renderer) && !SOFTWARE.test(adapter));
}

// Runs in the page. Deliberately tiny: one pixel and four uint32 compute values.
async function pageProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) throw new Error('WebGL context unavailable');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  gl.clearColor(0.25, 0.5, 0.75, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const pixel = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const webgl = { renderer, pixel: [...pixel], pixelOK: [64, 128, 191, 255].every((n, i) => Math.abs(n - pixel[i]) <= 1) };
  if (!navigator.gpu) return { webgl, webgpu: { error: 'WebGPU unavailable' } };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: false });
  if (!adapter) return { webgl, webgpu: { error: 'WebGPU adapter unavailable' } };
  const info = adapter.info || await adapter.requestAdapterInfo();
  const device = await adapter.requestDevice();
  try {
    const storage = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const shader = device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> out: array<u32>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) i: vec3<u32>) { out[i.x] = i.x * 3u + 7u; }' });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = [...new Uint32Array(readback.getMappedRange())];
    readback.unmap();
    // Keep a tiny hardware job active throughout the concurrent inference probe.
    // The host asks us to stop; the local deadline also bounds a lost connection.
    if (window.__reverieGPUReady) {
      window.__reverieGPUReady('ready');
      const deadline = performance.now() + 11000;
      while (!window.__reverieGPUStop && performance.now() < deadline) {
        const repeat = device.createCommandEncoder();
        const compute = repeat.beginComputePass();
        compute.setPipeline(pipeline); compute.setBindGroup(0, bind); compute.dispatchWorkgroups(1); compute.end();
        device.queue.submit([repeat.finish()]);
        await device.queue.onSubmittedWorkDone();
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return { webgl, webgpu: { vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, fallback: info.isFallbackAdapter ?? adapter.isFallbackAdapter,
      values, computeOK: values.every((n, i) => n === i * 3 + 7) } };
  } finally { device.destroy(); }
}

async function browserProbe(browser, taskRoot, during) {
  const profile = await mkdtemp(join(taskRoot, 'chromium-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Reverie GPU probe</title>');
  });
  let child, ws, timer;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    child = spawn(browser, ['--headless', '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan',
      '--disable-vulkan-surface', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const endpoint = await new Promise((resolveEndpoint, reject) => {
      timer = setTimeout(() => reject(new Error('Chromium startup timed out; check its namespace sandbox and CDI driver paths')), 15000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Chromium exited before DevTools readiness: ' + code + '; ' + stderr.slice(-2000))));
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-8192);
        const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/);
        if (match) resolveEndpoint(match[1]);
      });
    });
    clearTimeout(timer);
    ws = new WebSocket(endpoint);
    await Promise.race([once(ws, 'open'), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('DevTools connection timed out')), 5000);
    })]);
    clearTimeout(timer);
    const pending = new Map();
    const events = new Map();
    let id = 0;
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
      const eventKey = message.sessionId + ':' + message.method;
      if (events.has(eventKey)) { events.get(eventKey)(message.params); events.delete(eventKey); }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
      pending.set(++id, { resolve: resolveCall, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const workload = (async () => {
      const version = await send('Browser.getVersion');
      const system = await send('SystemInfo.getInfo');
      const target = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      // Evaluate against a known secure localhost page after navigation completes.
      await send('Page.enable', {}, sessionId);
      const loaded = new Promise(resolveLoad => events.set(sessionId + ':Page.loadEventFired', resolveLoad));
      await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` }, sessionId);
      await loaded;
      await send('Runtime.addBinding', { name: '__reverieGPUReady' }, sessionId);
      const gpuReady = new Promise(resolveReady => events.set(sessionId + ':Runtime.bindingCalled', resolveReady));
      const evaluation = send('Runtime.evaluate', { expression: '(' + pageProbe.toString() + ')()', awaitPromise: true, returnByValue: true }, sessionId);
      const ready = await Promise.race([gpuReady.then(() => true), evaluation.then(() => false)]);
      let modelDuring = { status: 'unverified' };
      if (ready) {
        modelDuring = await during();
        await send('Runtime.evaluate', { expression: 'window.__reverieGPUStop = true' }, sessionId);
      }
      const evaluated = await evaluation;
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || 'Browser workload failed');
      return { browser: version.product, gpuDevices: system.gpu.devices, gpuFeatures: system.gpu.featureStatus,
        ...evaluated.result.value, modelDuring };
    })();
    return await Promise.race([workload, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('GPU probe exceeded 30 seconds')), 30000);
    })]);
  } finally {
    clearTimeout(timer);
    ws?.close();
    if (child?.pid && child.exitCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await once(child, 'exit').catch(() => {});
      clearTimeout(killTimer);
    }
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(profile, { recursive: true, force: true });
  }
}

async function modelProbe(options) {
  if (!options.modelUrl) return { status: 'unverified' };
  const started = performance.now();
  try {
    const url = new URL(options.modelUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model URL');
    const token = options.modelKeyEnv ? process.env[options.modelKeyEnv] : '';
    if (options.modelKeyEnv && !token) throw new Error('Model API key environment variable is empty');
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ model: options.modelId, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, temperature: 0 }) });
    const body = await response.json();
    const latencyMs = Math.round(performance.now() - started);
    return { status: response.ok && body.choices?.[0] && latencyMs <= options.modelMaxLatencyMs ? 'pass' : 'fail', latencyMs };
  } catch { return { status: 'fail', latencyMs: Math.round(performance.now() - started) }; }
}

export async function runProbe(options, dependencies = {}) {
  const metrics = dependencies.metrics || readMemory;
  const browser = dependencies.browser || browserProbe;
  const model = dependencies.model || modelProbe;
  const report = { requester: options.requester, time: new Date().toISOString(), selectedDevice: options.gpu,
    result: 'skip', before: null, after: null, modelBefore: { status: 'unverified' }, modelAfter: { status: 'unverified' } };
  try {
    report.before = metrics(options.gpu);
    if (report.before.freeMiB < MIN_FREE_MIB) { report.reason = 'Less than 4096 MiB free VRAM'; return report; }
  } catch { report.reason = 'GPU metrics unavailable or invalid'; return report; }
  try {
    report.modelBefore = await model(options);
    if (report.modelBefore.status === 'fail') { report.reason = 'Model baseline failed; browser was not started'; return report; }
    // The inference preflight may have allocated VRAM; recheck immediately before launch.
    const fresh = metrics(options.gpu);
    if (fresh.freeMiB < MIN_FREE_MIB) { report.reason = 'Less than 4096 MiB free VRAM after model preflight'; return report; }
    report.before = fresh;
    report.graphics = await browser(options.browser, options.taskRoot, () => model(options));
    report.hardware = hardwareVerdict(report.graphics);
    report.modelAfter = await model(options);
    report.coexistence = Boolean(options.modelUrl) &&
      [report.modelBefore, report.graphics.modelDuring, report.modelAfter].every(probe => probe?.status === 'pass');
    report.result = !report.hardware ? 'fail' : !options.modelUrl ? 'hardware-pass' : report.coexistence ? 'pass' : 'fail';
  } catch (error) { report.result = 'fail'; report.reason = error.message; }
  finally { try { report.after = metrics(options.gpu); } catch { /* unavailable is explicit null */ } }
  return report;
}

async function main() {
  const values = {};
  const allowed = new Set(['gpu', 'requester', 'report', 'browser', 'task-root', 'model-url', 'model-id', 'model-key-env', 'model-max-latency-ms']);
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, '');
    if (!allowed.has(key) || !process.argv[i + 1] || values[key]) throw new Error('Use --gpu GPU-UUID --requester NAME --report PATH [--browser chromium] [--model-url CHAT_COMPLETIONS_URL --model-id ID --model-max-latency-ms N]');
    values[key] = process.argv[i + 1];
  }
  if (!GPU_UUID.test(values.gpu || '') || !values.requester || !values.report) throw new Error('Explicit --gpu, --requester and --report are required');
  if (Boolean(values['model-url']) !== Boolean(values['model-id']) || (values['model-url'] && !/^\d+$/.test(values['model-max-latency-ms'] || ''))) throw new Error('Model verification requires URL, ID and an agreed latency bound');
  const taskRoot = values['task-root'] || join(process.env.REVERIE_WORKER === '1' ? '/scratch' : join(homedir(), 'scratch/reverie'), 'tmp/browser-gpu');
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  const options = { gpu: values.gpu, requester: values.requester, browser: values.browser || 'chromium', taskRoot,
    modelUrl: values['model-url'], modelId: values['model-id'], modelKeyEnv: values['model-key-env'], modelMaxLatencyMs: Number(values['model-max-latency-ms']) };
  const report = await runProbe(options);
  await mkdir(dirname(resolve(values.report)), { recursive: true, mode: 0o700 });
  await appendFile(values.report, JSON.stringify(report) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  process.exitCode = report.result === 'pass' || report.result === 'hardware-pass' ? 0 : report.result === 'skip' ? 77 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
