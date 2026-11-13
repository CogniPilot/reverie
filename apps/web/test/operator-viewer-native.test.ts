import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createConnection } from 'node:net';
const controlIo = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const {promisify} = await vi.importActual<typeof import('node:util')>('node:util');
  const file = vi.fn();
  Object.defineProperty(file,promisify.custom,{value:controlIo.execute});
  return {...await importOriginal<typeof import('node:child_process')>(),execFile:file,execFileSync:vi.fn(),spawn:vi.fn()};
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
import {
  serve,
  attachmentArguments,
  validateCapability,
  attachRequest,
  inspectTarget,
  reconcileOriginal,
  validateTarget,
  type Target,
} from '../scripts/operator-viewer-bridge.js';
const target: Target = {
  sessionId: '00000001-0001-4000-8000-000000000001',
  containerId: 'a'.repeat(64),
  startedAt: '2026-11-11T00:00:00.000Z',
  pid: 1234,
  socket: '/tmp/private/operator.sock',
};
const row = {
  Id: target.containerId,
  Name: `/reverie-agent-${target.sessionId}`,
  State: { Running: true, StartedAt: target.startedAt, Pid: target.pid },
};
it('pins exact original container incarnation and never selects by mutable name', () => {
  expect(() => inspectTarget(target, row)).not.toThrow();
  for (const changed of [
    { ...row, Id: 'b'.repeat(64) },
    { ...row, Name: '/foreign' },
    { ...row, State: { ...row.State, Running: false } },
    { ...row, State: { ...row.State, StartedAt: '2026-11-12T00:00:00.000Z' } },
    { ...row, State: { ...row.State, Pid: 5678 } },
  ])
    expect(() => inspectTarget(target, changed)).toThrow();
});
it('rejects abbreviated IDs, shell metacharacters and socket traversal', () => {
  for (const changed of [
    { ...target, containerId: 'aaaa' },
    { ...target, containerId: ';touch /tmp/escape' },
    { ...target, socket: '/tmp/private/../operator.sock' },
  ])
    expect(() => validateTarget(changed)).toThrow();
});
it('accepts only exact-session attach-only J and never executes supplied commands', () => {
  const request = {
    sessionId: target.sessionId,
    attachOnly: true,
    cols: 120,
    rows: 40,
    command: 'DO NOT RUN',
    cwd: '/foreign',
    env: { PATH: '/foreign' },
  };
  expect(attachRequest(target, 74, Buffer.from(JSON.stringify(request)))).toEqual({ cols: 120, rows: 40 });
  expect(attachmentArguments(target, 'a'.repeat(32), 120, 40)).toEqual([
    'exec',
    '-i',
    target.containerId,
    '/bin/reverie-worker-child',
    'viewer-v1',
    'attach',
    '--nonce',
    'a'.repeat(32),
    '--cols',
    '120',
    '--rows',
    '40',
  ]);
  for (const changed of [
    { ...request, attachOnly: false },
    { ...request, sessionId: 'foreign' },
    { ...request, cols: '120' },
    { ...request, rows: 0 },
  ])
    expect(() => attachRequest(target, 74, Buffer.from(JSON.stringify(changed)))).toThrow();
  expect(() => attachRequest(target, 67, Buffer.from('{}'))).toThrow();
});

it('requires the exact native capability and refuses old image output before attachment', () => {
  expect(() => validateCapability('REVERIE_VIEWER_CHILD_V1\n')).not.toThrow();
  for (const text of ['', 'error: unexpected argument', 'REVERIE_VIEWER_CHILD_V1', 'REVERIE_VIEWER_CHILD_V2\n'])
    expect(() => validateCapability(text)).toThrow();
});

import {
  ViewerAttachmentOwner,
  exitedReceipt,
  parseReceipt,
  settleOriginalOwner,
  writeBounded,
  type ViewerCleanupPort,
} from '../scripts/operator-viewer-owner.js';
const birthWords = '4321 99 00000000-0000-4000-8000-000000000001 4026532000';
const nonce = 'a'.repeat(32),
  originalPane = '$1|123|%1|45|0';
