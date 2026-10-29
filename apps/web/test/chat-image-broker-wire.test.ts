import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeChatImages } from '../src/chat-image-paths.js';

afterEach(() => vi.unstubAllEnvs());
describe('actual bounded image broker frames', () => {
  it('uses a private fixed socket and two closed M requests without a command channel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'image-wire-'));
    const path = join(root, 'b.sock');
    const sid = '11111111-1111-4111-8111-111111111111';
    const rid = '22222222-2222-4222-8222-222222222222';
    const mid = '33333333-3333-4333-8333-333333333333';
    const fid = '44444444-4444-4444-8444-444444444444';
    const local = '/tmp/.reverie-chat-images/55555555-5555-4555-8555-555555555555.png';
    const calls: Record<string, unknown>[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (part) => {
        buffer = Buffer.concat([buffer, part]);
        if (buffer.length < 5 || buffer.length < 5 + buffer.readUInt32BE(1)) return;
        expect(buffer[0]).toBe('M'.charCodeAt(0));
        const request = JSON.parse(buffer.subarray(5).toString('utf8')) as Record<string, unknown>;
        calls.push(request);
        const body = Buffer.from(
          JSON.stringify(
            request.action === 'binding'
              ? { version: 1, status: 'bound', sessionId: sid, generation: 'a'.repeat(64) }
              : {
                  version: 1,
                  status: 'ready',
                  sessionId: sid,
                  roomId: rid,
                  messageId: mid,
                  generation: 'a'.repeat(64),
                  files: [{ fileId: fid, path: local, bytes: 12, expiresInSeconds: 1800 }],
                }
          )
        );
        const header = Buffer.alloc(5);
        header[0] = 'J'.charCodeAt(0);
        header.writeUInt32BE(body.length, 1);
        socket.end(Buffer.concat([header, body]));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
      await chmod(path, 0o600);
      vi.stubEnv('REVERIE_WORKER_SOCKET', path);
      const result = await materializeChatImages({ sessionId: sid, roomId: rid, messageId: mid, fileIds: [fid] });
      expect(result.status).toBe('ready');
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.purpose === 'chat-image-paths-v1')).toBe(true);
      expect(JSON.stringify(calls)).not.toMatch(/command|token|http:|output/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
