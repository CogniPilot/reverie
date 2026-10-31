/** Real owned Unix sockets; only the kernel read-only mount projection and retry clock are controlled. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setImmediate as immediate } from 'node:timers/promises';
import { CompanyStateSchema, EmployeeSchema } from '../src/company-types.js';
import { HostResumeHandler, HostWorkerResumeStream } from '../src/host-worker-resume.js';
import type { SessionState } from '../src/types.js';

const EID = '11111111-1111-4111-8111-111111111111',
  SID = '22222222-2222-4222-8222-222222222222';
const OP = '44444444-4444-4444-8444-444444444444',
  NONCE = '55555555-5555-4555-8555-555555555555';
async function drain() {
  for (let i = 0; i < 12; i++) await immediate();
}
async function until(check: () => boolean) {
  const end = performance.now() + 2000;
  while (!check() && performance.now() < end) await immediate();
  expect(check()).toBe(true);
  await drain();
}
function request(handler: HostResumeHandler) {
  return {
    kind: 'wake',
    nonce: NONCE,
    expiresAtEpochMs: Date.now() + 60_000,
    operationId: OP,
    employee: handler.snapshot()[0],
  };
}
function send(socket: net.Socket, value: unknown) {
  const raw = Buffer.from(JSON.stringify(value)),
    head = Buffer.alloc(4);
  head.writeUInt32BE(raw.length);
  socket.write(Buffer.concat([head, raw]));
}
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hrr-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 's');
  let readonly = true;
  const employee = EmployeeSchema.parse({
    id: EID,
    sessionId: SID,
    sessionGeneration: 1,
    name: 'Fixture',
    owner: 'fixture',
    icon: 'x',
    position: 'Expert',
    expertise: ['systems'],
    createdAt: 1,
    desiredRunning: true,
    runtimeRecipe: { mode: 'claude', workingDir: '/workspace' },
  });
  const state = CompanyStateSchema.parse({ version: 1, employees: [employee], settings: [], cycles: [], memories: [] });
  const saved = {
    id: SID,
    owner: 'fixture',
    mode: 'claude',
    workingDir: '/workspace',
    status: 'idle',
    pid: null,
  } as SessionState;
  const wake = vi.fn(async () => ({ awakened: [EID], skipped: [] }));
  const handler = new HostResumeHandler({ company: () => state, saved: () => saved, live: () => false, wake });
  const servers: net.Server[] = [],
    peers = new Set<net.Socket>();
  let accepted = 0,
    registrations = 0,
    results = 0;
  async function listen(callback: (socket: net.Socket) => void) {
    const server = net.createServer((socket) => {
      accepted++;
      peers.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => peers.delete(socket));
      let bytes = Buffer.alloc(0),
        registered = false;
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (!registered) {
          if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt32BE(1)) return;
          expect(bytes[0]).toBe('Y'.charCodeAt(0));
          const n = bytes.readUInt32BE(1);
          expect(JSON.parse(bytes.subarray(5, 5 + n).toString())).toEqual({
            version: 1,
            purpose: 'host-worker-resume-v1',
            kind: 'register',
          });
          bytes = bytes.subarray(5 + n);
          registered = true;
          registrations++;
          callback(socket);
        }
        while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32BE(0)) {
          const n = bytes.readUInt32BE(0),
            value = JSON.parse(bytes.subarray(4, 4 + n).toString());
          bytes = bytes.subarray(4 + n);
          if (value.kind === 'result') results++;
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    fs.chmodSync(socketPath, 0o600);
  }
  const originalOpen = fs.openSync,
    originalRead = fs.readSync,
    originalClose = fs.closeSync,
    readers = new Map<number, number>();
  vi.spyOn(fs, 'openSync').mockImplementation(((name: fs.PathLike, ...args: unknown[]) => {
    if (name === '/proc/self/mountinfo') {
      const fd = originalOpen('/dev/null', 'r');
      readers.set(fd, 0);
      return fd;
    }
    return (originalOpen as (...a: unknown[]) => number)(name, ...args);
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'readSync').mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: unknown
  ) => {
    if (readers.has(fd)) {
      const raw = Buffer.from(`40 20 0:20 / ${directory} ${readonly ? 'ro' : 'rw'},nosuid - tmpfs tmpfs rw\n`),
        start = readers.get(fd)!;
      const count = Math.min(length, raw.length - start);
      raw.copy(buffer, offset, start, start + count);
      readers.set(fd, start + count);
      return count;
    }
    return (originalRead as (...a: unknown[]) => number)(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    readers.delete(fd);
    originalClose(fd);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const stream = new HostWorkerResumeStream(socketPath, handler);
  async function tick() {
    await vi.advanceTimersByTimeAsync(5000);
    await drain();
  }
  async function exhaust() {
    for (let i = 1; i <= 120; i++) {
      if (i === 1) stream.start();
      else await tick();
      await until(() => registrations === i && peers.size === 0);
    }
  }
  return {
    directory,
    socketPath,
    handler,
    wake,
    stream,
    listen,
    tick,
    exhaust,
    accepted: () => accepted,
    registrations: () => registrations,
    results: () => results,
    peers,
    readonly: (value: boolean) => {
      readonly = value;
    },
    async close() {
      stream.close();
      for (const peer of peers) peer.destroy();
      vi.useRealTimers();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      vi.restoreAllMocks();
      fs.rmSync(directory, { recursive: true });
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native resume registration retry budget follows the trusted socket incarnation', () => {
  it('stops at120 on the same socket, then registers a replaced socket without restarting the stream', async () => {
    const f = await fixture();
    try {
      await f.listen((socket) => socket.destroy());
      await f.exhaust();
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.accepted()).toBe(120);
      // Parent permission changes are custody changes, not a new broker socket.
      fs.chmodSync(f.directory, 0o500);
      await f.tick();
      fs.chmodSync(f.directory, 0o700);
      await f.tick();
      expect(f.accepted()).toBe(120);
      fs.renameSync(f.socketPath, f.socketPath + '.old');
      await f.listen((socket) => socket.destroy());
      for (let i = 121; i <= 240; i++) {
        await f.tick();
        await until(() => f.registrations() === i && f.peers.size === 0);
      }
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.accepted()).toBe(240);
      fs.renameSync(f.socketPath, f.socketPath + '.second');
      await f.listen((socket) => socket.write('HOST_RESUME_READY\n'));
      await f.tick();
      await until(() => f.registrations() === 241);
      expect(f.wake).not.toHaveBeenCalled();
      f.stream.close();
      for (const peer of f.peers) peer.destroy();
      await drain();
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.accepted()).toBe(241);
    } finally {
      await f.close();
    }
  });
  it('does not renew an exhausted budget for missing, regular, symlink, wrong-mode or writable-mount replacements', async () => {
    const f = await fixture();
    try {
      await f.listen((socket) => socket.destroy());
      await f.exhaust();
      fs.renameSync(f.socketPath, f.socketPath + '.old');
      await f.tick();
      fs.writeFileSync(f.socketPath, 'not a socket');
      await f.tick();
      fs.unlinkSync(f.socketPath);
      fs.symlinkSync(f.socketPath + '.old', f.socketPath);
      await f.tick();
      fs.unlinkSync(f.socketPath);
      await f.listen((socket) => socket.write('HOST_RESUME_READY\n'));
      fs.chmodSync(f.socketPath, 0o666);
      await f.tick();
      fs.chmodSync(f.socketPath, 0o600);
      f.readonly(false);
      await f.tick();
      expect(f.accepted()).toBe(120);
      f.readonly(true);
      await f.tick();
      await until(() => f.registrations() === 121);
    } finally {
      await f.close();
    }
  });
  it('does not reconnect while a normal wake is in flight and keeps the consumed operation after reconnection', async () => {
    const f = await fixture();
    let release!: () => void;
    let started = false;
    const req = request(f.handler);
    f.wake.mockImplementation(async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { awakened: [EID], skipped: [] };
    });
    try {
      await f.listen((socket) => {
        socket.write('HOST_RESUME_READY\n');
        send(socket, req);
      });
      f.stream.start();
      await until(() => started);
      fs.renameSync(f.socketPath, f.socketPath + '.old');
      for (const peer of f.peers) peer.destroy();
      await drain();
      await f.listen((socket) => {
        socket.write('HOST_RESUME_READY\n');
        send(socket, req);
      });
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.accepted()).toBe(1);
      release();
      await drain();
      await f.tick();
      await until(() => f.registrations() === 2);
      await until(() => f.peers.size === 0);
      expect(f.wake).toHaveBeenCalledOnce();
      expect(f.results()).toBe(0);
    } finally {
      release?.();
      await f.close();
    }
  });
});
