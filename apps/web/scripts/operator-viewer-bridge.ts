/** One existing worker's native attachment. No provider/container launch or stop authority. */
import {execFile, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {chmodSync, lstatSync, realpathSync, unlinkSync} from 'node:fs';
import {createConnection, createServer, type Socket} from 'node:net';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {AttachmentFrames, AttachmentInput, FRAME_BYTES as MAX} from './operator-viewer-input.js';
import {NativeAttachmentIo} from './operator-viewer-native-io.js';
import {ViewerAttachmentOwner, validateCapability, settleOriginalOwner, type OwnerBirth} from './operator-viewer-owner.js';
import {dockerContextArguments, pinnedUnixDocker, type PinnedUnixDocker} from './lib/pinned-unix-docker.js';
export {validateCapability};
const execute = promisify(execFile);
export interface Target {sessionId: string; containerId: string; startedAt: string; pid: number; socket: string;}
export function validateTarget(t: Target): void {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(t.sessionId) || !/^[a-f0-9]{64}$/.test(t.containerId)
    || !Number.isSafeInteger(t.pid) || t.pid < 1 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(t.startedAt)
    || !isAbsolute(t.socket) || resolve(t.socket) !== t.socket || Buffer.byteLength(t.socket) > 100)
    throw new Error('Exact session, full container ID, start timestamp, PID and private socket required');
}
export function inspectTarget(t: Target, value: unknown): void {
  const row = value as {Id?: unknown; Name?: unknown; State?: {Running?: unknown; StartedAt?: unknown; Pid?: unknown}};
  if (row?.Id !== t.containerId || row.Name !== `/reverie-agent-${t.sessionId}` || row.State?.Running !== true
    || row.State.StartedAt !== t.startedAt || row.State.Pid !== t.pid) throw new Error('Original running container changed');
}
export function attachRequest(t: Target, kind: number, payload: Buffer): {cols: number; rows: number} {
  if (kind !== 74 || payload.length > MAX) throw new Error('Only attach-only J supported');
  const row: unknown = JSON.parse(payload.toString('utf8'));
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid attachment');
  const r = row as Record<string, unknown>;
  if (r.sessionId !== t.sessionId || r.attachOnly !== true || !Number.isSafeInteger(r.cols) || Number(r.cols) < 1
    || Number(r.cols) > 1000 || !Number.isSafeInteger(r.rows) || Number(r.rows) < 1 || Number(r.rows) > 500)
    throw new Error('Original session and bounded attach-only geometry required');
  return {cols: Number(r.cols), rows: Number(r.rows)};
}
export function attachmentArguments(t: Target, nonce: string, cols: number, rows: number): string[] {
  validateTarget(t);
  if (!/^[a-f0-9]{32}$/.test(nonce) || !Number.isSafeInteger(cols) || cols < 1 || cols > 1000
    || !Number.isSafeInteger(rows) || rows < 1 || rows > 500) throw new Error('Invalid attachment');
  return ['exec', '-i', t.containerId, '/bin/reverie-worker-child', 'viewer-v1', 'attach', '--nonce', nonce,
    '--cols', String(cols), '--rows', String(rows)];
}
function frame(s: Socket, kind: string, payload: Buffer | string): void {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  for (let offset = 0; offset < bytes.length || offset === 0; offset += MAX) {
    const part = bytes.subarray(offset, offset + MAX), header = Buffer.alloc(5);
    header[0] = kind.charCodeAt(0); header.writeUInt32BE(part.length, 1); s.write(Buffer.concat([header, part]));
    if (bytes.length === 0) break;
  }
}
async function selectedEngine(): Promise<PinnedUnixDocker> {
  const environment = {...process.env}, query = dockerContextArguments(environment);
  const context = query ? (await execute('docker', query, {env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 4096})).stdout : '';
  return pinnedUnixDocker(environment, args => {
    if (JSON.stringify(args) !== JSON.stringify(query)) throw new Error('Original Docker selection changed');
    return context;
  });
}
async function docker(engine: PinnedUnixDocker, args: string[], maxBuffer = 4096, timeout = 5000): Promise<string> {
  return (await execute('docker', engine.args(args), {env: engine.environment, encoding: 'utf8', timeout, maxBuffer})).stdout;
}
async function assertOriginalContainer(t: Target, engine: PinnedUnixDocker): Promise<void> {
  const rows: unknown = JSON.parse(await docker(engine, ['inspect', t.containerId], 2 * 1024 * 1024));
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Original container unavailable');
  inspectTarget(t, rows[0]);
}
export async function currentAsync(t: Target, selection?: PinnedUnixDocker): Promise<string> {
  const engine = selection ?? await selectedEngine();
  await assertOriginalContainer(t, engine);
  const pane = (await docker(engine, ['exec', t.containerId, '/bin/tmux', '-N', '-L', 'reverie-laptop', 'display-message',
    '-p', '-t', '=office:', '#{session_id}|#{session_created}|#{pane_id}|#{pane_pid}|#{pane_dead}'])).trim();
  if (!/^\$\d+\|\d+\|%\d+\|[1-9]\d*\|0$/.test(pane)) throw new Error('Original live office pane unavailable');
  return pane;
}
function clientCensus(t: Target, engine: PinnedUnixDocker): Promise<string> {
  return docker(engine, ['exec', t.containerId, '/bin/tmux', '-N', '-L', 'reverie-laptop', 'list-clients', '-F', '#{client_pid}']);
}
async function control(t: Target, engine: PinnedUnixDocker, nonce: string, action: 'close' | 'release' | 'status' | 'exited', birth?: OwnerBirth): Promise<string> {
  await assertOriginalContainer(t, engine);
  return docker(engine, ['exec', t.containerId, '/bin/reverie-worker-child', 'viewer-v1', action, '--nonce', nonce,
    ...(birth ? ['--owner-pid', String(birth.pid), '--start', birth.start, '--boot', birth.boot, '--namespace', birth.namespace] : [])], 4096, 15000);
}
function localExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const closed = () => {clearTimeout(timer); resolveExit();};
    const timer = setTimeout(() => {child.off('close', closed); reject(new Error('Original Docker client settlement unconfirmed'));}, 5000);
    child.once('close', closed);
  });
}
/** One original constructor handshake. Socket loss never cancels its cleanup
 * identity, and expiry never permits a premature/repeated native CLOSE. */