function startingOwner(n: string, port: ViewerCleanupPort): ViewerAttachmentOwner {
  const owner = new ViewerAttachmentOwner(n, port);
  owner.start(() => {});
  return owner;
}
function cleanupPort(): ViewerCleanupPort {
  return {
    close: vi.fn(async () => `CLOSED ${nonce} 1234 ${birthWords}\n`),
    status: vi.fn(async () => `CLOSED ${nonce} 1234 ${birthWords}\n`),
    exited: vi.fn(async (owner) => exitedReceipt(nonce, owner)),
    assertOriginalContainer: vi.fn(async () => {}),
    clients: vi.fn(async () => ''),
    release: vi.fn(async () => `RELEASED ${nonce} 1234 ${birthWords}\n`),
    localExit: vi.fn(async () => {}),
  };
}
it('releases an occupied attachment only after actual closure, fresh readback and original local settlement', async () => {
  const port = cleanupPort();
  const owner = startingOwner(nonce, port);
  expect(owner.acceptsInput).toBe(false);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  expect(owner.acceptsInput).toBe(true);
  await Promise.all([owner.close(), owner.close()]);
  expect(owner.closed).toBe(true);
  expect(owner.acceptsInput).toBe(false);
  expect(port.close).toHaveBeenCalledTimes(1);
  expect(port.release).toHaveBeenCalledTimes(1);
  expect(port.localExit).toHaveBeenCalledTimes(1);
});
it('never lets a delayed original cleanup callback release a successor attachment slot', async () => {
  const original = startingOwner(nonce, cleanupPort());
  original.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  const owners = new Set([original]);
  let occupied: ViewerAttachmentOwner | undefined = original;
  await original.close();
  occupied = settleOriginalOwner(owners, original, occupied);
  expect(occupied).toBeUndefined();
  const nextNonce = 'b'.repeat(32),
    successor = startingOwner(nextNonce, cleanupPort());
  successor.ready(`READY ${nextNonce} 5678 ${birthWords}\n`, '5678\n');
  owners.add(successor);
  occupied = successor;
  await original.close().then(() => {
    occupied = settleOriginalOwner(owners, original, occupied);
  });
  expect(occupied).toBe(successor);
  expect(owners.has(successor)).toBe(true);
  expect(() => settleOriginalOwner(owners, successor, occupied)).toThrow(/unconfirmed/);
});
it.each([
  'wrong-nonce',
  'different-client',
  'still-present',
  'malformed-census',
  'release-unknown',
  'local-unknown',
])('retains original ownership on %s and never silently starts a replacement', async (failure) => {
  const port = cleanupPort();
  if (failure === 'wrong-nonce') port.close = vi.fn(async () => `CLOSED ${'b'.repeat(32)} 1234 ${birthWords}\n`);
  if (failure === 'different-client') port.close = vi.fn(async () => `CLOSED ${nonce} 5678 ${birthWords}\n`);
  if (failure === 'still-present') port.clients = vi.fn(async () => '1234\n');
  if (failure === 'malformed-census') port.clients = vi.fn(async () => 'unknown');
  if (failure === 'release-unknown') port.release = vi.fn(async () => 'UNKNOWN\n');
  if (failure === 'local-unknown')
    port.localExit = vi.fn(async () => {
      throw new Error('pending');
    });
  const owner = startingOwner(nonce, port);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  await expect(owner.close()).rejects.toThrow(/unconfirmed/);
  expect(owner.closed).toBe(false);
  expect(owner.acceptsInput).toBe(false);
  await expect(owner.close()).rejects.toThrow(/unconfirmed/);
  expect(port.close).toHaveBeenCalledTimes(1);
  if (!['release-unknown', 'local-unknown'].includes(failure)) expect(port.release).not.toHaveBeenCalled();
});
it('does not treat constructor success or a stale READY PID as proof of actual attachment', () => {
  const owner = startingOwner(nonce, cleanupPort());
  expect(() => owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '5678\n')).toThrow();
  expect(owner.acceptsInput).toBe(false);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  expect(() => owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n')).toThrow();
});
it('captures late constructor identity while closing without reopening input or changing the original receipt', async () => {
  const port = cleanupPort();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  port.close = vi.fn(async () => {await gate; return `CLOSED ${nonce} 1234 ${birthWords}\n`;});
  const owner = startingOwner(nonce, port);
  const closing = owner.close();
  owner.observeStartup(`READY ${nonce} 1234 ${birthWords}\n`);
  expect(owner.acceptsInput).toBe(false);
  expect(owner.awaitingReady).toBe(false);
  expect(() => owner.observeStartup(`READY ${nonce} 5678 ${birthWords}\n`)).toThrow(/changed/);
  expect(() => owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n')).toThrow(/admitted/);
  finish(); await closing;
  expect(owner.closed).toBe(true);
  expect(port.close).toHaveBeenCalledTimes(1);
});

import { exercise, immutableViewerBridge, immutableViewerImage } from '../scripts/test-native-viewer-child.js';
it('requires an explicit already-built immutable canary image without mutable tags or pull fallback', () => {
  expect(immutableViewerImage('sha256:' + 'a'.repeat(64))).toBe('sha256:' + 'a'.repeat(64));
  for (const value of ['', 'fixture:latest', 'sha256:abc', 'sha256:' + 'A'.repeat(64)])
    expect(() => immutableViewerImage(value)).toThrow();
});

it('refuses mutable or missing canary executables before any engine or attachment operation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'viewer-artifact-')));
  const mutable = join(root, 'reverie-operator-viewer-bridge');
  writeFileSync(mutable, `#!${process.execPath}\nprocess.exit(99);\n`, {mode: 0o700});
  try {
    for (const program of ['relative-viewer', mutable, join(root, 'missing'),
      '/nix/store/00000000000000000000000000000000-missing/bin/reverie-operator-viewer-bridge']) {
      expect(() => immutableViewerBridge(program)).toThrow();
      await expect(exercise('sha256:' + 'a'.repeat(64), '/missing-docker', join(root, 'result.json'), program))
        .rejects.toThrow();
    }
    expect(execFileSync).not.toHaveBeenCalled();
    expect(controlIo.execute).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'result.json'))).toBe(false);
  } finally {rmSync(root, {recursive: true, force: true});}
});

