/** Owned guest/Office component acceptance. This never claims native broker job admission. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { runOwnedProcess } from './lib/owned-process.js';

const options = parseArgs({
  options: {
    image: { type: 'string' },
    'worker-exec': { type: 'string' },
    'host-tests': { type: 'string' },
    docker: { type: 'string' },
    tmux: { type: 'string' },
    output: { type: 'string' },
    'owned-root': { type: 'string' },
  },
}).values;
function required(name: keyof typeof options): string {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
const image = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .parse(required('image'));
const executable = (name: 'worker-exec' | 'host-tests' | 'docker' | 'tmux') => {
  const path = realpathSync(required(name));
  assert(lstatSync(path).isFile(), `Expected --${name} executable`);
  return path;
};
const client = executable('worker-exec'),
  hostTests = executable('host-tests'),
  docker = executable('docker'),
  tmux = executable('tmux');
assert(
  client.startsWith('/nix/store/') &&
    readFileSync(client)
      .subarray(0, 4)
      .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
  'Acceptance requires the immutable packaged native client ELF'
);
assert(
  !process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('unix:///'),
  'Only an existing local Unix Docker engine is allowed'
);
const source = fileURLToPath(import.meta.url);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const command = (program: string, args: string[], timeout = 30_000, environment = process.env, allowed = [0]) =>
  runOwnedProcess(program, args, { timeout, environment, allowed });
async function eventually(test: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await test()) return;
    await pause(20);
  }
  throw new Error(message);
}
async function main() {
  if (!options['owned-root']) return launch();
  const root = realpathSync(options['owned-root']);
  assert(basename(root).startsWith('rnh-') && lstatSync(root).isDirectory() && (lstatSync(root).mode & 0o077) === 0);
  assert.equal(await fs.readFile(join(root, '.native-hook-fixture'), 'utf8'), 'native-worker-hook-component-v1\n');
  assert.equal(process.env.REVERIE_NATIVE_HOOK_FIXTURE, '1');
  assert.equal(process.env.REVERIE_WORKER_SOCKET, join(root, 'request.sock'));
  assert.equal(process.env.REVERIE_DATA_DIR, join(root, 'company/console'));
  await exercise(root);
}
async function launch() {
  const root = await fs.mkdtemp(join(tmpdir(), 'rnh-'));
  await fs.chmod(root, 0o700);
  const socketName = 'rnh-' + randomUUID().slice(0, 12);
  let failure: unknown;
  try {
    await fs.writeFile(join(root, '.native-hook-fixture'), 'native-worker-hook-component-v1\n', { mode: 0o600 });
    for (const directory of ['home', 'provider', 'client', 'company/console', 'cases/native'])
      await fs.mkdir(join(root, directory), { recursive: true, mode: 0o700 });
    await fs.symlink(client, join(root, 'client/reverie-worker-exec'));
    await build({
      entryPoints: [resolve(dirname(source), '../test/fixtures/native-hook-provider.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: join(root, 'provider/claude'),
      banner: { js: '#!/usr/bin/env node' },
      logLevel: 'silent',
    });
    await fs.chmod(join(root, 'provider/claude'), 0o700);
    const environment: NodeJS.ProcessEnv = {
      PATH: [
        join(root, 'provider'),
        join(root, 'client'),
        dirname(process.execPath),
        dirname(tmux),
        '/run/current-system/sw/bin',
        '/usr/bin',
        '/bin',
      ].join(':'),
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'home/config'),
      XDG_STATE_HOME: join(root, 'home/state'),
      XDG_CACHE_HOME: join(root, 'home/cache'),
      XDG_DATA_HOME: join(root, 'home/data'),
      TMPDIR: root,
      REVERIE_DATA_DIR: join(root, 'company/console'),
      REVERIE_CASES_DIR: join(root, 'cases'),
      REVERIE_TMUX_SOCKET: socketName,
      REVERIE_WORKER_SOCKET: join(root, 'request.sock'),
      REVERIE_USERNAME: 'native-fixture-owner',
      REVERIE_PASSWORD: 'Synthetic-only-native!82-orbit',
      REVERIE_OWNER_SETUP: '1',
      REVERIE_NATIVE_HOOK_FIXTURE: '1',
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    };
    const args = [
      '--import',
      'tsx',
      source,
      '--image',
      image,
      '--worker-exec',
      client,
      '--host-tests',
      hostTests,
      '--docker',
      docker,
      '--tmux',
      tmux,
      '--owned-root',
      root,
      ...(options.output ? ['--output', resolve(options.output)] : []),
    ];
    const result = await command(process.execPath, args, 180_000, environment);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    failure = error;
  }
  // A failed outer owner may have escaped or unconfirmed nested owners. Never
  // race their container creation or delete their private inputs.
  if (failure)
    throw new AggregateError(
      [failure],
      `Owned fixture failed; process/container settlement is unconfirmed; private inputs retained at ${root}. ${failure instanceof Error ? failure.message : 'Unknown fixture failure'}`
    );
  try {
    await cleanupContainers(root);
    await command(tmux, ['-L', socketName, 'kill-server'], 5000, process.env, [0, 1]);
  } catch (error) {
    throw new AggregateError(
      [...(failure ? [failure] : []), error],
      `Owned fixture cleanup unconfirmed; private evidence retained at ${root}`
    );
  }
  // Remove only after successful child settlement and confirmed CID cleanup.
  await fs.rm(root, { recursive: true, force: true });
}
async function cleanupContainers(root: string) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, 'cid');
    let cid: string;
    try {
      assert((await fs.lstat(path)).isFile());
      cid = (await fs.readFile(path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    assert(/^[a-f0-9]{64}$/.test(cid), 'Invalid owned container CID file');
    const inspected = await command(docker, ['container', 'inspect', cid], 10_000, process.env, [0, 1]);
    if (inspected.code === 0) {
      const data = z
        .array(z.object({ Id: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()) }) }))
        .length(1)
        .parse(JSON.parse(inspected.stdout))[0];
      assert(
        data.Id === cid &&
          data.Config.Labels['reverie.fixture'] === 'native-hook-component-v1' &&
          data.Config.Labels['reverie.fixture.owner'] === basename(root),
        'Refusing cleanup of another container'
      );
      await command(docker, ['rm', '--force', cid], 10_000);
    }
    const remaining = await command(docker, ['ps', '--all', '--filter', 'id=' + cid, '--format', '{{.ID}}'], 10_000);
    assert.equal(remaining.stdout.trim(), '', 'Owned container removal is unconfirmed');
  }
}
const requestSchema = z
  .object({
    sessionId: z.string().uuid(),
    cwd: z.string(),
    command: z.string(),
    env: z.record(z.string(), z.string()),
    cols: z.number(),
    rows: z.number(),
    attachOnly: z.boolean().optional(),
  })
  .strict();
type Request = z.infer<typeof requestSchema>;
async function exercise(root: string) {
  // Product modules load only inside the child, after its complete environment isolation.
  const { WebServer } = await import('../src/web/server.js');
  const requests: Request[] = [],
    sockets = new Set<Socket>(),
    requestSockets = new Map<Request, Socket>(),
    requestFrames = new Map<Request, Buffer>();
  let captureFailure: Error | undefined;
  const requireCapture = () => {
    if (captureFailure) throw captureFailure;
  };
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let bytes = Buffer.alloc(0),
      received = false;
    socket.on('data', (chunk) => {
      if (received) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 5) return;
      const size = bytes.readUInt32BE(1);
      if (size > 256 * 1024) {
        socket.destroy();
        return;
      }
      if (bytes.length < size + 5) return;
      try {
        assert.equal(bytes[0], 'J'.charCodeAt(0));
        const request = requestSchema.parse(JSON.parse(bytes.subarray(5, size + 5).toString('utf8')));
        assert.equal(request.cwd, join(root, 'cases/native'));
        assert.notEqual(request.attachOnly, true);
        requests.push(request);
        requestSockets.set(request, socket);
        requestFrames.set(request, Buffer.from(bytes.subarray(5, size + 5)));
        received = true;
      } catch {
        captureFailure = new Error('Native request capture rejected an unexpected or malformed frame');
        socket.destroy();
      }
      // No success/health/provider output is synthesized. This is a request capture, not a broker.
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(join(root, 'request.sock'), resolve);
  });
  await fs.chmod(join(root, 'request.sock'), 0o600);
  const server = new WebServer(0, false, true, '127.0.0.1', 'native-hook-fixture');
  let ownerCookie = '';
  try {
    await fs.writeFile(
      join(root, 'company/console/.env'),
      'REVERIE_USERNAME=native-fixture-owner\nREVERIE_PASSWORD=Synthetic-only-native!82-orbit\n',
      { mode: 0o600 }
    );
    await server.start();
    const origin = 'http://127.0.0.1:' + server.boundPort;
    const fetchOwned = (path: string, method = 'GET', body?: unknown) =>
      fetch(origin + path, {
        method,
        headers: {
          origin,
          ...(ownerCookie ? { cookie: ownerCookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    const setup = await fetchOwned('/api/owner/setup', 'POST', {
      username: 'native-fixture-owner',
      password: 'Synthetic-only-native!82-orbit',
      confirmation: 'Synthetic-only-native!82-orbit',
    });
    assert.equal(setup.status, 200, 'Owned fresh owner setup failed');
    ownerCookie =
      setup.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('reverie_owner='))
        ?.split(';')[0] ?? '';
    assert(ownerCookie, 'Actual owner setup returned no owner cookie');
    assert.equal(
      (await fetch(origin + '/api/status')).status,
      401,
      'Fixture owner policy must actually enforce authentication'
    );
    const created = await fetchOwned('/api/sessions', 'POST', {
      workingDir: join(root, 'cases/native'),
      mode: 'claude',
      name: 'Synthetic native-hook component',
    });
    assert.equal(created.status, 200, 'Owner session construction failed');
    const sid = z
      .object({ data: z.object({ session: z.object({ id: z.string().uuid() }) }) })
      .parse(await created.json()).data.session.id;
    let preparedSettingsSha256 = hash(await fs.readFile(join(root, 'cases/native/.claude/settings.local.json')));
    const started = await fetchOwned('/api/sessions/' + sid + '/interactive', 'POST');
    assert.equal(started.status, 200, 'Owner native-wrapper launch failed');
    await eventually(() => {
      requireCapture();
      return requests.length === 1;
    }, 'Actual native worker client sent no J frame');
    let current = requests[0];
    assert(
      typeof current.env.REVERIE_HOOK_GENERATION === 'string' && current.env.REVERIE_HOOK_GENERATION.length > 0,
      'Fresh worker-backed Session supplied no private generation'
    );
    const result = await fetchOwned('/api/sessions/' + sid);
    const state = await result.text();
    assert(
      !state.includes(current.env.REVERIE_HOOK_GENERATION),
      'Private hook generation leaked into HTTP session state'
    );
    const cases: unknown[] = [];
    const invoke = async (name: string, event: string, request = current, wrongSession = false) => {
      const directory = join(root, name);
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(
        join(root, 'cases/native/.native-hook-control.json'),
        JSON.stringify({ event, wrongSession }),
        { mode: 0o600 }
      );
      const requestPath = join(directory, 'request.json');
      await fs.writeFile(requestPath, requestFrames.get(request) ?? JSON.stringify(request), { mode: 0o600 });
      const resultPath = join(directory, 'result.json'),
        input = join(directory, 'input.json');
      await fs.writeFile(
        input,
        JSON.stringify({
          image,
          docker,
          upstream: '127.0.0.1:' + server.boundPort,
          company: join(root, 'company'),
          workspace: current.cwd,
          provider: join(root, 'provider'),
          request: requestPath,
          result: resultPath,
        }),
        { mode: 0o600 }
      );
      await command(
        hostTests,
        ['--ignored', '--exact', 'office::tests::packaged_hooks::entry', '--test-threads=1', '--nocapture'],
        45_000,
        { ...process.env, REVERIE_NATIVE_HOOK_ROOT: root, REVERIE_NATIVE_HOOK_INPUT: input }
      );
      requireCapture();
      const proof = z
        .object({ scope: z.string(), image: z.string(), child: z.unknown(), providerOutput: z.string() })
        .parse(JSON.parse(await fs.readFile(resultPath, 'utf8')));
      const output = z
        .object({
          event: z.string(),
          settingsSha256: z.string(),
          executableSha256: z.string(),
          commandSha256: z.string(),
          response: z.unknown(),
        })
        .parse(JSON.parse(proof.providerOutput.trimStart().split('\n')[0]));
      assert.equal(output.settingsSha256, preparedSettingsSha256, 'Guest loaded another settings file');
      assert.equal(
        hash(await fs.readFile(join(current.cwd, '.claude/settings.local.json'))),
        preparedSettingsSha256,
        'Prepared fixture settings changed before the component completed'
      );
      assert.equal(
        output.executableSha256,
        hash(await fs.readFile(join(root, 'provider/claude'))),
        'Guest executed another provider program'
      );
      const socket = requestSockets.get(request);
      if (request === current) {
        assert(socket && !socket.destroyed, 'The current native client transport closed before guest output');
        // Only actual guest stdout reaches its original native client. No
        // composer text, provider-health evidence or accepted-job receipt is synthesized.
        const output = Buffer.from(proof.providerOutput),
          frame = Buffer.alloc(5);
        frame[0] = 'O'.charCodeAt(0);
        frame.writeUInt32BE(output.length, 1);
        await new Promise<void>((resolve, reject) =>
          socket.write(Buffer.concat([frame, output]), (error) =>
            error ? reject(new Error('Actual guest stdout could not reach its native client')) : resolve()
          )
        );
      }
      cases.push({ name, ...proof, providerOutput: output });
    };
    await invoke('current-permission', 'permission_prompt');
    const inbox = () =>
      fetchOwned('/api/approvals')
        .then((response) => response.json())
        .then(
          (value) =>
            z
              .object({
                data: z.object({
                  approvals: z.array(
                    z.object({ id: z.string(), sessionId: z.string(), answerState: z.enum(['current', 'held']) })
                  ),
                }),
              })
              .parse(value).data.approvals
        );
    const approval = (await inbox()).find((item) => item.sessionId === sid);
    assert(approval?.answerState === 'current', 'Actual current native producer did not create a current approval');
    let completed = false;
    const waiting = fetch(origin + '/api/sessions/' + sid + '/wait?until=stop&fresh=1&timeout=60000', {
      headers: { cookie: ownerCookie, origin },
      signal: AbortSignal.timeout(90_000),
    }).then(async (response) => {
      completed = true;
      return response.json();
    });
    await pause(100);
    const missing = structuredClone(current);
    delete missing.env.REVERIE_HOOK_GENERATION;
    await invoke('missing-generation', 'stop', missing);
    assert(!completed, 'Missing generation completed the actual wait');
    assert(
      (await inbox()).some((item) => item.id === approval.id),
      'Missing generation resolved current consent'
    );
    const stale = structuredClone(current);
    stale.env.REVERIE_HOOK_GENERATION = 'not-the-private-generation';
    await invoke('stale-generation', 'stop', stale);
    assert(!completed, 'Stale generation completed the actual wait');
    assert(
      (await inbox()).some((item) => item.id === approval.id),
      'Stale generation resolved current consent'
    );
    await invoke('wrong-session', 'stop', current, true);
    assert(!completed, 'Another session body passed the native Office binding');
    await invoke('current-stop', 'stop');
    const signal = z
      .object({ data: z.object({ wait: z.object({ signal: z.string().nullable() }) }) })
      .parse(await waiting);
    assert.equal(signal.data.wait.signal, 'stop');
    assert(!(await inbox()).some((item) => item.id === approval.id), 'Current native hook did not resolve consent');
    await eventually(async () => {
      const value = await (await fetchOwned('/api/sessions/' + sid)).json();
      return z.object({ data: z.object({ status: z.string() }) }).parse(value).data.status === 'idle';
    }, 'Actual guest output did not settle the original terminal before owner restart');
    const predecessor = current;
    const restarted = await fetchOwned('/api/sessions/' + sid + '/custom-model', 'POST', { clear: true });
    assert.equal(restarted.status, 200, 'Owner restart request failed');
    assert(
      z.object({ data: z.object({ restarted: z.boolean() }) }).parse(await restarted.json()).data.restarted,
      'Original owner restart was not admitted'
    );
    preparedSettingsSha256 = hash(await fs.readFile(join(root, 'cases/native/.claude/settings.local.json')));
    await eventually(() => {
      requireCapture();
      return requests.length === 2;
    }, 'Restarted native wrapper sent no new J');
    current = requests[1];
    assert(
      current.sessionId === predecessor.sessionId &&
        current.env.REVERIE_HOOK_GENERATION &&
        current.env.REVERIE_HOOK_GENERATION !== predecessor.env.REVERIE_HOOK_GENERATION,
      'Owner restart failed to replace the private provider epoch'
    );
    await invoke('successor-permission', 'permission_prompt');
    const successor = (await inbox()).find((item) => item.sessionId === sid);
    assert(successor?.answerState === 'current', 'Actual successor producer did not create current consent');
    await invoke('predecessor-generation', 'stop', predecessor);
    assert(
      (await inbox()).some((item) => item.id === successor.id),
      'The predecessor native request resolved successor consent'
    );
    await invoke('successor-stop', 'stop');
    assert(
      !(await inbox()).some((item) => item.id === successor.id),
      'Current successor hook did not resolve successor consent'
    );
    const summary = {
      scope:
        'actual worker-backed Session/private preparation, tmux/native client/request/child/settings/Office/HTTP components; ordinary native broker admission and resource replacement remain unqualified',
      image,
      clientSha256: hash(readFileSync(client)),
      hostTestBinarySha256: hash(readFileSync(hostTests)),
      acceptanceSourceSha256: hash(readFileSync(source)),
      providerSourceSha256: hash(readFileSync(resolve(dirname(source), '../test/fixtures/native-hook-provider.ts'))),
      cases,
    };
    if (options.output) await fs.writeFile(options.output, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    console.log(`Native hook component acceptance passed${cases.length} guest cases; no broker admission claim.`);
  } finally {
    const listenerClosed = new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve()))
    );
    for (const socket of sockets) socket.destroy();
    await listenerClosed;
    await server.stop();
    await command(tmux, ['-L', process.env.REVERIE_TMUX_SOCKET!, 'kill-server']).catch(() => undefined);
  }
}
void main().then(
  () => {
    // Product singleton intervals may outlive a testMode server. Only the owned
    // child terminates explicitly, after its awaited server/socket/tmux cleanup;
    // the parent still confirms container absence before removing private inputs.
    if (options['owned-root']) process.exit(0);
  },
  (error) => {
    console.error(error instanceof Error ? error.message : 'Native hook fixture failed');
    if (options['owned-root']) process.exit(1);
    process.exitCode = 1;
  }
);
