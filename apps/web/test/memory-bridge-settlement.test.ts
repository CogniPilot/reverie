import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runMemoryBridge } from '../src/memory-bridge-process.js';
import { createMcpServer } from '../src/mcp-server.js';

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
  it('waits for the actual aborting child close rather than the earlier execFile callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reverie-memory-child-'));
    const controller = new AbortController();
    const started = join(root, 'started');
    const finished = join(root, 'finished');
    const source = `import {writeFileSync} from 'node:fs';
      process.stdin.resume();
      const held=setInterval(()=>{},1000);
      process.on('SIGTERM',()=>{clearInterval(held);setTimeout(()=>{writeFileSync(process.env.FINISHED,'closed');process.exit(0)},150)});
      writeFileSync(process.env.STARTED,'started');`;
    const work = runMemoryBridge(process.execPath, ['--input-type=module', '-e', source], {
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
});
