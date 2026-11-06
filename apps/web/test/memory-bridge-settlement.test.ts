import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { runMemoryBridge } from '../src/memory-bridge-process.js';
import { createMcpServer, runMcpStdio } from '../src/mcp-server.js';

const delayedChild = `import {writeFileSync} from 'node:fs';
  process.stdin.resume();
  const held=setInterval(()=>{},1000);
  process.on('SIGTERM',()=>{clearInterval(held);setTimeout(()=>{writeFileSync(process.env.FINISHED,'closed');process.exit(0)},150)});
  writeFileSync(process.env.STARTED,'started');`;

const stubbornChild = `import {writeFileSync,existsSync} from 'node:fs';
  process.stdin.resume();
  process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
  process.on('SIGTERM',()=>writeFileSync(process.env.TERMINATED,'term'));
  setInterval(()=>{if(existsSync(process.env.RELEASE))process.exit(0)},10);
  writeFileSync(process.env.STARTED,'started');
  if(process.env.OVERFLOW)process[process.env.OVERFLOW].write('x'.repeat(1024*1024+4096));`;

async function waitFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await delay(5);
    }
  }
  throw new Error('Owned child did not reach its setup marker');
}

describe('memory child settlement', () => {
  it('refuses late zero exit when the bridge deadline callback is delayed until after actual close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reverie-memory-delayed-timer-'));
    const started = join(root, 'started');
    const finished = join(root, 'finished');
    // Only the bridge's global timer is held. Node execFile retains its own
    // internal timer, and the child and monotonic clock remain real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const began = performance.now();
    const work = runMemoryBridge(process.execPath, ['--input-type=module', '-e', delayedChild], {
      env: { STARTED: started, FINISHED: finished },
      input: '{}',
      timeoutMs: 1_500,
    });
    try {
      expect(vi.getTimerCount()).toBe(1);
      await waitFile(started);
      const result = await work;
      expect(performance.now() - began).toBeGreaterThanOrEqual(1_500);
      expect(await readFile(finished, 'utf8')).toBe('closed');
      expect(result.code, 'acceptance must recheck the original clock without a timer callback').not.toBe(0);
    } finally {
      vi.useRealTimers();
      await work;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the first timeout cleanup budget when an external abort arrives later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reverie-memory-first-stop-'));
    const started = join(root, 'started');
    const terminated = join(root, 'terminated');
    const release = join(root, 'release');
    const controller = new AbortController();
    const work = runMemoryBridge(process.execPath, ['--input-type=module', '-e', stubbornChild], {
      env: { STARTED: started, TERMINATED: terminated, RELEASE: release },
      input: '{}',
      timeoutMs: 1_500,
      signal: controller.signal,
    });
    try {
      await waitFile(started);
      await waitFile(terminated);
      await delay(1_500);
      controller.abort();
      const result = await Promise.race([work, delay(1_200).then(() => undefined)]);
      expect(result, 'a later abort cannot restart the original two-second cleanup budget').toBeDefined();
      expect(result!.code).not.toBe(0);
    } finally {
      await writeFile(release, 'fixture cleanup');
      await work;
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);

  it('refuses a timed-out result even when the cooperative child eventually exits zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reverie-memory-timeout-result-'));
    const started = join(root, 'started');
    const finished = join(root, 'finished');
    const work = runMemoryBridge(process.execPath, ['--input-type=module', '-e', delayedChild], {
      env: { STARTED: started, FINISHED: finished },
      input: '{}',
      timeoutMs: 1_500,
    });
    try {
      await waitFile(started);
      const result = await work;
      expect(result.code).not.toBe(0);
      expect(await readFile(finished, 'utf8')).toBe('closed');
    } finally {
      await work;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['timeout', 'stdout', 'stderr'])(
    'settles an ordinary %s without external abort when the real child ignores SIGTERM',
    async (reason) => {
      const root = await mkdtemp(join(tmpdir(), 'reverie-memory-stubborn-'));
      const started = join(root, 'started');
      const terminated = join(root, 'terminated');
      const release = join(root, 'release');
      const work = runMemoryBridge(process.execPath, ['--input-type=module', '-e', stubbornChild], {
        env: {
          STARTED: started,
          TERMINATED: terminated,
          RELEASE: release,
          ...(reason === 'timeout' ? {} : { OVERFLOW: reason }),
        },
        input: '{}',
        timeoutMs: reason === 'timeout' ? 1_500 : 20_000,
      });
      try {
        await waitFile(started);
        const result = await Promise.race([work, delay(6_000).then(() => undefined)]);
        expect(result, 'cleanup must escalate without waiting for the execFile completion callback').toBeDefined();
        expect(result!.code).not.toBe(0);
        expect(await readFile(terminated, 'utf8')).toBe('term');
      } finally {
        // The original broken path also joins its actual child on failure.
        // An owned release file avoids signalling a potentially reused PID.
        await writeFile(release, 'fixture cleanup');
        await work;
        await rm(root, { recursive: true, force: true });
      }
    },
    12_000
  );

  it('waits for the actual aborting child close rather than the earlier execFile callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reverie-memory-child-'));
    const controller = new AbortController();
    const started = join(root, 'started');
    const finished = join(root, 'finished');
    const work = runMemoryBridge(process.execPath, ['--input-type=module', '-e', delayedChild], {
      env: { STARTED: started, FINISHED: finished },
      input: '{}',
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    try {
      await waitFile(started);
      controller.abort();
      const result = await work;
      expect(result.code).not.toBe(0);
      // The child writes only immediately before exit. Node's AbortError
      // callback precedes this marker; the actual close must follow it.
      expect(await readFile(finished, 'utf8')).toBe('closed');
    } finally {
      controller.abort();
      await work;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps MCP shutdown pending until the cancelled memory runner really settles', async () => {
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const messages: unknown[] = [];
    const server = createMcpServer({
      config: { version: 'test', allowAnySession: false },
      write: (message) => messages.push(message),
      modes: ['shell'],
      memory: { instance: '/owned/synthetic/config.json', python: '/unused', source: '/unused' },
      memoryRunner: async (_program, _args, options) => {
        signal = options.signal;
        started();
        await held;
        return { stdout: '[]', stderr: '', code: 0 };
      },
    });
    const call = server.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_recall', arguments: { query: 'synthetic' } },
      })
    );
    await began;
    server.close();
    expect(signal?.aborted).toBe(true);
    let settled = false;
    const waiting = server.settled().then(() => {
      settled = true;
    });
    await delay(10);
    expect(settled).toBe(false);
    release();
    await Promise.all([call, waiting]);
    expect(settled).toBe(true);
    expect(messages).toEqual([]);
  });

  it.each([false, true])('keeps protocol replies with an optional quiet logger (quiet=%s)', async (quiet) => {
    const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    const work = runMcpStdio({ version: 'owned-stdio', allowAnySession: false }, io, {
      memory: { python: '/unused', source: '/unused' },
      ...(quiet ? { log: () => {} } : {}),
    });
    io.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    io.stdin.write('{not json}\n');
    io.stdin.end();
    await work;
    const messages = String(io.stdout.read())
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages[0].result.serverInfo.name).toBe('reverie');
    expect(messages[1].error.code).toBe(-32700);
    if (quiet) expect(io.stderr.read()).toBeNull();
    else expect(String(io.stderr.read())).toContain('reverie mcp owned-stdio:');
  });

  it('quiet stdio EOF still waits for an actual cancelling child and releases no cancelled reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reverie-memory-stdio-child-'));
    const started = join(root, 'started');
    const finished = join(root, 'finished');
    const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    const work = runMcpStdio({ version: 'owned-stdio', allowAnySession: false }, io, {
      log: () => {},
      memory: { instance: '/owned/synthetic/config.json', python: '/unused', source: '/unused' },
      memoryRunner: (_program, _args, options) =>
        runMemoryBridge(process.execPath, ['--input-type=module', '-e', delayedChild], {
          env: { STARTED: started, FINISHED: finished },
          input: options.input,
          timeoutMs: 10_000,
          signal: options.signal,
        }),
    });
    try {
      io.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'memory_recall', arguments: { query: 'synthetic' } },
        }) + '\n'
      );
      await waitFile(started);
      io.stdin.end();
      let settled = false;
      const waiting = work.then(() => {
        settled = true;
      });
      await delay(10);
      expect(settled).toBe(false);
      await waiting;
      expect(await readFile(finished, 'utf8')).toBe('closed');
      expect(io.stdout.read()).toBeNull();
      expect(io.stderr.read()).toBeNull();
    } finally {
      io.stdin.end();
      await work;
      await rm(root, { recursive: true, force: true });
    }
  });
});
