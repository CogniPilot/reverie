/** Shared proof/auth for real browsers against labelled disposable canaries only. */
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { loadCanaryFixtureContract } from './boxed-canary-fixture-contract.mjs';

export const CANARY_SID = '22222222-2222-4222-8222-222222222222';
export const CANARY_EID = '11111111-1111-4111-8111-111111111111';
export const CANARY_OPERATION = '85c5b805-0b16-46e7-8fee-8870c9e39fcc';
export const CANARY_THREAD = '44444444-4444-4444-8444-444444444444';
const CANARY_MAX_MODULES = 20;
const stamp = (value) =>
  [value.dev, value.ino, value.uid, value.gid, value.mode, value.nlink, value.size, value.mtimeMs, value.ctimeMs].join(
    ':'
  );
export function inspectCanaryContainer(cid) {
  assert(/^[a-f0-9]{64}$/.test(cid));
  const rows = JSON.parse(
    execFileSync('docker', ['inspect', cid], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })
  );
  assert(rows.length === 1 && rows[0].Id === cid);
  return rows[0];
}
export async function readPrivateCanaryJson(file, uid = process.getuid()) {
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    assert(before.isFile() && before.uid === uid && (before.mode & 0o777) === 0o600 && before.nlink === 1);
    assert(before.size > 0 && before.size <= 65536 && stamp(before) === stamp(await fs.lstat(file)));
    const buffer = Buffer.alloc(65537);
    let count = 0;
    for (;;) {
      const r = await fd.read(buffer, count, buffer.length - count, count);
      count += r.bytesRead;
      if (!r.bytesRead || count === buffer.length) break;
    }
    assert(
      count === before.size && stamp(before) === stamp(await fd.stat()) && stamp(before) === stamp(await fs.lstat(file))
    );
    const bytes = buffer.subarray(0, count),
      raw = bytes.toString('utf8');
    assert(Buffer.from(raw).equals(bytes));
    try {
      return JSON.parse(raw);
    } catch {
      throw Error('Private canary JSON refused');
    }
  } finally {
    await fd.close();
  }
}
export function verifyCanaryControl(canary) {
  const { proof, endpoint } = canary,
    control = inspectCanaryContainer(proof.cid);
  assert(control.Image === proof.image && control.State.Running === true);
  assert(control.Config.Labels['org.reverie.fixture'] === 'boxed-provider-canary-v1');
  assert(control.Config.Labels['org.reverie.fixture.role'] === 'control');
  assert(control.Config.Labels['org.reverie.fixture.instance'] === proof.labels['org.reverie.fixture.instance']);
  for (const [name, value] of Object.entries(proof.labels)) assert(control.Config.Labels[name] === value);
  assert(
    control.NetworkSettings.Ports['3000/tcp'].some((p) => p.HostIp === '127.0.0.1' && p.HostPort === endpoint.port)
  );
  assert(control.Mounts.some((m) => m.Source === proof.dataDirectory && m.RW === true));
  verifyCanaryModuleMounts(control, proof);
  return control;
}
/** Checks data only; the public verifier supplies a freshly inspected actual control. */
export function verifyCanaryModuleMounts(control, proof) {
  assert(!(proof.overlay && proof.modules), 'Ambiguous development module descriptors');
  let modules = [];
  if (proof.overlay) modules = [{ ...proof.overlay, generatedFile: proof.overlay.source }];
  if (proof.modules) {
    assert(Array.isArray(proof.modules) && proof.modules.length > 0 && proof.modules.length <= CANARY_MAX_MODULES);
    modules = proof.modules;
  }
  const actual = control.Mounts.filter((m) =>
    /(?:\/lib\/reverie\/dist(?:\/|$)|\/lib\/reverie\/src\/web\/public\/app\.js$)/.test(m.Destination)
  );
  assert(actual.length === modules.length, 'Undescribed development code mount');
  const targets = new Set();
  for (const module of modules) {
    assert(typeof module.generatedFile === 'string' && module.generatedFile.startsWith('/'));
    assert(typeof module.target === 'string' && module.target.startsWith('/nix/store/'));
    assert(!targets.has(module.target), 'Duplicate development module target');
    targets.add(module.target);
    assert(/^[a-f0-9]{64}$/.test(module.sha256) && module.readOnly === true);
    if (proof.modules) assert(module.inContainerSha === module.sha256, 'Recorded in-container hash differs');
    const mount = actual.filter((m) => m.Destination === module.target);
    assert(mount.length === 1 && mount[0].Source === module.generatedFile && mount[0].RW === false);
    const bytes = readFileSync(module.generatedFile);
    assert(bytes.length <= 1024 * 1024 && createHash('sha256').update(bytes).digest('hex') === module.sha256);
  }
}
/** Ordinary fixture navigation; never opens a global API or creates a room. */
export async function selectCanaryDebugChannel(page) {
  const company = page.getByRole('navigation', { name: 'Workspaces', exact: true }).locator('[data-key="ws:"]');
  assert((await company.count()) === 1, 'Exactly one default company workspace required');
  await company.click({ timeout: 10000 });
  const room = page.getByRole('button', { name: /^Channel Boxed terminal canary(?:,.*)?$/ });
  assert((await room.count()) === 1, 'Exactly one prepared fixture channel required');
  await room.click({ timeout: 10000 });
}
async function readCanaryBody(response, maximum) {
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw Error('Canary response bound exceeded');
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}
/** Actual decoded HTTP bytes must match the fixture's mounted source and both compressed forms. */
export async function verifyCanaryServedGui(page, canary) {
  const sources = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src')));
  const scripts = sources.map((source) => new URL(source, canary.endpoint));
  const matches = scripts.filter((url) => /^\/app\.[a-f0-9]{8,64}\.js$/.test(url.pathname));
  assert(matches.length === 1, 'Exactly one hashed app script required');
  const url = matches[0];
  assert(url.origin === canary.endpoint.origin && !url.hash, 'Same-origin app script required');
  const modules = canary.proof.modules;
  assert(Array.isArray(modules) && modules.length <= CANARY_MAX_MODULES);
  const selected = modules.filter(
    (module) =>
      module.source === 'apps/web/src/web/public/app.js' &&
      module.target.endsWith('/lib/reverie/dist/web/public' + url.pathname)
  );
  assert(selected.length === 1, 'Actual served app overlay descriptor required');
  const app = selected[0],
    maximum = 1024 * 1024;
  assert(!url.search || url.search === '?v=' + app.sha256.slice(0, 16), 'Exact app content cache buster required');
  const bytes = (module) => {
    assert(module.readOnly === true && /^[a-f0-9]{64}$/.test(module.sha256) && module.inContainerSha === module.sha256);
    const raw = readFileSync(module.generatedFile);
    assert(raw.length <= maximum && createHash('sha256').update(raw).digest('hex') === module.sha256);
    return raw;
  };
  const expected = bytes(app);
  for (const [suffix, decompress] of [
    ['.br', brotliDecompressSync],
    ['.gz', gunzipSync],
  ]) {
    const compressed = modules.filter((module) => module.target === app.target + suffix);
    assert(compressed.length === 1, 'Both exact compressed app overlays required');
    const decoded = decompress(bytes(compressed[0]), { maxOutputLength: maximum });
    assert(decoded.equals(expected), 'Compressed app differs from source');
  }
  const response = await globalThis.fetch(url, {
    headers: { cookie: canary.cookie, 'accept-encoding': 'br, gzip, deflate' },
    redirect: 'manual',
    signal: globalThis.AbortSignal.timeout(10000),
  });
  assert(response.status === 200, 'Actual app response refused');
  const body = await readCanaryBody(response, maximum);
  assert(
    createHash('sha256').update(body).digest('hex') === app.sha256,
    'Actual served app bytes differ from mounted source'
  );
  return { path: url.pathname, sha256: app.sha256, encoding: response.headers.get('content-encoding') || 'identity' };
}
export async function canaryGet(canary, path) {
  assert(path.startsWith('/api/') && !path.includes('://'));
  const response = await globalThis.fetch(new URL(path, canary.endpoint), {
    headers: { cookie: canary.cookie },
    redirect: 'manual',
    signal: globalThis.AbortSignal.timeout(10000),
  });
  assert(response.status === 200);
  const result = JSON.parse((await readCanaryBody(response, 65536)).toString('utf8'));
  assert(result.success === true);
  return result.data;
}
export function validCanaryCookieName(name) {
  return (
    ['owner-session.json', 'owner-session-after-control1.json'].includes(name) ||
    /^owner-session-control-[a-f0-9]{64}\.json$/.test(name)
  );
}
export async function loadVerifiedCanaryOwner(proofFile, sessionName = 'owner-session.json', contractFile) {
  const fixture = loadCanaryFixtureContract(contractFile);
  assert(resolve(proofFile) === proofFile);
  assert(validCanaryCookieName(sessionName));
  assert((await fs.stat(proofFile)).size <= 65536);
  const proof = JSON.parse(await fs.readFile(proofFile, 'utf8')),
    endpoint = new URL(proof.endpoint);
  assert(
    endpoint.hostname === '127.0.0.1' &&
      endpoint.protocol === 'http:' &&
      endpoint.port &&
      endpoint.port !== '3000' &&
      endpoint.pathname === '/' &&
      !endpoint.search &&
      !endpoint.hash &&
      !endpoint.username &&
      !endpoint.password
  );
  const directory = await fs.lstat(proof.authDirectory);
  assert(directory.isDirectory() && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700);
  assert((await fs.realpath(proof.authDirectory)) === proof.authDirectory);
  const canary = { proof, endpoint, fixture };
  verifyCanaryControl(canary);
  const { cookie } = await readPrivateCanaryJson(join(proof.authDirectory, sessionName));
  assert(typeof cookie === 'string' && /^reverie_owner=[^;\r\n]+$/.test(cookie));
  canary.cookie = cookie;
  const owner = await canaryGet(canary, '/api/owner/status');
  assert(
    owner.configured === true &&
      owner.signedIn === true &&
      owner.policy === 'enforce' &&
      owner.mustChange === false &&
      owner.identity?.role === 'owner' &&
      owner.identity?.primary === true
  );
  return canary;
}
export async function applyVerifiedOwnerCookie(context, canary) {
  await context.addCookies([
    {
      name: 'reverie_owner',
      value: canary.cookie.slice('reverie_owner='.length),
      url: canary.endpoint.origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}
