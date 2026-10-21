import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { messageWithEmployeeIdentity, stampEmployeeSender, type ChatIdentityLookup } from '../src/chat-message-identity.js';
import { ChatroomService } from '../src/chatroom-service.js';
import type { ChatMessage, ChatSender } from '../src/chatroom-store.js';
import { safeRmHomeTree } from './mocks/index.js';

const OWNER = 'owner-one';
const EMPLOYEE = 'employee-one';
const OLD = '0000002d-0035-4000-8000-000000000047';
const NEXT = '00000038-0043-4000-8000-000000000060';
const CURRENT = '0000003e-004c-4000-8000-00000000006f';
const sender = (sessionId = OLD): ChatSender => ({ kind: 'agent', sessionId, name: 'Original name' });
const message = (from = sender()): ChatMessage => ({ id: 'old-message', roomId: 'room', at: 1, from, text: 'Hello', to: 'all' });

describe('authoritative employee message identity', () => {
  let lookup: ChatIdentityLookup;
  let sessions: Map<string, { owner?: string }>;
  let bindings: Map<string, string>;

  beforeEach(() => {
    sessions = new Map([[CURRENT, { owner: OWNER }]]);
    bindings = new Map([[CURRENT, EMPLOYEE]]);
    lookup = { getSession: (sessionId) => sessions.get(sessionId), employeeOf: (sessionId) => bindings.get(sessionId), retired: [] };
  });

  it('stamps only the current binding, replacing a caller-supplied employee id', () => {
    const original = { ...sender(CURRENT), employeeId: 'forged' } as ChatSender;
    expect(stampEmployeeSender(original, OWNER, lookup)).toEqual({ ...sender(CURRENT), employeeId: EMPLOYEE });
    expect(original).toHaveProperty('employeeId', 'forged');
    expect(stampEmployeeSender({ ...sender(OLD), employeeId: 'forged' } as ChatSender, OWNER, lookup)).toEqual(sender(OLD));
  });

  it('does not stamp another owner or a stale employee binding without a session', () => {
    bindings.set(OLD, EMPLOYEE);
    expect(stampEmployeeSender(sender(OLD), OWNER, lookup)).not.toHaveProperty('employeeId');
    expect(stampEmployeeSender(sender(CURRENT), 'other-owner', lookup)).not.toHaveProperty('employeeId');
  });

  it('resolves a multi-hop retired chain without mutating the historical message or session id', () => {
    lookup.retired = [{ sessionId: OLD, successorId: NEXT, owner: OWNER }, { sessionId: NEXT, successorId: CURRENT, owner: OWNER }];
    const original = message();
    const result = messageWithEmployeeIdentity(original, OWNER, lookup);
    expect(result.from).toEqual({ ...sender(), employeeId: EMPLOYEE });
    expect(original.from).not.toHaveProperty('employeeId');
    expect(result.id).toBe(original.id);
    expect(result.to).toEqual(original.to);
  });

  it('resolves an unstamped current-session message', () => {
    expect(messageWithEmployeeIdentity(message(sender(CURRENT)), OWNER, lookup).from).toHaveProperty('employeeId', EMPLOYEE);
  });

  it('keeps a stamped employee identity after the session is gone or rebound', () => {
    const original = message({ ...sender(CURRENT), employeeId: EMPLOYEE } as ChatSender);
    sessions.clear();
    bindings.set(CURRENT, 'replacement-employee');
    expect(messageWithEmployeeIdentity(original, OWNER, lookup)).toBe(original);
  });

  it('refuses cross-owner retired links, terminal sessions and unowned links in owned rooms', () => {
    for (const owner of ['other-owner', undefined]) {
      lookup.retired = [{ sessionId: OLD, successorId: CURRENT, owner }];
      expect(messageWithEmployeeIdentity(message(), OWNER, lookup).from).not.toHaveProperty('employeeId');
    }
    lookup.retired = [{ sessionId: OLD, successorId: CURRENT, owner: OWNER }];
    sessions.set(CURRENT, { owner: 'other-owner' });
    expect(messageWithEmployeeIdentity(message(), OWNER, lookup).from).not.toHaveProperty('employeeId');
    sessions.set(CURRENT, { owner: OWNER });
    sessions.set(OLD, { owner: 'other-owner' });
    expect(messageWithEmployeeIdentity(message(), OWNER, lookup).from).not.toHaveProperty('employeeId');
  });

  it('supports the single-owner undefined scope without widening an owned room', () => {
    sessions.set(CURRENT, {});
    lookup.retired = [{ sessionId: OLD, successorId: CURRENT }];
    expect(messageWithEmployeeIdentity(message(), undefined, lookup).from).toHaveProperty('employeeId', EMPLOYEE);
    expect(messageWithEmployeeIdentity(message(), OWNER, lookup).from).not.toHaveProperty('employeeId');
  });

  it('fails closed on cycles, duplicate links, missing successors and overlong chains', () => {
    const cases = [
      [{ sessionId: OLD, successorId: NEXT, owner: OWNER }, { sessionId: NEXT, successorId: OLD, owner: OWNER }],
      [{ sessionId: OLD, successorId: CURRENT, owner: OWNER }, { sessionId: OLD, successorId: NEXT, owner: OWNER }],
      [{ sessionId: OLD, successorId: 'missing', owner: OWNER }],
      [{ sessionId: OLD, successorId: '', owner: OWNER }],
      Array.from({ length: 257 }, (_, index) => ({ sessionId: index ? `step-${index}` : OLD, successorId: index === 256 ? CURRENT : `step-${index + 1}`, owner: OWNER })),
    ];
    for (const retired of cases) {
      lookup.retired = retired;
      expect(messageWithEmployeeIdentity(message(), OWNER, lookup).from).not.toHaveProperty('employeeId');
    }
  });

  it('keeps temporary agents, user messages and bot identities unchanged', () => {
    const temporary = message();
    expect(messageWithEmployeeIdentity(temporary, OWNER, lookup)).toBe(temporary);
    for (const from of [{ kind: 'user', name: 'Owner' }, { kind: 'bot', name: 'Bot', botId: 'bot' }, { kind: 'system', name: 'system', sessionId: CURRENT }] as ChatSender[]) {
      expect(stampEmployeeSender(from, OWNER, lookup)).toBe(from);
      const original = message(from);
      expect(messageWithEmployeeIdentity(original, OWNER, lookup)).toBe(original);
    }
  });

  it('does not guess legacy identity from a stale company binding without a session or retired link', () => {
    bindings.set(OLD, EMPLOYEE);
    const original = message();
    expect(messageWithEmployeeIdentity(original, OWNER, lookup)).toBe(original);
    expect(original.from).not.toHaveProperty('employeeId');
  });
});

