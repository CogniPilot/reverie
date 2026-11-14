/** Controlled capsule/HTTP/file fixtures only. No Engine, provider or installed native acceptance. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import Fastify, { type FastifyInstance } from 'fastify';
import { workerCallback, workerHookSettings } from '../src/worker-client-callback.js';
import {
  inspectWorkerClientFiles,
  parseWorkerClientReadback,
  workerClientDigest,
} from '../src/worker-client-manifest.js';
import {
  DockerWorkerIdentityAuthentication,
  registerDockerWorkerIdentity,
  dockerWorkerIdentityOf,
  type DockerWorkerIdentityBinding,
} from '../src/docker-worker-identity.js';

const SID = '33333333-3333-4333-8333-333333333333',
  EID = '22222222-2222-4222-8222-222222222222';
const binding: DockerWorkerIdentityBinding = {
  employeeId: EID,
  sessionId: SID,
  sessionGeneration: 1,
  owner: undefined,
  containerId: 'a'.repeat(64),
  credentialId: '44444444-4444-4444-8444-444444444444',
};
const directories: string[] = [],
  apps: FastifyInstance[] = [];
function directory(prefix: string) {
  const root = fs.mkdtempSync(join(tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  directories.push(root);
  return root;
}
function writable(path: string) {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(path, 0o700);
    for (const name of fs.readdirSync(path)) writable(join(path, name));
  } else fs.chmodSync(path, 0o600);
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of directories.splice(0)) {
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function artifact() {
  const root = directory('client-data-');
  fs.mkdirSync(join(root, 'bin'));
  const contents = {
    'bin/node': 'controlled ELF DATA, never executed',
    'bin/reverie': 'controlled static entry DATA, never executed',
    'bin/reverie.mjs': 'controlled script DATA, never executed',
    'claude-hooks.json': '{}',
  };
  for (const [name, body] of Object.entries(contents)) {
    fs.writeFileSync(join(root, name), body);
    fs.chmodSync(join(root, name), ['bin/node', 'bin/reverie'].includes(name) ? 0o555 : 0o444);
  }
  const files = Object.entries(contents)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, body]) => ({
      path,
      sha256: workerClientDigest(body),
      bytes: Buffer.byteLength(body),
      mode: ['bin/node', 'bin/reverie'].includes(path) ? 0o555 : 0o444,
    }));
  const manifest = {
    version: 1,
    purpose: 'reverie-worker-client-v1',
    entry: '/opt/reverie-worker-client/bin/reverie',
    node: '/opt/reverie-worker-client/bin/node',
    files,
  };
  const raw = JSON.stringify(manifest);
  fs.writeFileSync(join(root, 'manifest.json'), raw, { mode: 0o444 });
  fs.chmodSync(join(root, 'bin'), 0o555);
  fs.chmodSync(root, 0o555);
  return { root, manifest, raw, digest: workerClientDigest(raw) };
}
describe('canonical read-only worker capsule data', () => {
  it('observes actual canonical files and reports actual ownership without inventing an installed grant', () => {
    const tree = artifact(),
      seen = inspectWorkerClientFiles(tree.root, tree.digest);
    expect(seen.manifestDigest).toBe(tree.digest);
    expect(seen.filesChecked).toBe(4);
    expect(seen.ownerUid).toBe(process.getuid!());
    expect(seen.entrySha256).toBe(tree.manifest.files[1].sha256);
  });
  it('refuses wrong expected digest and modified bytes without changing original files', () => {
    const tree = artifact();
    expect(() => inspectWorkerClientFiles(tree.root, 'b'.repeat(64))).toThrow('manifest differs');
    const target = join(tree.root, 'bin/reverie.mjs');
    fs.chmodSync(target, 0o644);
    fs.writeFileSync(target, 'altered');
    fs.chmodSync(target, 0o444);
    expect(() => inspectWorkerClientFiles(tree.root, tree.digest)).toThrow('artifact differs');
    expect(fs.readFileSync(target, 'utf8')).toBe('altered');
  });
  it('refuses noncanonical/duplicate manifest frames and writable code directories', () => {
    const tree = artifact(),
      file = join(tree.root, 'manifest.json');
    fs.chmodSync(file, 0o644);
    const duplicate = tree.raw.replace('{"version":1', '{"version":0,"version":1');
    fs.writeFileSync(file, duplicate);
    fs.chmodSync(file, 0o444);
    expect(() => inspectWorkerClientFiles(tree.root, workerClientDigest(duplicate))).toThrow('Canonical');
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, tree.raw);
    fs.chmodSync(file, 0o444);
    fs.chmodSync(join(tree.root, 'bin'), 0o755);
    expect(() => inspectWorkerClientFiles(tree.root, tree.digest)).toThrow('directory custody');
  });
  it('refuses symlink code even when target bytes are otherwise identical', () => {
    const tree = artifact(),
      target = join(tree.root, 'bin/reverie.mjs');
    fs.chmodSync(join(tree.root, 'bin'), 0o755);
    fs.renameSync(target, target + '.saved');
    fs.symlinkSync(target + '.saved', target);
    fs.chmodSync(join(tree.root, 'bin'), 0o555);
    expect(() => inspectWorkerClientFiles(tree.root, tree.digest)).toThrow('path changed');
  });
  it('does not treat old/wrong/partial claimed readback as supported current code', () => {
    for (const raw of ['{}', '{"version":0}', '{"version":1,"purpose":"old-client"}']) {
      expect(() => parseWorkerClientReadback(raw, 'a'.repeat(64))).toThrow();
    }
    const data = {
      version: 1,
      purpose: 'reverie-worker-client-readback-v1',
      manifestDigest: 'a'.repeat(64),
      entrySha256: 'b'.repeat(64),
      filesChecked: 4,
      nodeMajor: 22,
      ownerUid: 0,
    };
    expect(parseWorkerClientReadback(JSON.stringify(data), 'a'.repeat(64))).toEqual(data);
    expect(() => parseWorkerClientReadback(JSON.stringify(data), 'c'.repeat(64))).toThrow('differs');
    expect(() => parseWorkerClientReadback(JSON.stringify({ ...data, ownerUid: 1000 }), 'a'.repeat(64))).toThrow();
  });
});
async function callbackFixture() {
  const root = directory('callback-'),
    file = join(root, 'identity');
  const authentication = new DockerWorkerIdentityAuthentication(
    '11111111-1111-4111-8111-111111111111',
    Buffer.alloc(32, 0x41),
    { binding: () => binding, keyCurrent: () => true }
  );
  const token = authentication.issue(binding, () => true);
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  const app = Fastify();
  apps.push(app);
  registerDockerWorkerIdentity(app, authentication);
  const calls: { target: string; body: unknown; generation: unknown; proof: boolean; human: boolean }[] = [];
  let lost = false;
  for (const target of ['/api/hook-event', '/api/status-telemetry'])
    app.post(target, async (req, reply) => {
      calls.push({
        target,
        body: req.body,
        generation: req.headers['x-reverie-hook-generation'],
        proof: !!dockerWorkerIdentityOf(req),
        human: req.headers.authorization !== undefined,
      });
      if (lost) {
        req.raw.socket.destroy();
        return reply;
      }
      return { success: true, data: target === '/api/status-telemetry' ? 'Synthetic model | 7%' : {} };
    });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const env: NodeJS.ProcessEnv = {
    REVERIE_MUX: '1',
    REVERIE_SESSION_ID: SID,
    REVERIE_API_URL: 'http://127.0.0.1:' + address.port,
    REVERIE_WORKER_IDENTITY_FILE: file,
    REVERIE_HOOK_GENERATION: 'actual-controlled-generation',
    REVERIE_PASSWORD: 'forbidden-human-fallback',
  };
  return {
    env,
    calls,
    file,
    loseReply: () => {
      lost = true;
    },
  };
}
describe('safe worker callback transport', () => {
  it('uses actual signed caller proof, own full SID and generation without Basic or response leakage', async () => {
    const f = await callbackFixture(),
      input = { session_id: 'original-provider-thread', sessionId: 'untrusted-nested-hint' };
    expect(await workerCallback('hook-event', 'stop', Readable.from(JSON.stringify(input)), f.env)).toBeUndefined();
    expect(f.calls).toEqual([
      {
        target: '/api/hook-event',
        body: { event: 'stop', sessionId: SID, data: input },
        generation: 'actual-controlled-generation',
        proof: true,
        human: false,
      },
    ]);
  });
  it('shares the existing null-tolerant telemetry schema and returns only bounded status text', async () => {
    const f = await callbackFixture();
    expect(
      await workerCallback(
        'status-telemetry',
        undefined,
        Readable.from('{"cost":{"total_cost_usd":null},"unknown":"discard"}'),
        f.env
      )
    ).toBe('Synthetic model | 7%');
    expect(f.calls[0]!.body).toEqual({ sessionId: SID, data: { cost: { total_cost_usd: null } } });
  });
  it('refuses malformed/oversize/wrong-event input and missing generation before dispatch', async () => {
    const f = await callbackFixture();
    for (const input of ['{', '[]', 'x'.repeat(65537)]) {
      await expect(workerCallback('hook-event', 'stop', Readable.from(input), f.env)).rejects.toThrow();
    }
    await expect(workerCallback('hook-event', 'arbitrary', Readable.from('{}'), f.env)).rejects.toThrow();
    await expect(
      workerCallback('hook-event', 'stop', Readable.from('{}'), { ...f.env, REVERIE_HOOK_GENERATION: undefined })
    ).rejects.toThrow('generation required');
    expect(f.calls).toHaveLength(0);
  });
  it('does not fall back or dispatch when selected credential custody fails', async () => {
    const f = await callbackFixture();
    fs.chmodSync(f.file, 0o644);
    await expect(workerCallback('hook-event', 'stop', Readable.from('{}'), f.env)).rejects.toThrow(
      'credential unavailable'
    );
    await expect(
      workerCallback('hook-event', 'stop', Readable.from('{}'), { ...f.env, REVERIE_WORKER_IDENTITY_FILE: undefined })
    ).rejects.toThrow('credential required');
    expect(f.calls).toHaveLength(0);
  });
  it('never retries an actual callback after a lost reply', async () => {
    const f = await callbackFixture();
    f.loseReply();
    await expect(workerCallback('hook-event', 'stop', Readable.from('{}'), f.env)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it('generates fixed explicit settings with no shell secret substitution or HOME overwrite', () => {
    const settings = workerHookSettings(),
      raw = JSON.stringify(settings);
    expect(raw).toContain('/opt/reverie-worker-client/bin/reverie worker-callback');
    expect(raw).not.toMatch(/curl|Hook-Secret|\$\(|REVERIE_PASSWORD/);
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toMatch(/--event stop$/);
    expect(settings.statusLine.command).toMatch(/worker-callback status-telemetry$/);
  });
});
let bundleRoot: string, bundle: string, legacy: string;
beforeAll(async () => {
  bundleRoot = fs.mkdtempSync(join(tmpdir(), 'client-bundle-'));
  bundle = join(bundleRoot, 'client.mjs');
  legacy = join(bundleRoot, 'old.mjs');
  const common = {
    bundle: true,
    platform: 'node' as const,
    format: 'esm' as const,
    target: 'node22',
    metafile: true,
    logLevel: 'silent' as const,
    banner: {
      js: "import {createRequire as __reverieRequire} from 'node:module'; const require=__reverieRequire(import.meta.url);",
    },
  };
  const built = await build({ ...common, entryPoints: [resolve('src/worker-client-cli.ts')], outfile: bundle });
  const external = Object.values(built.metafile!.outputs).flatMap((value) =>
    value.imports.filter((value) => value.external).map((value) => value.path)
  );
  expect(external.every((name) => name.startsWith('node:'))).toBe(true);
  await build({
    ...common,
    stdin: {
      contents:
        "import {Command} from 'commander';import {registerAgentCommands} from './src/cli-agent.ts';const program=new Command();registerAgentCommands(program);await program.parseAsync(process.argv);",
      resolveDir: process.cwd(),
    },
    outfile: legacy,
  });
}, 30000);
afterAll(() => {
  fs.rmSync(bundleRoot, { recursive: true, force: true });
});
async function child(program: string, args: string[], home: string, extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('REVERIE_')) delete env[name];
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: home + '/config',
    XDG_CACHE_HOME: home + '/cache',
    XDG_DATA_HOME: home + '/data',
    REVERIE_DATA_DIR: home + '/instance',
    ...extra,
  });
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const processChild = spawn(process.execPath, [program, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    processChild.stdout.on('data', (part) => (stdout += part));
    processChild.stderr.on('data', (part) => (stderr += part));
    const timer = setTimeout(() => processChild.kill('SIGKILL'), 10000);
    processChild.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
describe('actual standalone client bundle', () => {
  it('prints new fixed roles without reading/quarantining private registry data', async () => {
    const home = directory('bundle-home-');
    fs.mkdirSync(join(home, 'instance'));
    const registry = join(home, 'instance/clis.json');
    fs.writeFileSync(registry, 'malformed owner data', { mode: 0o600 });
    const result = await child(bundle, ['worker-client', 'hook-settings'], home);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(workerHookSettings());
    expect(fs.readFileSync(registry, 'utf8')).toBe('malformed owner data');
    expect(fs.readdirSync(join(home, 'instance'))).toEqual(['clis.json']);
  });
  it('refuses a known old bundle with no current capsule role', async () => {
    const home = directory('old-client-home-');
    const result = await child(legacy, ['worker-client', 'status', '--expected-digest', 'a'.repeat(64)], home);
    expect(result.status).not.toBe(0);
    expect(() => parseWorkerClientReadback(result.stdout, 'a'.repeat(64))).toThrow();
  });
});
