import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { materializeChatImages, type ImagePathResult } from '../src/chat-image-paths.js';
vi.mock('../src/chat-image-paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/chat-image-paths.js')>()),
  materializeChatImages: vi.fn(),
}));
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const LOCAL = '/tmp/.reverie-chat-images/44444444-4444-4444-8444-444444444444.png';
const ready: ImagePathResult = {
  status: 'ready',
  generation: 'a'.repeat(64),
  files: [{ fileId: FILE, path: LOCAL, bytes: 12, expiresInSeconds: 1800 }],
};

describe('message-scoped image paths', () => {
  let directory: string;
  let service: ChatroomService;
  let employee = 'employee-fixture';
  const sessions = new Map(
    [SID, OTHER].map((id) => [
      id,
      { id, name: 'Agent', pid: 42, isWorking: true, mode: 'codex', writeViaMux: async () => true },
    ])
  );
  beforeEach(async () => {
    vi.mocked(materializeChatImages).mockReset().mockResolvedValue(ready);
    employee = 'employee-fixture';
    directory = mkdtempSync(join(tmpdir(), 'chat-images-'));
    service = new ChatroomService({
      file: join(directory, 'rooms.json'),
      getSession: (id) => sessions.get(id),
      employeeOf: () => employee,
      broadcast: () => {},
    });
    await service.init();
    service.delivery.stop();
  });
  afterEach(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  function fixture() {
    const room = service.createRoom('Images', undefined);
    service.addMember(room.id, SID);
    const message = service.post(room.id, { kind: 'user', name: 'owner' }, 'See chart', 'all', {
      deliver: false,
      attachments: [
        { id: FILE, name: '../../server-name.png', path: '/private/server/file', type: 'image/png', size: 12 },
      ],
    });
    return { room, message };
  }
  it('selects exact message attachment IDs server-side, with no caller paths or URLs', async () => {
    const { room, message } = fixture();
    expect(await service.agentImagePaths(SID, room.id, message.id)).toEqual(ready);
    expect(materializeChatImages).toHaveBeenCalledWith({
      sessionId: SID,
      roomId: room.id,
      messageId: message.id,
      fileIds: [FILE],
    });
  });
  it('refuses non-members before contacting the broker', async () => {
    const { room, message } = fixture();
    await expect(service.agentImagePaths(OTHER, room.id, message.id)).rejects.toThrow();
    expect(materializeChatImages).not.toHaveBeenCalled();
  });
  it.each(['revoke', 'delete', 'employee'] as const)(
    'does not return READY after %s changes during fetch',
    async (kind) => {
      const { room, message } = fixture();
      let resolve!: (result: ImagePathResult) => void;
      vi.mocked(materializeChatImages).mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          })
      );
      const pending = service.agentImagePaths(SID, room.id, message.id);
      if (kind === 'revoke') service.removeMember(room.id, SID);
      if (kind === 'delete') await service.deleteMessage(room.id, message.id, 'owner');
      if (kind === 'employee') employee = 'replacement-employee';
      resolve(ready);
      await expect(pending).rejects.toThrow();
    }
  );
  it('the actual HTTP route uses the authenticated caller, rejects arguments and requires membership', async () => {
    const { room, message } = fixture();
    const { app } = await createRouteTestHarness((fastify, context) => {
      for (const id of [SID, OTHER]) context.sessions.set(id, createMockSession(id));
      registerChatroomRoutes(fastify, context, service, new ChatFileStore(directory), trustedFixtureOwner);
    });
    const url = `/api/chatrooms/${room.id}/messages/${message.id}/image-paths`;
    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-reverie-parent-session': SID },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.files[0].path).toBe(LOCAL);
      expect(
        (await app.inject({ method: 'POST', url, headers: { 'x-reverie-parent-session': OTHER }, payload: {} }))
          .statusCode
      ).not.toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { 'x-reverie-parent-session': SID },
            payload: { sessionId: OTHER, path: '/arbitrary' },
          })
        ).statusCode
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
