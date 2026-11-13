import {expect, it, vi} from 'vitest';
import {spawn} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createConnection, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {attachRequest, currentAsync, inspectTarget, validateTarget, type Target} from '../scripts/operator-viewer-bridge.js';
import {AttachmentFrames, AttachmentInput, FRAME_BYTES, type AttachmentIoPort} from '../scripts/operator-viewer-input.js';
import {bufferedPtyBytes, capturePtyStream, PtyWriteCredit} from '../scripts/operator-viewer-pty.js';
const target: Target = {sessionId: '00000001-0001-4000-8000-000000000001', containerId: 'a'.repeat(64), startedAt: '2026-11-11T00:00:00.000Z', pid: 1234, socket: '/tmp/private/operator.sock'};
const row = {Id: target.containerId, Name: `/reverie-agent-${target.sessionId}`, State: {Running: true, StartedAt: target.startedAt, Pid: target.pid}};
it('pins exact original container incarnation and never selects by mutable name', () => {
  expect(() => inspectTarget(target, row)).not.toThrow();
  for (const changed of [{...row, Id: 'b'.repeat(64)}, {...row, Name: '/foreign'}, {...row, State: {...row.State, Running: false}}, {...row, State: {...row.State, StartedAt: '2026-11-12T00:00:00.000Z'}}, {...row, State: {...row.State, Pid: 5678}}]) expect(() => inspectTarget(target, changed)).toThrow();
});
it('rejects abbreviated IDs, shell metacharacters and socket traversal', () => {
  for (const changed of [{...target, containerId: 'aaaa'}, {...target, containerId: ';touch /tmp/escape'}, {...target, socket: '/tmp/private/../operator.sock'}]) expect(() => validateTarget(changed)).toThrow();
});
it('accepts only exact-session attach-only J and never executes supplied commands', () => {
  const request = {sessionId: target.sessionId, attachOnly: true, cols: 120, rows: 40, command: 'DO NOT RUN', cwd: '/foreign', env: {PATH: '/foreign'}};
  expect(attachRequest(target, 74, Buffer.from(JSON.stringify(request)))).toEqual({cols: 120, rows: 40});
  for (const changed of [{...request, attachOnly: false}, {...request, sessionId: 'foreign'}, {...request, cols: '120'}, {...request, rows: 0}]) expect(() => attachRequest(target, 74, Buffer.from(JSON.stringify(changed)))).toThrow();
  expect(() => attachRequest(target, 67, Buffer.from('{}'))).toThrow();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
function inputFixture(overrides: Partial<AttachmentIoPort> = {}) {
  const effects: Array<string | number[]> = [];
  const port: AttachmentIoPort = {
    live: () => true, drained: async () => {}, probe: vi.fn(async () => {}),
    write: bytes => {effects.push(bytes.toString('utf8'));}, resize: (cols, rows) => {effects.push([cols, rows]);}, fail: vi.fn(), ...overrides,
  };
  return {port, effects, input: new AttachmentInput(port)};
}
it('coalesces a high-rate burst in order with one fresh probe per sealed batch', async () => {
  const fixture = inputFixture();
  const text = Array.from({length: 1000}, (_, i) => String(i % 10));
  for (const key of text) fixture.input.input(Buffer.from(key));
  await fixture.input.idle();
  expect(fixture.effects).toEqual([text.join('')]);
  expect(fixture.port.probe).toHaveBeenCalledTimes(1);
  expect(fixture.port.fail).not.toHaveBeenCalled();
});
it('seals before the async probe, remains responsive, and separately checks input arriving during it', async () => {
  const gate = deferred(), entered = deferred();
  const probe = vi.fn(async () => {if (probe.mock.calls.length === 1) {entered.resolve(); await gate.promise;}});
  const fixture = inputFixture({probe});
  fixture.input.input(Buffer.from('before'));
  await entered.promise;
  let ticked = false;
  await new Promise<void>(resolve => {setTimeout(() => {ticked = true; resolve();}, 0);});
  fixture.input.input(Buffer.from('during'));
  expect(ticked).toBe(true); expect(fixture.effects).toEqual([]);
  gate.resolve(); await fixture.input.idle();
  expect(fixture.effects).toEqual(['before', 'during']); expect(probe).toHaveBeenCalledTimes(2);
});
it('preserves resize position between input batches and passes actual bounded geometry', async () => {
  const fixture = inputFixture();
  fixture.input.input(Buffer.from('a')); fixture.input.resize(120, 40); fixture.input.input(Buffer.from('b'));
  await fixture.input.idle();
  expect(fixture.effects).toEqual(['a', [120, 40], 'b']); expect(fixture.port.probe).toHaveBeenCalledTimes(3);
  expect(() => fixture.input.resize(1, 501)).toThrow('resize');
});
it('writes nothing when the fresh identity probe refuses or the original attachment closes during it', async () => {
  const refused = inputFixture({probe: async () => {throw new Error('Original provider pane changed');}});
  refused.input.input(Buffer.from('never')); await refused.input.idle();
  expect(refused.effects).toEqual([]); expect(refused.port.fail).toHaveBeenCalledTimes(1);
  const gate = deferred(), entered = deferred(); let live = true;
  const closed = inputFixture({live: () => live, probe: async () => {entered.resolve(); await gate.promise;}});
  closed.input.input(Buffer.from('never')); await entered.promise;
  live = false; gate.resolve(); await closed.input.idle();
  expect(closed.effects).toEqual([]); expect(closed.port.fail).toHaveBeenCalledTimes(1);
});
it('retains the active sealed bytes in capacity accounting and refuses overload without a delayed write', async () => {
  const gate = deferred(), entered = deferred();
  const fixture = inputFixture({probe: async () => {entered.resolve(); await gate.promise;}});
  fixture.input.input(Buffer.alloc(64 * 1024)); await entered.promise;
  for (let i = 0; i < 3; i++) fixture.input.input(Buffer.alloc(FRAME_BYTES));
  fixture.input.input(Buffer.alloc(192 * 1024));
  expect(() => fixture.input.input(Buffer.from('overflow'))).toThrow('capacity');
  gate.resolve(); await fixture.input.idle(); expect(fixture.effects).toEqual([]);
  expect(fixture.port.fail).toHaveBeenCalledTimes(1);
});
it('waits for bounded SDK buffer credit before its fresh probe and cancels stalled writes', async () => {
  const gate = deferred(), entered = deferred();
  const fixture = inputFixture({drained: async () => {entered.resolve(); await gate.promise;}});
  fixture.input.input(Buffer.from('later')); await entered.promise;
  expect(fixture.port.probe).not.toHaveBeenCalled(); fixture.input.stop();
  gate.resolve(); await fixture.input.idle(); expect(fixture.effects).toEqual([]);
});
function encoded(kind: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5); header[0] = kind.charCodeAt(0); header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
it('decodes coalesced individually valid frames above one frame size and arbitrarily fragmented UTF-8 bytes', () => {
  const found: Array<[number, Buffer]> = [];
  const frames = new AttachmentFrames((kind, payload) => found.push([kind, payload]));
  const first = Buffer.alloc(FRAME_BYTES, 65), second = Buffer.from('漢🙂');
  const joined = Buffer.concat([encoded('I', first), encoded('R', Buffer.from('[120,40]')), encoded('I', second)]);
  frames.feed(joined);
  expect(found.map(([kind]) => kind)).toEqual([73, 82, 73]); expect(found[0][1]).toEqual(first); expect(found[2][1]).toEqual(second);
  const fragmented: Buffer[] = [], decoder = new AttachmentFrames((_, payload) => fragmented.push(payload));
  for (const byte of encoded('I', second)) decoder.feed(Buffer.from([byte]));
  expect(fragmented).toEqual([second]);
  const oversize = Buffer.alloc(5); oversize[0] = 73; oversize.writeUInt32BE(FRAME_BYTES + 1, 1);
  expect(() => frames.feed(oversize)).toThrow('bound');
});
it('uses the pinned SDK buffer shape as bounded credit only, refusing unknown or excessive queues', () => {
  expect(bufferedPtyBytes({_writeStream: {_writeQueue: [{buffer: Buffer.alloc(10), offset: 3}]}})).toBe(7);
  for (const bad of [{}, {_writeStream: {_writeQueue: [{buffer: Buffer.alloc(1), offset: 2}]}},
    {_writeStream: {_writeQueue: [{buffer: Buffer.alloc(65 * 1024), offset: 0}]}}]) expect(() => bufferedPtyBytes(bad)).toThrow();
});
it('never treats an SDK queue cleared after partial failure as fresh write credit', () => {
  const entry = {buffer: Buffer.from('original'), offset: 0};
  const child = {_writeStream: {_writeQueue: [entry]}};
  const credit = new PtyWriteCredit(child); credit.wrote(entry.buffer);
  entry.offset = 2; expect(credit.empty()).toBe(false);
  child._writeStream._writeQueue.length = 0;
  expect(() => credit.empty()).toThrow('unconfirmed');
  entry.offset = entry.buffer.length;
  expect(() => credit.empty()).toThrow('unconfirmed');
  const positive = {_writeStream: {_writeQueue: [{buffer: Buffer.from('ok'), offset: 0}]}};
  const complete = new PtyWriteCredit(positive); complete.wrote(Buffer.from('ok'));
  positive._writeStream._writeQueue[0].offset = 2; positive._writeStream._writeQueue.shift();
  expect(complete.empty()).toBe(true); // Buffer credit, not terminal/provider acknowledgement.
});
it('refuses a closed or replaced original SDK ReadStream before delayed onExit, even if its descriptor is reused', () => {
  for (const change of ['closed', 'socket', 'handle', 'writable', 'descriptor']) {
    const stream = {_handle: {fd: 7}, destroyed: false}, child = {_socket: stream, _fd: 7, _writable: true};
    const handle = stream._handle, original = capturePtyStream(child); expect(original()).toBe(true);
    if (change === 'closed') stream.destroyed = true;
    if (change === 'socket') child._socket = {_handle: {fd: 7}, destroyed: false};
    if (change === 'handle') stream._handle = {fd: 7};
    if (change === 'writable') child._writable = false;
    if (change === 'descriptor') child._fd = 8;
    expect(original()).toBe(false);
    stream.destroyed = false; child._socket = stream; stream._handle = handle; child._writable = true; child._fd = 7;
    expect(original()).toBe(false); // Restoring field equality never revives an ended lifetime.
  }
  expect(capturePtyStream({})()).toBe(false);
});

function fakeDocker(directory: string, runtime: string) {
  const state = join(directory, 'state.json'), received = join(directory, 'received'), probes = join(directory, 'probes');
  writeFileSync(state, JSON.stringify({pane: '$0|123|%0|101|0'})); writeFileSync(received, ''); writeFileSync(probes, '');
  // A disposable executable, not a Docker daemon. Unexpected argv is refused.
  writeFileSync(join(directory, 'docker'), `#!${runtime}
const fs = require('node:fs'), cp = require('node:child_process');
const a = process.argv.slice(2);
if(a[0] === '--host') {if(a[1] !== 'unix:///fixture/docker.sock')process.exit(98);a.splice(0,2);}
const state = ${JSON.stringify(state)}, received = ${JSON.stringify(received)}, probes = ${JSON.stringify(probes)};
if (a[0] === 'inspect' && a[1] === '${target.containerId}') {
  fs.appendFileSync(probes, 'inspect\\n');
  setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify([row]))}), 75);
} else if (a[0] === 'exec' && a.includes('display-message')) {
  fs.appendFileSync(probes, 'pane\\n'); console.log(JSON.parse(fs.readFileSync(state, 'utf8')).pane);
} else if (a[0] === 'exec' && a[1] === '-it' && a[2] === '${target.containerId}' && a.includes('attach-session')) {
  process.stdin.setRawMode(true);
  const size = () => cp.execFileSync('stty', ['size'], {encoding:'utf8',stdio:['inherit','pipe','inherit']}).trim();
  console.log('GEOMETRY:' + size());
  process.stdin.on('data', bytes => {fs.appendFileSync(received, bytes); if (bytes.includes(71)) console.log('GEOMETRY:' + size());});
} else {console.error('Unexpected synthetic Docker invocation'); process.exitCode = 99;}
`, {mode: 0o700});
  return {state, received, probes};
}
async function until(predicate: () => boolean, milliseconds = 6000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Bounded synthetic attachment fixture timed out');
    await delay(10);
  }
}
it('keeps the event loop responsive during the real asynchronous fresh-container/pane subprocess probe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-async-test-'));
  fakeDocker(directory, process.execPath);
  const originalPath = process.env.PATH;
  vi.stubEnv('REVERIE_OPERATOR_DOCKER_HOST', 'unix:///fixture/docker.sock');
  process.env.PATH = `${directory}:${originalPath}`;
  try {
    let finished = false;
    const probe = currentAsync(target).finally(() => {finished = true;});
    await delay(10); expect(finished).toBe(false);
    expect(await probe).toBe('$0|123|%0|101|0');
  } finally {process.env.PATH = originalPath; vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});}
});

