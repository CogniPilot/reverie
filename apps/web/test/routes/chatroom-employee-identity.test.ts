import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import type { ChatMessage } from '../../src/chatroom-store.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { createMockSession, safeRmHomeTree } from '../mocks/index.js';
import { createRouteTestHarness } from './_route-test-utils.js';

const OLD = '0000002d-0035-4000-8000-000000000047';
const NEXT = '00000038-0043-4000-8000-000000000060';
const EMPLOYEE = 'employee-one';
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

describe('employee identity on the chat HTTP representations', () => {
  it('returns authoritative post ids and enriches legacy history, pins and exact reads after a move', async () => {
    const directory = mkdtempSync(join(homedir(), 'chat-employee-route-'));
    const bindings = new Map([[OLD, EMPLOYEE]]);
    let service: ChatroomService;
    const harness = await createRouteTestHarness((app, context) => {
      service = new ChatroomService({ file: join(directory, 'rooms.json'), getSession: (sessionId) => context.sessions.get(sessionId), employeeOf: (sessionId) => bindings.get(sessionId), broadcast: () => {} });
      registerChatroomRoutes(app, context, service, new ChatFileStore(join(directory, 'files')));
    });
    cleanup.push(async () => {
      await service.stop();
      await harness.app.close();
      safeRmHomeTree(directory);
    });
    for (const sessionId of [OLD, NEXT]) harness.ctx.sessions.set(sessionId, createMockSession(sessionId) as never);
    const room = service!.createRoom('Identity', undefined);
    service!.addMember(room.id, OLD, {});
    const response = await harness.app.inject({ method: 'POST', url: `/api/chatrooms/${room.id}/messages`, headers: { 'x-reverie-parent-session': OLD }, payload: { text: 'New post' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.message.from.employeeId).toBe(EMPLOYEE);
    const legacy: ChatMessage = { id: 'legacy', roomId: room.id, at: 1, from: { kind: 'agent', sessionId: OLD, name: 'Old signature' }, text: 'Before the migration', to: 'all', pinned: { at: 2, by: 'Owner', kind: 'user' } };
    room.messages.unshift(legacy);
    bindings.delete(OLD);
    bindings.set(NEXT, EMPLOYEE);
    await service!.replaceSession(OLD, NEXT, 'Owner', () => true);
    harness.ctx.sessions.delete(OLD);
    for (const suffix of ['', '/messages']) {
      const read = await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${room.id}${suffix}`, headers: { 'x-reverie-parent-session': NEXT } });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.messages.find((entry: ChatMessage) => entry.id === legacy.id).from).toEqual({ ...legacy.from, employeeId: EMPLOYEE });
    }
    const pins = await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${room.id}/pins`, headers: { 'x-reverie-parent-session': NEXT } });
    expect(pins.statusCode).toBe(200);
    expect(pins.json().data.pins[0].from.employeeId).toBe(EMPLOYEE);
    const exact = await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${room.id}/messages/${legacy.id}`, headers: { 'x-reverie-parent-session': NEXT } });
    expect(exact.statusCode).toBe(200);
    expect(exact.json().data.message.from.employeeId).toBe(EMPLOYEE);
    expect(legacy.from).not.toHaveProperty('employeeId');
  });
});