it('actual operator admission refuses unsupported worker roles before binding or spawning any attachment', async () => {
  vi.stubEnv('REVERIE_OPERATOR_DOCKER_HOST', 'unix:///fixture/docker.sock');
  const root = mkdtempSync(join(tmpdir(), 'viewer-refusal-'));
  const selected = { ...target, socket: join(root, 'view.sock') };
  vi.mocked(execFileSync).mockImplementation((_program, args) => {
    if (args?.includes('context')) return JSON.stringify('unix:///fixture/docker.sock');
    if (args?.includes('inspect')) return JSON.stringify([row]);
    if (args?.includes('display-message')) return '$1|123|%1|45|0\n';
    if (args?.includes('capabilities')) throw new Error('Old image: unknown viewer role');
    throw new Error('Unexpected operational effect');
  });
  controlIo.execute.mockImplementation(async (_program: string, args: string[]) => ({
    stdout: execFileSync('docker', args, {encoding: 'utf8'}), stderr: '',
  }));
  try {
    await expect(serve(selected)).rejects.toThrow(/unknown viewer role/);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['dead-pane','changed-pane'] as const)('actual bridge closes only its original attachment after %s and refuses new admission/input', async change => {
  vi.stubEnv('REVERIE_OPERATOR_DOCKER_HOST','unix:///fixture/docker.sock');
  const root = realpathSync(mkdtempSync(join(tmpdir(),'viewer-owner-'))), selected = {...target,socket:join(root,'v.sock')};
  const oldExit = process.exitCode, originalOnce = process.once.bind(process);
  let shutdown: (()=>void)|undefined, pane = originalPane, nativeClosed = false, census = 0, capturedNonce = '';
  const commands: string[][] = [], input: Buffer[] = [];
  const child = Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),
    exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,pid:999_999_995});
  child.stdin.on('data',bytes=>input.push(Buffer.from(bytes)));
  const signal = vi.spyOn(process,'once').mockImplementation((event,listener)=>{
    if(event === 'SIGTERM' || event === 'SIGINT'){shutdown=listener as ()=>void;return process;}
    return originalOnce(event,listener);
  });
  vi.mocked(execFileSync).mockImplementation((_program,args)=>{
    const words=(args || []).map(String);commands.push(words);
    if(words.includes('inspect'))return JSON.stringify([row]);
    if(words.includes('display-message'))return pane+'\n';
    if(words.includes('capabilities'))return 'REVERIE_VIEWER_CHILD_V1\n';
    if(words.includes('list-clients')){census++;return nativeClosed?'':'1234\n';}
    throw new Error('Unexpected fixture command');
  });
  vi.mocked(spawn).mockImplementation((_program,args)=>{
    const words=(args || []).map(String);commands.push(words);capturedNonce=words[words.indexOf('--nonce')+1];
    setImmediate(()=>child.stdout.write(`READY ${capturedNonce} 1234 ${birthWords}\n`));
    return child as never;
  });
  controlIo.execute.mockImplementation(async (_program:string,args:string[])=>{
    if(args.includes('inspect') || args.includes('display-message') || args.includes('capabilities') || args.includes('list-clients'))
      return {stdout:execFileSync('docker',args,{encoding:'utf8'}),stderr:''};
    commands.push([...args]);
    expect(args).toContain(target.containerId);expect(args.at(-1)).toBe(capturedNonce);
    if(args.includes('close')){nativeClosed=true;return {stdout:`CLOSED ${capturedNonce} 1234 ${birthWords}\n`,stderr:''};}
    if(args.includes('release')){
      child.exitCode=0;child.emit('close',0,null);
      return {stdout:`RELEASED ${capturedNonce} 1234 ${birthWords}\n`,stderr:''};
    }
    throw new Error('Unexpected fixture control');
  });
  const sockets: ReturnType<typeof createConnection>[] = [];
  const connect = async () => {
    const socket=createConnection(selected.socket);sockets.push(socket);socket.on('error',()=>{});socket.on('data',()=>{});
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
    return socket;
  };
  const send = (socket:ReturnType<typeof createConnection>,kind:string,value:object|string) => {
    const bytes=Buffer.from(typeof value === 'string'?value:JSON.stringify(value)),header=Buffer.alloc(5);
    header[0]=kind.charCodeAt(0);header.writeUInt32BE(bytes.length,1);socket.write(Buffer.concat([header,bytes]));
  };
  try {
    await serve(selected);await vi.waitFor(()=>expect(existsSync(selected.socket)).toBe(true));
    const first=await connect();send(first,'J',{sessionId:target.sessionId,attachOnly:true,cols:80,rows:24});
    await vi.waitFor(()=>expect(census).toBeGreaterThan(0));
    pane=change === 'dead-pane'?'$1|123|%1|45|1':'$1|123|%1|67|0';
    send(first,'I','never forward to changed provider');
    await vi.waitFor(()=>expect(controlIo.execute.mock.calls.filter(([,args])=>args.includes('release'))).toHaveLength(1));
    const second=await connect();send(second,'J',{sessionId:target.sessionId,attachOnly:true,cols:80,rows:24});
    await vi.waitFor(()=>expect(second.destroyed).toBe(true));
    expect(input).toHaveLength(0);expect(spawn).toHaveBeenCalledOnce();
    expect(controlIo.execute.mock.calls.filter(([,args])=>args.includes('close'))).toHaveLength(1);
    expect(commands.some(args=>args.some(word=>['stop','kill-session','respawn-pane','send-keys','new-session'].includes(word)))).toBe(false);
    expect(process.exitCode).toBe(oldExit);
  } finally {
    for(const socket of sockets)socket.destroy();shutdown?.();
    await vi.waitFor(()=>expect(existsSync(selected.socket)).toBe(false));
    signal.mockRestore();process.exitCode=oldExit;child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    rmSync(root,{recursive:true,force:true});
  }
});

