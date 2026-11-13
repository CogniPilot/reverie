/** Disposable Docker acceptance for native attachment ownership. No instance mounts or providers. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, realpathSync, statSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { receipt, validateCapability, ViewerAttachmentOwner, type OwnerBirth } from './operator-viewer-owner.js';
import { dockerContextArguments, pinnedUnixDocker } from './lib/pinned-unix-docker.js';
import { runOwnedProcess } from './lib/owned-process.js';

export function immutableViewerImage(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error('Explicit built immutable worker image required; never pulling');
  return value;
}
export function immutableViewerBridge(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value)
    throw new Error('Explicit absolute immutable packaged viewer executable required');
  const program = realpathSync(value);
  if (!/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+\/bin\/reverie-operator-viewer-bridge$/.test(program))
    throw new Error('Immutable packaged viewer executable required; no source fallback');
  const info = statSync(program);
  if (!info.isFile() || (info.mode & 0o111) === 0 || (info.mode & 0o222) !== 0)
    throw new Error('Immutable packaged viewer must be a read-only executable file');
  return program;
}
const inspection = z
  .array(
    z.object({
      Id: z.string().regex(/^[a-f0-9]{64}$/),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      State: z.object({ Running: z.literal(true), StartedAt: z.string(), Pid: z.number().int().positive() }),
    })
  )
  .length(1);
const inspected = (text: string) => inspection.parse(JSON.parse(text))[0]!;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await pause(20);
  }
  throw new Error(message);
}
function frame(kind: string, value: string): Buffer {
  const bytes = Buffer.from(value),
    header = Buffer.alloc(5);
  header[0] = kind.charCodeAt(0);
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
async function settled(child: ChildProcessWithoutNullStreams, timeout = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const closed = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off('close', closed);
      reject(new Error('Owned process termination unconfirmed'));
    }, timeout);
    child.once('close', closed);
  });
}
async function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  await settled(child);
  assert.equal(child.exitCode, 0, 'Owned helper failed');
}
export async function exercise(imageInput: string, dockerInput: string, output: string, bridgeInput: string): Promise<void> {
  const bridge = immutableViewerBridge(bridgeInput);
  const image = immutableViewerImage(imageInput),
    docker = realpathSync(dockerInput);
  const selectionEnvironment = { ...process.env };
  const query = dockerContextArguments(selectionEnvironment);
  const context = query
    ? (await runOwnedProcess(docker, query, { timeout: 5000, environment: selectionEnvironment })).stdout
    : '';
  const engine = pinnedUnixDocker(selectionEnvironment, (args) => {
    assert.deepEqual(args, query);
    return context;
  });
  const uid = process.getuid!(),
    gid = process.getgid!(),
    sid = randomUUID(),
    token = randomBytes(16).toString('hex');
  const root = await fs.mkdtemp(join(tmpdir(), 'nvc-'));
  await fs.chmod(root, 0o700);
  const socket = join(root, 'view.sock');
  let cid: string | undefined,
    helper: ChildProcessWithoutNullStreams | undefined,
    orphaned: ChildProcessWithoutNullStreams | undefined,
    peer: Socket | undefined;
  const command = (args: string[]) =>
    runOwnedProcess(docker, engine.args(args), {
      timeout: 20_000,
      outputLimit: 128 * 1024,
      environment: engine.environment,
    });
  const run = async (args: string[]) => (await command(args)).stdout;
  const tmux = (args: string[]) => run(['exec', cid!, '/bin/tmux', '-N', '-u', '-L', 'reverie-laptop', ...args]);
  const pane = () =>
    tmux(['display-message', '-p', '-t', '=office:', '#{session_id}|#{pane_id}|#{pane_pid}|#{pane_dead}']);
  const clients = () => tmux(['list-clients', '-F', '#{client_pid}']);
  let stderr = '',
    helperOutput = '';
  const decoder = new StringDecoder('utf8');
  try {
    const selected = JSON.parse(await run(['image', 'inspect', image]));
    assert.equal(selected[0]?.Id, image);
    cid = (
      await run([
        'create',
        '--pull=never',
        '--name',
        `reverie-agent-${sid}`,
        '--label',
        `reverie.viewer-fixture=${token}`,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        '256m',
        '--user',
        `${uid}:${gid}`,
        '--tmpfs',
        `/home/agent:rw,uid=${uid},gid=${gid},mode=0700`,
        '--tmpfs',
        '/tmp:rw,mode=1777',
        '--workdir',
        '/home/agent',
        '--entrypoint',
        '/bin/sleep',
        image,
        'infinity',
      ])
    ).trim();
    assert(/^[a-f0-9]{64}$/.test(cid));
    await run(['start', cid]);
    const before = inspected(await run(['inspect', cid]));
    await run([
      'exec',
      cid,
      '/bin/tmux',
      '-u',
      '-L',
      'reverie-laptop',
      'new-session',
      '-d',
      '-s',
      'office',
      '/bin/cat',
    ]);
    const original = await pane();
    assert(original.trim().endsWith('|0'));
    const originalCid = cid;
    validateCapability(await run(['exec', cid, '/bin/reverie-worker-child', 'viewer-v1', 'capabilities']));
    // Reproduce the original leak using only this fixture's directly owned
    // Docker client. Its remote owner must survive and close its exact child.
    const directNonce = randomBytes(16).toString('hex');
    const originalCurrent = async () => {
      const current = inspected(await run(['inspect', originalCid]));
      assert.equal(current.Id, originalCid);
      assert.equal(current.State.StartedAt, before.State.StartedAt);
      assert.equal(current.State.Pid, before.State.Pid);
    };
    const nativeControl = async (action: string, birth?: OwnerBirth) => {
      await originalCurrent();
      return run([
        'exec',
        originalCid,
        '/bin/reverie-worker-child',
        'viewer-v1',
        action,
        '--nonce',
        directNonce,
        ...(birth
          ? [
              '--owner-pid',
              String(birth.pid),
              '--start',
              birth.start,
              '--boot',
              birth.boot,
              '--namespace',
              birth.namespace,
            ]
          : []),
      ]);
    };
    let closes = 0,
      releases = 0,
      statuses = 0,
      exitReads = 0;
    const directOwner = new ViewerAttachmentOwner(directNonce, {
      close: async () => {
        closes++;
        await nativeControl('close');
        throw new Error('fixture discarded actual CLOSED reply');
      },
      status: async () => {
        statuses++;
        return nativeControl('status');
      },
      release: async () => {
        releases++;
        await nativeControl('release');
        throw new Error('fixture discarded actual RELEASED reply');
      },
      exited: async (birth) => {
        exitReads++;
        return nativeControl('exited', birth);
      },
      assertOriginalContainer: originalCurrent,
      clients,
      localExit: async () =>
        eventually(
          async () => !!orphaned && (orphaned.exitCode !== null || orphaned.signalCode !== null),
          'Original fixture Docker client settlement missing'
        ),
    });
    directOwner.start(() => {
      orphaned = spawn(
        docker,
        engine.args([
          'exec',
          '-i',
          originalCid,
          '/bin/reverie-worker-child',
          'viewer-v1',
          'attach',
          '--nonce',
          directNonce,
          '--cols',
          '80',
          '--rows',
          '24',
        ]),
        { stdio: ['pipe', 'pipe', 'pipe'], env: engine.environment }
      );
    });
    assert(orphaned);
    let greeting = '';
    orphaned.stdout.on('data', (data) => {
      if (greeting.length < 4096) greeting += String(data);
    });
    orphaned.stderr.on('data', () => {});
    await eventually(async () => greeting.includes('\n'), 'Native owner did not report its original child');
    const originalClient = receipt('READY', directNonce, greeting.slice(0, greeting.indexOf('\n') + 1));
    await eventually(
      async () => (await clients()).trim() === String(originalClient),
      'Original owned client not observed'
    );
    directOwner.ready(greeting.slice(0, greeting.indexOf('\n') + 1), await clients());
    const deadClient = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned Docker client did not terminate')), 5000);
      orphaned!.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    orphaned.kill('SIGKILL');
    await deadClient;
    await assert.rejects(directOwner.close(), /unconfirmed/);
    // A same-owner STATUS recovers actual CLOSED, then its real release ACK is
    // deliberately discarded. Neither physical command may be replayed.
    await assert.rejects(directOwner.reconcile(), /unconfirmed/);
    await directOwner.reconcile();
    assert(directOwner.closed);
    assert.equal(directOwner.endpointCleanup, 'unconfirmed');
    assert.equal(closes, 1);
    assert.equal(releases, 1);
    assert.equal(statuses, 1);
    assert.equal(exitReads, 1);
    assert.equal((await clients()).trim(), '');
    assert.equal(await pane(), original);
    helper = spawn(
      bridge,
      [
        '--session-id',
        sid,
        '--container-id',
        cid,
        '--started-at',
        before.State.StartedAt,
        '--pid',
        String(before.State.Pid),
        '--socket',
        socket,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...engine.environment, PATH: dirname(docker) + ':' + process.env.PATH },
      }
    );
    helper.stdout.on('data', (data) => {
      helperOutput = (helperOutput + String(data)).slice(-8192);
    });
    helper.stderr.on('data', (data) => {
      stderr = (stderr + String(data)).slice(-4096);
    });
    await eventually(
      async () =>
        fs.lstat(socket).then(
          (info) => info.isSocket(),
          () => false
        ),
      'Owned helper endpoint unavailable'
    );
    for (let pass = 0; pass < 2; pass++) {
      peer = createConnection(socket);
      let outputText = '',
        buffer = Buffer.alloc(0);
      peer.on('data', (bytes) => {
        buffer = Buffer.concat([buffer, bytes]);
        while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
          const size = buffer.readUInt32BE(1),
            kind = buffer[0],
            body = buffer.subarray(5, size + 5);
          buffer = buffer.subarray(size + 5);
          if (kind === 79) outputText += decoder.write(body);
          else if (kind === 69) outputText += 'VIEWER_ERROR';
        }
      });
      await new Promise<void>((resolve, reject) => {
        peer!.once('connect', resolve);
        peer!.once('error', reject);
      });
      peer.write(frame('J', JSON.stringify({ sessionId: sid, attachOnly: true, cols: 80, rows: 24 })));
      await eventually(async () => (await clients()).trim() !== '', 'Native client did not attach');
      peer.write(frame('I', `unicode › ┌ ${pass}\r`));
      peer.write(frame('R', '[97,29]'));
      await eventually(async () => outputText.includes(`unicode › ┌ ${pass}`), 'Unicode output missing');
      await eventually(
        async () => (await tmux(['list-clients', '-F', '#{client_width}|#{client_height}'])).trim() === '97|29',
        'Actual native resize missing'
      );
      if (pass === 0) {
        peer.destroy();
        await eventually(
          async () => helperOutput.includes('Operator attachment closed with native proof'),
          'Original cleanup receipt was not fully settled'
        );
      } else {
        helper.kill('SIGTERM');
        await exited(helper);
      }
      await eventually(async () => (await clients()).trim() === '', 'Remote tmux attachment leaked');
      assert.equal(await pane(), original, 'Same stdin-reading model pane must survive');
      const current = inspected(await run(['inspect', cid]));
      assert.equal(current.Id, cid);
      assert.equal(current.State.StartedAt, before.State.StartedAt);
      assert.equal(current.State.Pid, before.State.Pid);
    }
    await fs.writeFile(
      output,
      JSON.stringify({
        version: 1,
        image,
        bridge,
        sameContainer: true,
        samePane: true,
        unicode: true,
        resize: true,
        killedDockerClientRecovered: true,
        lostClosedReplyRecovered: true,
        lostReleaseReplyRecoveredByOriginalKernelExit: true,
        releaseEndpointCleanup: directOwner.endpointCleanup,
        disconnectClientAbsent: true,
        serviceTerminationClientAbsent: true,
      }) + '\n'
    );
  } catch (cause) {
    throw new Error(`Owned viewer canary failed; ${stderr}`, { cause });
  } finally {
    peer?.destroy();
    try {
      if (cid) {
        const current = inspected(await run(['inspect', cid]));
        assert.equal(current.Id, cid);
        assert.equal(current.Config.Labels['reverie.viewer-fixture'], token);
        await run(['rm', '--force', cid]);
      }
    } finally {
      for (const child of [helper, orphaned])
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await settled(child, 5000);
        }
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = parseArgs({
    options: { image: { type: 'string' }, docker: { type: 'string' }, output: { type: 'string' }, bridge: { type: 'string' } },
    strict: true,
  }).values;
  if (!values.image || !values.docker || !values.output || !values.bridge)
    throw new Error('--image --docker --output --bridge required');
  await exercise(values.image, values.docker, values.output, values.bridge);
}
