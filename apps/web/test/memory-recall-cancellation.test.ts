/** Actual HTTP cancellation through ordinary in-process MCP memory recall.
 * The private SQLite fixture is retained byte-for-byte; no injected fetch or clock. */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp-server.js';
import { build, fixture } from './legacy-store-fixture.js';

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        // Cancellation must settle before the unchanged embedding timeout (10s).
        timer = setTimeout(() => reject(new Error('Actual memory cancellation did not settle')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const operation of ['request cancellation', 'server shutdown'] as const) {
  it(`${operation} closes the real embedding request, settles the reader and releases no memory`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cancel-')));
    const originalEmbedUrl = process.env.REVERIE_EMBED_URL;
    let received!: () => void;
    let disconnected!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const requestClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const embedding = http.createServer((request, response) => {
      request.resume();
      response.once('close', disconnected);
      received();
      // Deliberately leave this real request pending until the client cancels.
    });
    let server: ReturnType<typeof createMcpServer> | undefined;
    let work: Promise<void> | undefined;
    try {
      const sample = fixture.cases.find((item) => item.id === 'private-service-embedder')!;
      expect(sample.private).toBeDefined();
      const database = path.join(root, 'state', 'memory.sqlite');
      await build(database, sample.schema, sample.private!, sample.columns, sample.state);
      const original = fs.readFileSync(database);
      const config = path.join(root, 'instance.json');
      fs.writeFileSync(
        config,
        JSON.stringify({
          ...sample.instance,
          data_dir: path.join(root, 'state'),
        })
      );
      await new Promise<void>((resolve, reject) => {
        embedding.once('error', reject);
        embedding.listen(0, '127.0.0.1', resolve);
      });
      process.env.REVERIE_EMBED_URL = `http://127.0.0.1:${(embedding.address() as AddressInfo).port}/v1`;
      const messages: Array<Record<string, unknown>> = [];
      server = createMcpServer({
        config: {
          allowAnySession: false,
          version: 'actual-memory-cancellation',
        },
        memory: { instance: config },
        write: (message) => messages.push(message),
      });
      work = server.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'memory_recall',
            arguments: { query: 'synthetic fixture memory' },
          },
        })
      );
      await bounded(requestReceived);
      expect(server.inflightCount()).toBe(1);
      if (operation === 'request cancellation') {
        await server.handleLine(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 1 },
          })
        );
      } else server.close();
      await bounded(Promise.all([work, server.settled(), requestClosed]));
      expect(server.inflightCount()).toBe(0);
      expect(messages).toEqual([]);
      expect(fs.readFileSync(database).equals(original)).toBe(true);
      expect(fs.readdirSync(path.dirname(database))).toEqual(['memory.sqlite']);
    } finally {
      server?.close();
      try {
        embedding.closeAllConnections();
        const closing = new Promise<void>((resolve, reject) => {
          if (!embedding.listening) return resolve();
          embedding.close((error) => (error ? reject(error) : resolve()));
        });
        const settled = await Promise.allSettled([closing, work, server?.settled()]);
        const failures = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
        if (failures.length) throw new AggregateError(failures, 'Memory cancellation fixture finalization failed');
      } finally {
        if (originalEmbedUrl === undefined) delete process.env.REVERIE_EMBED_URL;
        else process.env.REVERIE_EMBED_URL = originalEmbedUrl;
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
}
