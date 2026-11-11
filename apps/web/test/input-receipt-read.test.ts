/** Non-effecting receipt inspection uses real Session subject custody and actual route authorization. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { TerminalInputReceipts } from '../src/terminal-input-outcome.js';
import {
  TerminalInputService,
  terminalInputFingerprint,
  type TerminalInputIntent,
} from '../src/web/terminal-input-service.js';
import { registerInputReceiptRoutes } from '../src/web/routes/input-receipt-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

let app: FastifyInstance, session: Session, directory: string;
let ctx: ReturnType<typeof createMockRouteContext>;
const input: TerminalInputIntent = { input: 'original', useMux: false, clientId: 'page-issuer', seq: 0 };
let write: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'receipt-read-'));
  session = new Session({ id: 'original-session', workingDir: directory, mode: 'shell' });
  write = vi.fn();
  Object.assign(session, { ptyProcess: { write } });
  ctx = createMockRouteContext();
  ctx.sessions.clear();
  ctx.sessions.set(session.id, session as never);
  app = Fastify();
  await app.register(cookie);
  installRouteErrorHandler(app);
});
afterEach(async () => {
  await app.close();
  Object.assign(session, { ptyProcess: null });
  await session.stop(false);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function register() {
  registerInputReceiptRoutes(app, ctx as unknown as SessionPort);
}
function tag(intent = input) {
  return { clientId: intent.clientId!, seq: intent.seq!, fingerprint: terminalInputFingerprint(intent) };
}
function probe(overrides: Record<string, string | number> = {}) {
  return app.inject({ url: '/api/sessions/original-session/input-receipt', query: { ...tag(), ...overrides } });
}
function begin(intent = input) {
  const admission = ctx.terminalInput.begin(session, intent, () => ctx.sessions.get(session.id) === (session as never));
  if (admission.state !== 'admitted') throw new Error(`Expected new reservation, got ${admission.state}`);
  return admission.operation;
}

it('missing and repeatedly read evidence remains unknown, without spending or reserving the original tag', async () => {
  register();
  const reserve = vi.spyOn(ctx.terminalInput, 'begin');
  for (let count = 0; count < 3; count++) {
    const result = await probe();
    expect(result.json()).toEqual({ success: true, data: { version: 1, ...tag(), state: 'unknown' } });
    expect(result.headers['cache-control']).toBe('no-store');
  }
  expect(reserve).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(session.inputSeqSpent(input.clientId!, 0)).toBe(false);
  expect(begin().writeRaw()).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith('original');
});

it('observes pending then exact confirmation after one physical write, without replaying it', async () => {
  register();
  const operation = begin();
  expect((await probe()).json().data.state).toBe('pending');
  expect(write).not.toHaveBeenCalled();
  expect(operation.writeRaw()).toBe(true);
  for (let count = 0; count < 3; count++) expect((await probe()).json().data.state).toBe('confirmed');
  expect(write).toHaveBeenCalledOnce();
  expect((await probe({ fingerprint: 'f'.repeat(64) })).json().data.state).toBe('held');
  expect((await probe({ seq: 1 })).json().data.state).toBe('unknown');
  expect(write).toHaveBeenCalledOnce();
});

it.each(['session', 'provider', 'owner'] as const)(
  'never transfers a positive receipt to a changed %s',
  async (changed) => {
    register();
    expect(begin().writeRaw()).toBe(true);
    if (changed === 'session')
      ctx.sessions.set(session.id, new Session({ id: session.id, workingDir: directory, mode: 'shell' }) as never);
    else if (changed === 'provider') Object.assign(session, { ptyProcess: { write: vi.fn() } });
    else Object.assign(session, { owner: 'another-owner' });
    expect((await probe()).json().data.state).toBe('held');
    expect(write).toHaveBeenCalledOnce();
  }
);

it('holds a physically uncertain attempt and never lets a later read write again', async () => {
  register();
  write.mockImplementation(() => {
    throw new Error('write may have reached the PTY');
  });
  expect(() => begin().writeRaw()).toThrow();
  for (let count = 0; count < 3; count++) expect((await probe()).json().data.state).toBe('held');
  expect(write).toHaveBeenCalledOnce();
});

it('reads typed-unsent as a negative delivery result, preserving the composer without retransmission', async () => {
  register();
  const intent = { ...input, input: 'typed\r', useMux: true };
  vi.spyOn(session, 'writeViaMux').mockImplementation(async (_text, options) => {
    options?.onTypedUnsent?.();
    return false;
  });
  expect(await begin(intent).writeMux()).toBe(false);
  const result = await probe(tag(intent));
  expect(result.json().data.state).toBe('typed-unsent');
  expect(session.writeViaMux).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
});

it('eviction and a new process receipt store both return unknown, never not-issued', async () => {
  ctx.terminalInput = new TerminalInputService(new TerminalInputReceipts(1, 1));
  register();
  expect(begin().writeRaw()).toBe(true);
  expect(begin({ ...input, seq: 1 }).writeRaw()).toBe(true);
  expect((await probe()).json().data.state).toBe('unknown');
  ctx.terminalInput = new TerminalInputService();
  expect((await probe({ seq: 1 })).json().data.state).toBe('unknown');
  expect(write).toHaveBeenCalledTimes(2);
});

it.each([
  { seq: '-1' },
  { seq: '1.2' },
  { seq: '01' },
  { seq: '9007199254740992' },
  { fingerprint: 'not-a-digest' },
  { clientId: 'x'.repeat(129) },
  { unexpected: 'field' },
])('rejects malformed receipt queries before reading or dispatching: %j', async (query) => {
  register();
  const inspect = vi.spyOn(ctx.terminalInput, 'inspect');
  expect((await probe(query)).statusCode).toBe(400);
  expect(inspect).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('retains actual related-agent scope authorization and refuses anonymous, restricted and unrelated callers', async () => {
  const auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner-auth.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const password = 'Synthetic-receipt-auth-42!';
  const token = await auth.setup('fixture-owner', password, password, '127.0.0.1');
  registerOwnerPolicy(app, {
    service: auth,
    ctx: ctx as unknown as SessionPort,
    isCapabilityRequest: () => false,
    relations: {
      known: () => true,
      related: (a, b) => a === b,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  register();
  const query = tag();
  const request = (headers = {}, cookies = {}) =>
    app.inject({ url: '/api/sessions/original-session/input-receipt', query, headers, cookies });
  expect((await request()).statusCode).toBe(401);
  expect((await request({ 'x-reverie-parent-session': session.id })).statusCode).toBe(200);
  const other = new Session({ id: 'unrelated-session', workingDir: directory, mode: 'shell' });
  ctx.sessions.set(other.id, other as never);
  expect((await request({ 'x-reverie-parent-session': other.id })).statusCode).toBe(403);
  expect((await request({}, { [OWNER_COOKIE]: token })).statusCode).toBe(200);
  auth.logout(token);
  expect((await request({}, { [OWNER_COOKIE]: token })).statusCode).toBe(401);
  expect(write).not.toHaveBeenCalled();
});
