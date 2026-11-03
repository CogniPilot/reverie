import { describe, expect, it } from 'vitest';
import { localImageFiles, materializeChatImages } from '../src/chat-image-paths.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const roomId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const fileId = '44444444-4444-4444-8444-444444444444';
const path = '/tmp/.reverie-chat-images/55555555-5555-4555-8555-555555555555.png';
const scope = { sessionId, roomId, messageId, fileIds: [fileId] };
const file = { fileId, path, bytes: 16, expiresInSeconds: 1800 };
const ready = { version: 1, status: 'ready', sessionId, roomId, messageId, generation: 'a'.repeat(64), files: [file] };

describe('fixed scoped image broker client', () => {
  it('binds first, then sends only scoped identities and the observed generation', async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await materializeChatImages(scope, async (value) => {
      calls.push(value);
      return calls.length === 1 ? { version: 1, status: 'bound', sessionId, generation: ready.generation } : ready;
    });
    expect(result).toEqual({ status: 'ready', generation: ready.generation, files: [file] });
    expect(calls).toEqual([
      { purpose: 'chat-image-paths-v1', action: 'binding', sessionId },
      {
        purpose: 'chat-image-paths-v1',
        action: 'materialize',
        sessionId,
        request: { version: 1, ...scope, generation: ready.generation },
      },
    ]);
  });

  it.each([
    { sessionId: roomId },
    { roomId: sessionId },
    { messageId: roomId },
    { generation: 'b'.repeat(64) },
    { files: [{ ...file, path: '/reverie_workspace/attachments/private.png' }] },
    { files: [{ ...file, path: path + '/../../private' }] },
    { files: [{ ...file, bytes: 8388609 }] },
    { files: [{ ...file, expiresInSeconds: 1801 }] },
    { files: [{ ...file, fileId: roomId }] },
    { files: [file, file] },
  ])('refuses mismatched identity, generation or unsafe result %j', async (change) => {
    let count = 0;
    expect(
      await materializeChatImages(scope, async () =>
        ++count === 1
          ? { version: 1, status: 'bound', sessionId, generation: ready.generation }
          : { ...ready, ...change }
      )
    ).toEqual({ status: 'unavailable' });
  });

  it('does not echo transport errors or call a broker for malformed IDs', async () => {
    let calls = 0;
    const exchange = async () => {
      calls++;
      throw new Error('/private/credential-value');
    };
    expect(await materializeChatImages({ ...scope, sessionId: '../other' }, exchange)).toEqual({
      status: 'unavailable',
    });
    expect(calls).toBe(0);
    expect(await materializeChatImages(scope, exchange)).toEqual({ status: 'unavailable' });
    expect(calls).toBe(1);
  });

  it('the CLI revalidates paths instead of trusting server-provided attachment names', () => {
    expect(localImageFiles(ready, [fileId])).toEqual([file]);
    expect(localImageFiles({ ...ready, files: [{ ...file, path: '/private/secret' }] }, [fileId])).toEqual([]);
    expect(localImageFiles(ready, [roomId])).toEqual([]);
  });
});