describe('employee identity through chat posting, retirement and restart', () => {
  const services: ChatroomService[] = [];
  let directory: string;
  const sessions = new Map<string, { name: string; owner?: string; pid: number; isWorking: boolean; mode: string; status: string }>();
  const bindings = new Map<string, string>();
  const events: Array<{ event: string; data: unknown }> = [];
  const make = async (database = false) => {
    const service = new ChatroomService({ file: join(directory, 'rooms.json'), ...(database ? { database: join(directory, 'chat.db') } : {}), getSession: (sessionId) => sessions.get(sessionId) as never, employeeOf: (sessionId) => bindings.get(sessionId), broadcast: (event, data) => events.push({ event, data }) });
    await service.init();
    services.push(service);
    return service;
  };
  const addSession = (sessionId: string) => sessions.set(sessionId, { name: 'Employee', owner: OWNER, pid: 123, isWorking: false, mode: 'claude', status: 'idle' });

  beforeEach(() => {
    directory = mkdtempSync(join(homedir(), 'chat-employee-'));
    sessions.clear();
    bindings.clear();
    events.length = 0;
    addSession(OLD);
    addSession(NEXT);
    bindings.set(OLD, EMPLOYEE);
  });
  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop();
    safeRmHomeTree(directory);
  });

  it('persists and broadcasts authoritative ids on ordinary posts and polls', async () => {
    const service = await make();
    const room = service.createRoom('Identity', OWNER);
    service.addMember(room.id, OLD, {});
    const posted = service.post(room.id, { ...sender(), employeeId: 'forged' } as ChatSender, 'Hello', 'all', { deliver: false });
    expect(posted.from).toHaveProperty('employeeId', EMPLOYEE);
    expect(events.some(({ data }) => (data as { message?: ChatMessage }).message?.id === posted.id && (data as { message: ChatMessage }).message.from.kind === 'agent' && (data as { message: ChatMessage }).message.from.employeeId === EMPLOYEE)).toBe(true);
    const poll = service.createPoll(room.id, sender(), { question: 'Which?', options: ['One', 'Two'] });
    expect(poll.from).toHaveProperty('employeeId', EMPLOYEE);
    await service.stop();
    const restarted = await make();
    expect(restarted.room(room.id)!.messages.find((entry) => entry.id === posted.id)!.from).toHaveProperty('employeeId', EMPLOYEE);
  });

  it.each([false, true])('enriches legacy reads and pins without rewriting history (database=%s)', async (database) => {
    const service = await make(database);
    const room = service.createRoom('History', OWNER);
    service.addMember(room.id, OLD, {});
    const legacy = { ...message(), roomId: room.id, pinned: { at: 2, by: 'Owner', kind: 'user' as const } };
    room.messages.push(legacy);
    bindings.delete(OLD);
    bindings.set(NEXT, EMPLOYEE);
    await service.replaceSession(OLD, NEXT, 'Owner', (candidate) => candidate.owner === OWNER);
    sessions.delete(OLD);
    const current = service.post(room.id, sender(NEXT), 'New reply', 'all', { deliver: false, replyTo: legacy.id });
    const shown = service.view(room).messages.filter((entry) => entry.from.kind === 'agent');
    expect(shown.map((entry) => entry.from)).toEqual([{ ...sender(), employeeId: EMPLOYEE }, { ...sender(NEXT), employeeId: EMPLOYEE }]);
    expect(service.pinned(room.id)[0].from).toHaveProperty('employeeId', EMPLOYEE);
    expect(service.exactAgentRead(NEXT, room.id, legacy.id).message.from).toHaveProperty('employeeId', EMPLOYEE);
    expect(current.replyTo).toBe(legacy.id);
    expect(legacy.from).not.toHaveProperty('employeeId');
    await service.stop();
    const restarted = await make(database);
    expect(restarted.room(room.id)!.messages.find((entry) => entry.id === legacy.id)!.from).not.toHaveProperty('employeeId');
    expect(restarted.view(restarted.room(room.id)!).messages.find((entry) => entry.id === legacy.id)!.from).toHaveProperty('employeeId', EMPLOYEE);
  });
});
