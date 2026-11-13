/** Actual authenticated HTTP/WS routes; synthetic PTY only, never a real employee. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Session } from '../src/session.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware, registerHostGuard } from '../src/web/middleware/auth.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { registerWsRoutes } from '../src/web/routes/ws-routes.js';
import { installResponseEnvelope } from '../src/web/response-envelope.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

let app: FastifyInstance, session: Session, directory: string, token: string, port: number;
let ctx: ReturnType<typeof createMockRouteContext>, write: ReturnType<typeof vi.fn>;
let authState: ReturnType<typeof registerAuthMiddleware>;
let observedFetch: Record<string, string | string[] | undefined>;
const sockets = new Set<WebSocket>();
const input = { input: 'original', useMux: false, clientId: 'old-page', seq: 1 };
const policy = () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null });
beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  vi.stubEnv('REVERIE_PASSWORD', 'synthetic-api-boundary');
  vi.stubEnv('REVERIE_USERNAME', 'fixture-api');
  directory = await mkdtemp(join(tmpdir(), 'browser-protocol-'));
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  const auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner-auth.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const password = 'Synthetic-browser-protocol-42!';
  token = await auth.setup('fixture-owner', password, password, '127.0.0.1');
  session = new Session({ id: 'original-session', workingDir: directory, mode: 'shell' });
  write = vi.fn();
  Object.assign(session, { ptyProcess: { write } });
  ctx = createMockRouteContext();
  ctx.sessions.clear();
  ctx.sessions.set(session.id, session as never);
  app = Fastify({ forceCloseConnections: true });
  await app.register(cookie);
  registerHostGuard(app, policy);
  authState = registerAuthMiddleware(app, false, '', auth);
  registerOwnerPolicy(app, {
    service: auth,
    ctx: ctx as unknown as SessionPort,
    isCapabilityRequest: () => false,
    relations: {
      known: () => false,
      related: (a, b) => a === b,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
      coordinated: () => false,
    },
  });
  await app.register(websocket);
  registerSessionRoutes(app, ctx as never);
  registerWsRoutes(app, ctx as never, policy);
  installResponseEnvelope(app, '');
  installRouteErrorHandler(app);
  app.addHook('onRequest', (req, _reply, done) => {
    observedFetch = {
      mode: req.headers['sec-fetch-mode'],
      site: req.headers['sec-fetch-site'],
      origin: req.headers.origin,
      marker: req.headers['x-reverie-input-protocol'],
    };
    done();
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await app.close();
  for (const map of Object.values(authState)) map?.dispose();
  Object.assign(session, { ptyProcess: null });
  await session.stop(false);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const post = (headers: Record<string, string>, authenticated = true) =>
  app.inject({
    method: 'POST',
    url: '/api/sessions/original-session/input',
    headers,
    cookies: authenticated ? { [OWNER_COOKIE]: token } : {},
    payload: input,
  });
const agentHeaders = () => ({
  authorization: 'Basic ' + Buffer.from('fixture-api:synthetic-api-boundary').toString('base64'),
  'x-reverie-parent-session': session.id,
});
async function connect(marker = '', origin = `http://127.0.0.1:${port}`) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/original-session/terminal${marker}`, {
    headers: { cookie: `${OWNER_COOKIE}=${token}`, origin },
  });
  sockets.add(socket);
  await once(socket, 'open');
  return socket;
}
async function send(socket: WebSocket) {
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ t: 'i', d: input.input, useMux: false, cid: input.clientId, seq: input.seq }));
  const [bytes] = await message;
  return JSON.parse(String(bytes));
}

it.each([{ origin: 'http://localhost' }, { origin: 'http://localhost', 'x-reverie-input-protocol': '1' }])(
  'holds an old browser HTTP request before receipt reservation, watermark or physical input: %j',
  async (headers) => {
    const begin = vi.spyOn(ctx.terminalInput, 'begin');
    const response = await post(headers);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ success: false, reloadRequired: true, recoveryRequired: true });
    expect(response.json().error).toMatch(/reload/i);
    expect(response.json().data?.delivered).not.toBe(false);
    expect(begin).not.toHaveBeenCalled();
    expect(session.inputSeqSpent(input.clientId, input.seq)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(session.terminalInputHeld).toBe(false); // one stale browser cannot hold other clients' worker
  }
);

it('accepts the marked browser exactly once through existing authenticated dispatch', async () => {
  const response = await post({ origin: 'http://localhost', 'x-reverie-input-protocol': '2' });
  expect(response.statusCode).toBe(200);
  expect(write).toHaveBeenCalledExactlyOnceWith(input.input);
});

it.each(['sec-fetch-site'])(
  'fetch metadata cannot disguise a browser input as an agent exemption: %s',
  async (header) => {
    const begin = vi.spyOn(ctx.terminalInput, 'begin');
    const response = await post({ ...agentHeaders(), [header]: 'same-origin' }, false);
    expect(response.statusCode).toBe(409);
    expect(response.json().reloadRequired).toBe(true);
    expect(begin).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  }
);

it('keeps the existing authenticated headless API usable without treating headers as agent authority', async () => {
  const response = await post(agentHeaders(), false);
  expect(response.statusCode).toBe(200);
  expect(write).toHaveBeenCalledExactlyOnceWith(input.input);
});

it('actual Node fetch with mode-only metadata retains the authenticated headless contract without a protocol marker', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/input`, {
    method: 'POST',
    headers: { ...agentHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  expect(observedFetch).toEqual({ mode: 'cors', site: undefined, origin: undefined, marker: undefined });
  expect((await response.json()).success).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith(input.input);
});

it('the protocol marker cannot bypass sign-in or cross-origin policy', async () => {
  expect((await post({ 'x-reverie-input-protocol': '2' }, false)).statusCode).toBe(401);
  expect((await post({ origin: 'https://foreign.invalid', 'x-reverie-input-protocol': '2' })).statusCode).toBe(403);
  expect(write).not.toHaveBeenCalled();
});

it('holds old browser WS input while preserving terminal output and the original tag', async () => {
  const socket = await connect();
  const begin = vi.spyOn(ctx.terminalInput, 'begin');
  expect(await send(socket)).toMatchObject({
    t: 'ie',
    held: true,
    reloadRequired: true,
    error: expect.stringMatching(/reload/i),
  });
  expect(begin).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(session.inputSeqSpent(input.clientId, input.seq)).toBe(false);
  const output = once(socket, 'message');
  session.emit('terminal', 'original output');
  expect(JSON.parse(String((await output)[0]))).toMatchObject({
    t: 'o',
    d: expect.stringContaining('original output'),
  });
  expect(session.terminalInputHeld).toBe(false);
});

it('accepts marked browser WS input with exact confirmation and cannot bypass the Origin guard', async () => {
  const socket = await connect('?inputProtocol=2');
  expect(await send(socket)).toEqual({ t: 'ia', seq: input.seq, confirmed: true });
  expect(write).toHaveBeenCalledExactlyOnceWith(input.input);
  const bad = await app.inject({
    url: '/ws/sessions/original-session/terminal?inputProtocol=2',
    cookies: { [OWNER_COOKIE]: token },
    headers: { origin: 'https://foreign.invalid', upgrade: 'websocket', connection: 'Upgrade' },
  });
  expect(bad.statusCode).toBe(403);
  expect(write).toHaveBeenCalledOnce();
});