it('retains its original nonce before a potentially-issued constructor throws and never dispatches twice', async () => {
  const port = cleanupPort();
  const owner = new ViewerAttachmentOwner(nonce, port);
  const dispatch = vi.fn(() => {
    throw new Error('late constructor failure');
  });
  expect(() => owner.start(dispatch)).toThrow(/late constructor/);
  expect(() => owner.start(dispatch)).toThrow(/already dispatched/);
  expect(dispatch).toHaveBeenCalledTimes(1);
  await owner.close();
  expect(owner.closed).toBe(true);
});
it('explicitly reconciles a lost CLOSED response by reading the same original owner, without another close effect', async () => {
  const port = cleanupPort();
  vi.mocked(port.close).mockRejectedValueOnce(new Error('lost original CLOSED reply'));
  const owner = startingOwner(nonce, port);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  const owners = new Set([owner]);
  await expect(owner.close()).rejects.toThrow(/unconfirmed/);
  expect(await reconcileOriginal(owners)).toBe(owner);
  expect(owner.closed).toBe(true);
  expect(owners.size).toBe(0);
  expect(port.close).toHaveBeenCalledTimes(1);
  expect(port.status).toHaveBeenCalledTimes(1);
  expect(port.release).toHaveBeenCalledTimes(1);
  await owner.close();
  expect(port.close).toHaveBeenCalledTimes(1);
});
it('reconciles lost release ACK only with prior CLOSED proof, original owner-exit DATA and fresh readback', async () => {
  const port = cleanupPort();
  vi.mocked(port.release).mockRejectedValueOnce(new Error('lost release ACK'));
  vi.mocked(port.status).mockRejectedValue(new Error('original endpoint closed'));
  const owner = startingOwner(nonce, port);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  await expect(owner.close()).rejects.toThrow(/unconfirmed/);
  await owner.reconcile();
  expect(owner.closed).toBe(true);
  expect(owner.endpointCleanup).toBe('unconfirmed');
  expect(port.exited).toHaveBeenCalledTimes(1);
  expect(port.release).toHaveBeenCalledTimes(1);
  expect(port.close).toHaveBeenCalledTimes(1);
});
it('allows the next explicit read-only reconcile immediately after a settled failed reconcile', async () => {
  const port = cleanupPort();
  vi.mocked(port.close).mockRejectedValueOnce(new Error('lost CLOSED reply'));
  vi.mocked(port.release).mockRejectedValueOnce(new Error('lost RELEASED reply'));
  vi.mocked(port.status)
    .mockResolvedValueOnce(`CLOSED ${nonce} 1234 ${birthWords}\n`)
    .mockRejectedValue(new Error('original endpoint gone'));
  const owner = startingOwner(nonce, port);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  await owner.close().catch(() => {});
  await owner.reconcile().catch(() => owner.reconcile());
  expect(owner.closed).toBe(true);
  expect(owner.endpointCleanup).toBe('unconfirmed');
  expect(port.close).toHaveBeenCalledTimes(1);
  expect(port.release).toHaveBeenCalledTimes(1);
  expect(port.status).toHaveBeenCalledTimes(1);
  expect(port.exited).toHaveBeenCalledTimes(1);
});
it('never repeats a possibly-issued RELEASE even when read-only STATUS could still return CLOSED', async () => {
  const port = cleanupPort();
  vi.mocked(port.release).mockRejectedValueOnce(new Error('release outcome unknown'));
  vi.mocked(port.exited).mockRejectedValue(new Error('Original owner is still present'));
  const owner = startingOwner(nonce, port);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  await owner.close().catch(() => {});
  await expect(owner.reconcile()).rejects.toThrow(/unconfirmed/);
  expect(owner.closed).toBe(false);
  expect(port.release).toHaveBeenCalledTimes(1);
  expect(port.status).not.toHaveBeenCalled();
  expect(port.exited).toHaveBeenCalledTimes(1);
});
it('never adopts bare absence or owner-exit DATA without an original actual CLOSED proof', async () => {
  const port = cleanupPort();
  vi.mocked(port.close).mockRejectedValue(new Error('no stopped proof'));
  vi.mocked(port.status).mockRejectedValue(new Error('ENOENT'));
  const owner = startingOwner(nonce, port);
  owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
  await expect(owner.close()).rejects.toThrow();
  await expect(owner.reconcile()).rejects.toThrow();
  expect(owner.closed).toBe(false);
  expect(port.exited).not.toHaveBeenCalled();
  expect(port.release).not.toHaveBeenCalled();
});
it('refuses malformed or overflowing kernel birth data before retaining an original receipt', () => {
  for (const words of [
    '4321 18446744073709551616 00000000-0000-4000-8000-000000000001 4026532000',
    '4321 99 00000000-0000-4000-8000-000000000001 18446744073709551616',
    `4321 99 ${'-'.repeat(36)} 4026532000`,
    '4321 099 00000000-0000-4000-8000-000000000001 4026532000',
  ])
    expect(() => parseReceipt('CLOSED', nonce, `CLOSED ${nonce} 1234 ${words}\n`)).toThrow();
  expect(
    parseReceipt(
      'CLOSED',
      nonce,
      `CLOSED ${nonce} 1234 4321 18446744073709551615 00000000-0000-4000-8000-000000000001 4026532000\n`
    ).owner.start
  ).toBe('18446744073709551615');
});
it.each(['owner-reused', 'boot-changed', 'namespace-changed', 'client-present', 'container-changed'])(
  'keeps a lost-release operation held for %s instead of borrowing successor facts',
  async (failure) => {
    const port = cleanupPort();
    vi.mocked(port.release).mockRejectedValueOnce(new Error('lost ACK'));
    vi.mocked(port.status).mockRejectedValue(new Error('gone'));
    const owner = startingOwner(nonce, port);
    owner.ready(`READY ${nonce} 1234 ${birthWords}\n`, '1234\n');
    await expect(owner.close()).rejects.toThrow();
    if (failure === 'owner-reused')
      vi.mocked(port.exited).mockResolvedValue(
        `EXITED ${nonce} 4321 100 00000000-0000-4000-8000-000000000001 4026532000\n`
      );
    if (failure === 'boot-changed' || failure === 'namespace-changed')
      vi.mocked(port.exited).mockRejectedValue(new Error('different kernel context'));
    if (failure === 'client-present') vi.mocked(port.clients).mockResolvedValue('1234\n');
    if (failure === 'container-changed')
      vi.mocked(port.assertOriginalContainer).mockRejectedValue(new Error('Original container incarnation changed'));
    await expect(owner.reconcile()).rejects.toThrow(/unconfirmed/);
    expect(owner.closed).toBe(false);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(port.release).toHaveBeenCalledTimes(1);
  }
);
import { Writable } from 'node:stream';
it('bounds post-ready native input buffering before another write and preserves backpressure', () => {
  let settle!: () => void;
  let writes = 0;
  const sink = new Writable({
    write(_bytes, _encoding, done) {
      writes++;
      settle = done;
    },
  });
  expect(writeBounded(sink, Buffer.alloc(1024 * 1024))).toBe(false);
  expect(() => writeBounded(sink, Buffer.alloc(1))).toThrow(/backpressure/);
  expect(writes).toBe(1);
  settle();
  sink.end();
});
import { pinnedUnixDocker } from '../scripts/lib/pinned-unix-docker.js';
it('resolves context precedence and pins every Docker call and child environment to the same Unix endpoint', () => {
  const source = { DOCKER_CONTEXT: 'fixture', DOCKER_HOST: 'tcp://ignored:2375' };
  const inspect = vi.fn(() => JSON.stringify('unix:///fixture/docker.sock'));
  const pin = pinnedUnixDocker(source, inspect);
  expect(inspect).toHaveBeenCalledWith([
    'context',
    'inspect',
    '--format',
    '{{json .Endpoints.docker.Host}}',
    '--',
    'fixture',
  ]);
  source.DOCKER_CONTEXT = 'successor';
  source.DOCKER_HOST = 'tcp://successor:2375';
  expect(pin.args(['inspect', target.containerId])).toEqual([
    '--host',
    'unix:///fixture/docker.sock',
    'inspect',
    target.containerId,
  ]);
  expect(pin.environment.DOCKER_CONTEXT).toBeUndefined();
  expect(pin.environment.DOCKER_HOST).toBe('unix:///fixture/docker.sock');
  expect(() => pinnedUnixDocker({ DOCKER_CONTEXT: 'remote' }, () => JSON.stringify('ssh://remote'))).toThrow(/Unix/);
  expect(() => pinnedUnixDocker({}, () => JSON.stringify('tcp://remote:2375'))).toThrow(/Unix/);
  expect(() => pinnedUnixDocker({ DOCKER_HOST: 'unix:///tmp/../other.sock' }, () => '')).toThrow(/Canonical/);
});