function constructorReceipt(onFailure: () => void) {
  let done = false, resolve!: () => void, reject!: (cause: unknown) => void;
  const joined = new Promise<void>((yes, no) => {resolve = yes; reject = no;});
  // Keep the original rejection for cleanup even before cleanup is requested.
  void joined.catch(() => {});
  const finish = (failure?: {cause: unknown}) => {
    if (done) return;
    done = true; clearTimeout(timer);
    if (failure) reject(failure.cause); else resolve();
  };
  const timer = setTimeout(() => {
    finish({cause: new Error('Original native constructor handshake is unconfirmed')}); onFailure();
  }, 5000);
  return {joined, observe: () => finish(), fail: (cause: unknown) => finish({cause})};
}
function privateFolder(socket: string): {dev: number; ino: number} {
  const parent = dirname(socket), uid = process.getuid?.(), info = lstatSync(parent);
  if (uid === undefined || !info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0 || realpathSync(parent) !== parent)
    throw new Error('Socket directory must be an original owner-only directory');
  return {dev: info.dev, ino: info.ino};
}
export async function serve(selected: Target): Promise<void> {
  const t = Object.freeze({...selected}); validateTarget(t);
  const folder = privateFolder(t.socket);
  try {lstatSync(t.socket); throw new Error('Socket already exists; never replacing it');}
  catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
  const engine = await selectedEngine(), originalPane = await currentAsync(t, engine);
  validateCapability(await docker(engine, ['exec', t.containerId, '/bin/reverie-worker-child', 'viewer-v1', 'capabilities']));
  let occupied: ViewerAttachmentOwner | undefined;
  let pendingAdmission: object | undefined;
  const clients = new Set<Socket>(), owners = new Set<ViewerAttachmentOwner>();
  let servicePhase: 'open' | 'closing' | 'held' = 'open';
  const server = createServer(s => {
    clients.add(s);
    let attached = false, failed = false, queryOnly = false, cleanupObserved = false;
    let child: ChildProcessWithoutNullStreams | undefined, owner: ViewerAttachmentOwner | undefined;
    let input: AttachmentInput | undefined, stream: NativeAttachmentIo | undefined;
    const startup: {timer?: ReturnType<typeof setTimeout>} = {};
    let subject: Readonly<{child: ChildProcessWithoutNullStreams; owner: ViewerAttachmentOwner; stream: NativeAttachmentIo}> | undefined;
    let admission: object | undefined;
    const stopInput = () => {clearTimeout(startup.timer); input?.stop(); stream?.stop();};
    const clearPending = () => {if (pendingAdmission === admission) pendingAdmission = undefined;};
    const fail = () => {
      if (failed) return;
      failed = true; stopInput(); clearPending();
      if (!s.destroyed) {frame(s, 'E', owner ? 'OPERATOR_VIEWER_UNCONFIRMED' : 'OPERATOR_VIEWER_REFUSED'); s.end();}
    };
    const cleanup = () => {
      stopInput(); clearPending();
      const originalOwner = owner;
      if (!originalOwner || cleanupObserved) return;
      cleanupObserved = true;
      void originalOwner.close().then(() => {
        const first = owners.has(originalOwner);
        occupied = settleOriginalOwner(owners, originalOwner, occupied);
        if (first) console.log('Operator attachment closed with native proof');
      }).catch(() => {console.error('Original viewer cleanup is unconfirmed; attachment remains held'); fail(); process.exitCode = 1;});
    };
    s.on('error', () => {});
    s.on('close', () => {clients.delete(s); cleanup();});
    s.setTimeout(10_000, () => {if (!attached) fail();});
    const start = async (size: {cols: number; rows: number}, token: object, originalStream: NativeAttachmentIo) => {
      if (await currentAsync(t, engine) !== originalPane) throw new Error('Original attachment changed');
      if (failed || s.destroyed || servicePhase !== 'open' || pendingAdmission !== token || stream !== originalStream || originalStream.stopped) return;
      const nonce = randomBytes(16).toString('hex');
      let originalChild: ChildProcessWithoutNullStreams | undefined;
      const constructor = constructorReceipt(() => {fail(); cleanup();});
      const originalOwner = new ViewerAttachmentOwner(nonce, {
        close: async () => {
          // End only this constructor's pipe; no process/provider signal and no
          // late input. Native EOF closes its owned attachment, not the model.
          originalChild?.stdin.end();
          await constructor.joined;
          return control(t, engine, nonce, 'close');
        }, status: () => control(t, engine, nonce, 'status'),
        exited: birth => control(t, engine, nonce, 'exited', birth), release: () => control(t, engine, nonce, 'release'),
        assertOriginalContainer: () => assertOriginalContainer(t, engine), clients: () => clientCensus(t, engine),
        localExit: () => originalChild ? localExit(originalChild) : Promise.reject(new Error('Original local constructor handle is unconfirmed')),
      });
      owner = originalOwner; owners.add(originalOwner); occupied = originalOwner; clearPending();
      originalOwner.start(() => {
        originalChild = spawn('docker', engine.args(attachmentArguments(t, nonce, size.cols, size.rows)),
          {stdio: ['pipe', 'pipe', 'pipe'], env: engine.environment});
        child = originalChild;
        // Retain constructor error/exit on this exact Child before any fallible
        // stream binding; a late spawn error must not become an unhandled exit.
        originalChild.on('error', cause => {constructor.fail(cause); clearTimeout(startup.timer); fail(); cleanup();});
        originalChild.on('close', () => {constructor.fail(new Error('Original constructor exited before its handshake')); clearTimeout(startup.timer); stopInput(); if (!s.destroyed) s.end(); cleanup();});
      });
      const original = originalChild;
      if (!original || !original.stdin || !original.stdout || !original.stderr) throw new Error('Original local constructor pipes unavailable');
      original.stdin.on('error', () => {fail(); cleanup();});
      original.stdout.on('error', () => {fail(); cleanup();});
      original.stderr.on('error', () => {fail(); cleanup();});
      original.stdout.on('end', () => {
        constructor.fail(new Error('Original constructor output ended before its handshake'));
        if (originalOwner.awaitingReady || originalOwner.acceptsInput) {fail(); cleanup();}
      });
      originalStream.bind(original.stdin);
      subject = Object.freeze({child: original, owner: originalOwner, stream: originalStream});
      let greeting = Buffer.alloc(0), ready = false, admitting = false;
      startup.timer = setTimeout(() => {if (!ready) {fail(); cleanup();}}, 5000);
      const live = () => !failed && !s.destroyed && child === original && owner === originalOwner && stream === originalStream && !originalStream.stopped;
      const admit = async (line: string) => {
        const end = Date.now() + 4000;
        while (live() && originalOwner.awaitingReady) {
          try {
            const census = await clientCensus(t, engine);
            if (await currentAsync(t, engine) !== originalPane) throw new Error('Original pane changed');
            if (!live() || !originalOwner.awaitingReady) return;
            originalOwner.ready(line, census);
            ready = true; clearTimeout(startup.timer); originalStream.ready();
            if (greeting.length) frame(s, 'O', greeting);
            greeting = Buffer.alloc(0);
            return;
          } catch (cause) {
            if (!live() || !originalOwner.awaitingReady || Date.now() >= end) throw cause;
            await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
          }
        }
      };
      original.stdout.on('data', (data: Buffer) => {
        try {
          if (!ready) {
            // After peer loss parse only the bounded original READY. Capturing
            // its nonce/birth cannot reopen input, output or admission.
            if (admitting && !live()) return;
            greeting = Buffer.concat([greeting, data]);
            if (greeting.length > MAX) throw new Error('Native greeting overflow');
            if (!admitting) {
              const end = greeting.indexOf(10);
              if (end === -1) {if (greeting.length > 512) throw new Error('Invalid original greeting'); return;}
              const line = greeting.subarray(0, end + 1).toString('utf8'); greeting = greeting.subarray(end + 1); admitting = true;
              originalOwner.observeStartup(line); constructor.observe();
              if (!live()) {greeting = Buffer.alloc(0); return;}
              void admit(line).catch(() => {fail(); cleanup();});
            }
          } else if (live() && data.length) frame(s, 'O', data);
          if (s.writableLength > 1024 * 1024) throw new Error('Viewer output overflow');
        } catch (cause) {constructor.fail(cause); fail(); cleanup();}
      });
      let diagnosticReported = false;
      original.stderr.on('data', () => {
        if (!diagnosticReported) {diagnosticReported = true; console.error('Original native viewer reported a failure; attachment cleanup must be reconciled');}
        fail(); cleanup();
      });
    };
    const frames = new AttachmentFrames((kind, payload) => {
      if (failed) throw new Error('Original attachment closed');
      if (queryOnly) throw new Error('Reconciliation cannot admit attachment or input');
      if (!attached && kind === 75) {
        const query = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
        if (query.sessionId !== t.sessionId || query.action !== 'reconcile-viewer') throw new Error('Original operation required');
        queryOnly = true; s.pause();
        void reconcileOriginal(owners).then(originalOwner => {
          occupied = settleOriginalOwner(owners, originalOwner, occupied);
          if (servicePhase !== 'open' && owners.size === 0) closeListener();
          if (!s.destroyed) {frame(s, 'S', JSON.stringify({attachmentClosed: true, endpointCleanup: originalOwner.endpointCleanup})); s.end();}
        }).catch(() => {if (!s.destroyed) {frame(s, 'E', 'OPERATOR_VIEWER_CLEANUP_HELD'); s.end();}});
        return;
      }
      if (!attached) {
        if (servicePhase !== 'open' || occupied || pendingAdmission) throw new Error('Original attachment unavailable');
        const size = attachRequest(t, kind, payload);
        attached = true; s.setTimeout(0); admission = {}; pendingAdmission = admission;
        const originalStream = new NativeAttachmentIo(); stream = originalStream;
        input = new AttachmentInput({
          live: () => !failed && !s.destroyed && !!subject && child === subject.child && owner === subject.owner
            && stream === subject.stream && subject.owner.acceptsInput && !subject.stream.stopped,
          drained: () => originalStream.drained(),
          probe: async () => {if (await currentAsync(t, engine) !== originalPane) throw new Error('Original pane changed');},
          write: bytes => originalStream.input(bytes), resize: (cols, rows) => originalStream.resize(cols, rows), fail: () => {fail(); cleanup();},
        });
        void start(size, admission, originalStream).catch(() => {fail(); cleanup();});
      } else if (kind === 73) {
        if (!input) throw new Error('Original attachment unavailable');
        input.input(payload);
      } else if (kind === 82) {
        const size: unknown = JSON.parse(payload.toString('utf8'));
        if (!Array.isArray(size) || size.length !== 2 || !input) throw new Error('Invalid resize');
        input.resize(size[0], size[1]);
      } else throw new Error('Unsupported attachment frame');
    });
    s.on('data', bytes => {try {frames.feed(bytes);} catch {fail(); cleanup();}});
  });
  let identity: {dev: number; ino: number} | undefined, listenerClosing = false;
  const closeListener = () => {
    if (listenerClosing) return;
    listenerClosing = true;
    server.close(() => {
      process.off('SIGTERM', close); process.off('SIGINT', close);
      try {const found = lstatSync(t.socket); if (identity && found.dev === identity.dev && found.ino === identity.ino) unlinkSync(t.socket);} catch { /* preserve foreign replacement */ }
    });
  };
  const close = () => {
    if (servicePhase !== 'open') return;
    servicePhase = 'closing';
    for (const s of clients) s.destroy();
    void Promise.all([...owners].map(owner => owner.close())).then(closeListener).catch(() => {
      servicePhase = 'held'; process.exitCode = 1; console.error('Viewer shutdown is held by original attachment cleanup uncertainty');
    });
  };
  const currentFolder = privateFolder(t.socket);
  if (currentFolder.dev !== folder.dev || currentFolder.ino !== folder.ino) throw new Error('Original socket directory changed');
  server.on('error', error => {console.error(`Operator viewer unavailable: ${error.message}`); close(); process.exitCode = 1;});
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    const oldMask = process.umask(0o077);
    try {server.listen(t.socket, () => {
      try {
        chmodSync(t.socket, 0o600); const found = lstatSync(t.socket); identity = {dev: found.dev, ino: found.ino};
        server.off('error', reject); console.log('Operator attachment ready; provider readiness is not asserted'); resolveReady();
      } catch (cause) {close(); reject(cause);}
    });} finally {process.umask(oldMask);}
  });
}
export async function reconcileOriginal(owners: Set<ViewerAttachmentOwner>): Promise<ViewerAttachmentOwner> {
  if (owners.size !== 1) throw new Error('Exactly one original held owner is required');
  const original = [...owners][0]; await original.reconcile();
  if (!original.closed || !owners.has(original)) throw new Error('Original owner settlement is unconfirmed');
  owners.delete(original); return original;
}
export async function requestReconciliation(sessionId: string, socket: string): Promise<string> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId) || !isAbsolute(socket) || resolve(socket) !== socket)
    throw new Error('Original session and private socket required');
  privateFolder(socket);
  return new Promise((resolveReply, reject) => {
    const peer = createConnection(socket); let buffer = Buffer.alloc(0), replied = false;
    const end = setTimeout(() => {peer.destroy(); reject(new Error('Original reconciliation unconfirmed'));}, 20000);
    peer.on('error', reject);
    peer.on('close', () => {clearTimeout(end); if (!replied) reject(new Error('Original reconciliation reply unconfirmed'));});
    peer.on('connect', () => frame(peer, 'K', JSON.stringify({sessionId, action: 'reconcile-viewer'})));
    peer.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > 1024) {peer.destroy(); reject(new Error('Invalid original status')); return;}
      if (buffer.length < 5 || buffer.length < 5 + buffer.readUInt32BE(1)) return;
      replied = true;
      if (buffer[0] === 83) resolveReply(buffer.subarray(5, 5 + buffer.readUInt32BE(1)).toString('utf8'));
      else reject(new Error('Original cleanup remains held'));
      peer.end();
    });
  });
}
async function main(): Promise<void> {
  const v = parseArgs({options: {'session-id': {type: 'string'}, 'container-id': {type: 'string'}, 'started-at': {type: 'string'},
    pid: {type: 'string'}, socket: {type: 'string'}, reconcile: {type: 'boolean'}}, strict: true}).values;
  if (v.reconcile) {console.log(await requestReconciliation(v['session-id'] ?? '', v.socket ?? '')); return;}
  await serve({sessionId: v['session-id'] ?? '', containerId: v['container-id'] ?? '', startedAt: v['started-at'] ?? '', pid: Number(v.pid), socket: v.socket ?? ''});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(cause => {console.error(cause instanceof Error ? cause.message : 'Operator attachment refused'); process.exitCode = 1;});
}