// Opt-in because the native addon must be paired with its actual packaged Node
// ABI. This fixture always substitutes its own Docker executable; no engine is used.
it.runIf(Boolean(process.env.NIX_OPERATOR_TEST_NODE && process.env.NIX_OPERATOR_TEST_SDK))(
  'preserves the legacy SDK/Input components for ordered burst, real resize, UTF-8, and changed-pane refusal', async () => {
    const runtime = process.env.NIX_OPERATOR_TEST_NODE!, sdk = process.env.NIX_OPERATOR_TEST_SDK!;
    const directory = mkdtempSync(join(tmpdir(), 'operator-pty-test-')); chmodSync(directory, 0o700);
    const files = fakeDocker(directory, runtime), socketPath = join(directory, 'v.sock');
    const source = fileURLToPath(new URL('./fixtures/operator-legacy-sdk-program.ts', import.meta.url));
    const child = spawn(runtime, ['--import', 'tsx', source, '--session-id', target.sessionId, '--container-id', target.containerId,
      '--started-at', target.startedAt, '--pid', String(target.pid), '--socket', socketPath], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, REVERIE_OPERATOR_NODE_PTY: sdk, REVERIE_OPERATOR_DOCKER_HOST: 'unix:///fixture/docker.sock', PATH: `${directory}:${process.env.PATH}`},
    });
    let socket: Socket | undefined, diagnostics = '', ready = false;
    child.stdout.on('data', bytes => {if (String(bytes).includes('Operator attachment ready')) ready = true;});
    child.stderr.on('data', bytes => {diagnostics += String(bytes);});
    try {
      await until(() => ready || child.exitCode !== null); expect(child.exitCode, diagnostics).toBe(null);
      socket = createConnection(socketPath); await new Promise<void>((resolve, reject) => {socket!.once('connect', resolve); socket!.once('error', reject);});
      let output = '', refused = false;
      const frames = new AttachmentFrames((kind, bytes) => {if (kind === 79) output += bytes.toString('utf8'); if (kind === 69) refused = true;});
      socket.on('data', bytes => frames.feed(bytes));
      socket.write(encoded('J', Buffer.from(JSON.stringify({sessionId: target.sessionId, attachOnly: true, cols: 80, rows: 24}))));
      await until(() => output.includes('GEOMETRY:24 80'));
      socket.write(encoded('R', Buffer.from('[120,40]')));
      const text = '漢🙂' + '0123456789'.repeat(100);
      socket.write(Buffer.concat([...Buffer.from(text)].map(byte => encoded('I', Buffer.from([byte])))));
      socket.write(encoded('I', Buffer.from('G')));
      await until(() => readFileSync(files.received).equals(Buffer.from(text + 'G')) && output.includes('GEOMETRY:40 120'));
      expect(refused).toBe(false);
      expect(readFileSync(files.probes, 'utf8').split('inspect\n').length - 1).toBeLessThan(20);
      const before = readFileSync(files.probes, 'utf8').length;
      socket.write(encoded('I', Buffer.from('must-not-arrive')));
      await until(() => readFileSync(files.probes, 'utf8').length > before);
      writeFileSync(files.state, JSON.stringify({pane: '$0|123|%0|202|0'}));
      await until(() => refused);
      expect(readFileSync(files.received).equals(Buffer.from(text + 'G'))).toBe(true);
    } finally {
      socket?.destroy();
      if (child.exitCode === null) child.kill('SIGTERM');
      await until(() => child.exitCode !== null || child.signalCode !== null).catch(() => {child.kill('SIGKILL');});
      rmSync(directory, {recursive: true, force: true});
    }
  }, 15_000);
