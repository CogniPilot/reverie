import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ChatroomService } from '../src/chatroom-service.js';
import { renderForRecipient } from '../src/chatroom-delivery.js';
import { ExternalChatService } from '../src/external-chat-service.js';
import { ExternalChatProvider, initialExternalCursor } from '../src/external-chat-provider.js';
import { registerExternalChatRoutes } from '../src/web/routes/external-chat-routes.js';
import type { ExternalChatState, ExternalConnection } from '../src/external-chat-types.js';

const TOKEN = 'xoxb-TEST-SECRET-NEVER-RETURN';
const A = 'agent-a';
describe('external chat actual HTTP transports and mutation boundary', () => {
  let server: Server;
  let provider: ExternalChatProvider;
  let service: ExternalChatService;
  let chat: ChatroomService;
  let file: string;
  let roomId: string;
  let now: number;
  let route: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
  let defaultRoute: typeof route;
  let calls: Array<{ path: string; auth?: string; body: Record<string, unknown> }>;
  const sessions = new Map<string, { owner: string }>();
  const snapshot = () => service.snapshot('alice') as Omit<ExternalChatState, 'version'>;
  const connection = () => snapshot().connections[0];
  const reply = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  beforeEach(async () => {
    now = Date.UTC(2026, 9, 15);
    calls = [];
    sessions.clear();
    sessions.set(A, { owner: 'alice' });
    sessions.set('agent-b', { owner: 'bob' });
    const dir = await fs.mkdtemp(join(tmpdir(), 'external-chat-'));
    file = join(dir, 'external.json');
    route = (req, res) => {
      const path = req.url || '';
      if (path.includes('auth.test'))
        reply(res, {
          ok: true,
          user_id: 'UBOT',
          bot_id: 'BBOT',
          user: 'Maya',
          team_id: 'TTEST',
          team: 'Test workspace',
        });
      else if (path.includes('conversations.info'))
        reply(res, { ok: true, channel: { id: 'CTEST', name: 'chosen', is_member: true } });
      else if (path.includes('conversations.history')) reply(res, { ok: true, messages: [] });
      else if (path.includes('chat.postMessage')) reply(res, { ok: true, ts: '9999999999.000001' });
      else if (path.includes('users/@me')) reply(res, { id: '1234567', username: 'Maya', bot: true });
      else if (path.includes('/messages')) reply(res, []);
      else reply(res, { id: '987654321', name: 'chosen', type: 0 });
    };
    defaultRoute = route;
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url || '', auth: req.headers.authorization, body });
      route(req, res, body);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    provider = new ExternalChatProvider(fetch, { slack: `${base}/slack/`, discord: `${base}/discord/` });
    chat = new ChatroomService({
      file: join(dir, 'chatrooms.json'),
      getSession: () => undefined,
      broadcast: () => {},
      now: () => now,
    });
    await chat.init();
    roomId = chat.createRoom('Explicit room', 'alice').id;
    chat.addMember(roomId, A);
    service = new ExternalChatService({
      file,
      chatrooms: chat,
      getSession: (id) => sessions.get(id),
      provider,
      now: () => now,
    });
    await service.init();
  });
  afterEach(async () => {
    await service.stop();
    await chat.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.CODEMAN_MULTIUSER;
  });
  async function connect() {
    await service.connect('alice', { provider: 'slack', agentSessionId: A, token: TOKEN });
    return connection().id;
  }
  async function enableAndLink() {
    const id = await connect();
    await service.link('alice', id, { roomId, channelId: 'CTEST' });
    await service.setEnabled('alice', id, true);
    return id;
  }
  const agentMessage = (text = 'agent reply') => chat.post(roomId, { kind: 'agent', sessionId: A, name: 'Maya' }, text);

  it('verifies real bot identity, starts disabled and never returns stored credentials', async () => {
    await connect();
    expect(calls[0]).toMatchObject({ path: '/slack/auth.test', auth: `Bearer ${TOKEN}` });
    expect(connection()).toMatchObject({ enabled: false, identity: { id: 'UBOT', name: 'Maya' } });
    expect(JSON.stringify(snapshot())).not.toContain(TOKEN);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, 'utf8')).toContain(TOKEN);
    agentMessage();
    await service.poll();
    expect(snapshot().deliveries).toHaveLength(0);
    expect(calls.some((c) => c.path.includes('chat.postMessage'))).toBe(false);
  });
  it('refuses user tokens and non-bot Discord identities', async () => {
    await expect(
      service.connect('alice', { provider: 'slack', agentSessionId: A, token: 'xoxp-user-token' })
    ).rejects.toThrow('bot_token_required');
    route = (_req, res) => reply(res, { id: '1234567', username: 'Human', bot: false });
    await expect(
      service.connect('alice', { provider: 'discord', agentSessionId: A, token: 'discord-test-token' })
    ).rejects.toThrow('bot_identity_required');
    expect(calls[0].auth).toBe('Bot discord-test-token');
  });
  it('requires exact owner/session/room binding and refuses DMs', async () => {
    await expect(
      service.connect('alice', { provider: 'slack', agentSessionId: 'agent-b', token: TOKEN })
    ).rejects.toThrow('another owner');
    const id = await connect();
    await expect(service.setEnabled('bob', id, true)).rejects.toThrow('not found');
    expect(service.snapshot('bob')).toEqual({ connections: [], links: [], deliveries: [] });
    const other = chat.createRoom('Bob private', 'bob');
    await expect(service.link('alice', id, { roomId: other.id, channelId: 'CTEST' })).rejects.toThrow('Room not found');
    // Existing DM store API is not required for this guard: a legitimate room's kind identifies it.
    chat.room(roomId)!.kind = 'dm';
    await expect(service.link('alice', id, { roomId, channelId: 'CTEST' })).rejects.toThrow('ordinary room');
  });
  it('sends only selected agent public messages and suppresses duplicate notifications', async () => {
    await enableAndLink();
    chat.post(roomId, { kind: 'user', name: 'Owner' }, 'private owner input');
    chat.post(roomId, { kind: 'agent', sessionId: A, name: 'Maya' }, 'direct', ['user']);
    const unlinked = chat.createRoom('Private unlinked', 'alice');
    chat.addMember(unlinked.id, A);
    chat.post(unlinked.id, { kind: 'agent', sessionId: A, name: 'Maya' }, 'not shared');
    const message = agentMessage();
    await service.relay(chat.room(roomId)!, message);
    await service.poll();
    expect(snapshot().deliveries).toHaveLength(1);
    expect(snapshot().deliveries[0].state).toBe('sent');
    const sent = calls.filter((c) => c.path.includes('chat.postMessage'));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ text: 'agent reply', channel: 'CTEST', mrkdwn: false, parse: 'none' });
  });
  it('preserves external identity, skips bots and dedupes replayed pages durably', async () => {
    await enableAndLink();
    const ts = `${now / 1000 + 1}.000001`;
    route = (req, res, body) =>
      req.url?.includes('auth.test')
        ? defaultRoute(req, res, body)
        : reply(res, {
            ok: true,
            messages: [
              { ts, user: 'UHUMAN', text: 'owner says do this' },
              { ts: `${now / 1000 + 2}.000001`, user: 'UOTHERBOT', bot_id: 'BOTHER', text: 'loop' },
            ],
          });
    await service.poll();
    const external = chat.room(roomId)!.messages.filter((m) => m.from.kind === 'external');
    expect(external).toHaveLength(1);
    expect(external[0].from).toMatchObject({
      kind: 'external',
      provider: 'slack',
      userId: 'UHUMAN',
      name: 'slack: UHUMAN',
    });
    expect(external[0].to).toEqual([A]);
    expect(renderForRecipient(chat.room(roomId)!, external[0], A, () => 'Maya')).toContain(
      'untrusted external speaker'
    );
    await service.stop();
    // Simulate crash after durable chat post but before external cursor persisted.
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.links[0].cursor = initialExternalCursor('slack', now - 1000);
    await fs.writeFile(file, JSON.stringify(state));
    now += 70000;
    service = new ExternalChatService({
      file,
      chatrooms: chat,
      getSession: (id) => sessions.get(id),
      provider,
      now: () => now,
    });
    await service.init();
    await service.poll();
    expect(chat.room(roomId)!.messages.filter((m) => m.from.kind === 'external')).toHaveLength(1);
    expect(snapshot().deliveries).toHaveLength(0);
    expect(connection().enabled).toBe(true);
    expect(calls.filter((c) => c.path.includes('conversations.history'))).toHaveLength(2);
  });
  it('honors Retry-After without replay floods and discloses ambiguous delivery', async () => {
    await enableAndLink();
    agentMessage();
    route = (_req, res) => {
      res.setHeader('Retry-After', '120');
      reply(res, { error: 'secret-upstream-body' }, 429);
    };
    await service.poll();
    expect(snapshot().deliveries[0].state).toBe('queued');
    const count = calls.length;
    now += 65000;
    await service.poll();
    expect(calls).toHaveLength(count);
    now += 60000;
    route = (_req, res) => reply(res, { token: TOKEN }, 503);
    await service.poll();
    expect(snapshot().deliveries[0]).toMatchObject({ state: 'unknown' });
    expect(JSON.stringify(snapshot())).not.toContain(TOKEN);
    now += 70000;
    await service.poll();
    expect(calls.filter((c) => c.path.includes('chat.postMessage'))).toHaveLength(2);
  });
  it('never retries an interrupted send on process restart', async () => {
    await enableAndLink();
    agentMessage();
    await service.stop();
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.deliveries[0].state = 'sending';
    await fs.writeFile(file, JSON.stringify(state));
    service = new ExternalChatService({
      file,
      chatrooms: chat,
      getSession: (id) => sessions.get(id),
      provider,
      now: () => now,
    });
    await service.init();
    await service.poll();
    expect(snapshot().deliveries[0].state).toBe('unknown');
    expect(calls.some((c) => c.path.includes('chat.postMessage'))).toBe(false);
  });
  it('walks Slack cursor pages without moving the committed watermark early', async () => {
    await enableAndLink();
    const baseline = snapshot().links[0].cursor;
    const first = `${now / 1000 + 2}.000001`;
    const second = `${now / 1000 + 1}.000001`;
    route = (req, res) =>
      reply(
        res,
        req.url?.includes('cursor=page-two')
          ? { ok: true, messages: [{ ts: second, user: 'UHUMAN', text: 'older page' }] }
          : {
              ok: true,
              messages: [{ ts: first, user: 'UHUMAN', text: 'newer page' }],
              has_more: true,
              response_metadata: { next_cursor: 'page-two' },
            }
      );
    await service.poll();
    expect(snapshot().links[0]).toMatchObject({ cursor: baseline, pageCursor: 'page-two', highWater: first });
    now += 70000;
    await service.poll();
    expect(snapshot().links[0]).toMatchObject({ cursor: first });
    expect(snapshot().links[0].pageCursor).toBeUndefined();
    expect(chat.room(roomId)!.messages.filter((m) => m.from.kind === 'external')).toHaveLength(2);
  });
  it('uses Discord receipts, disables mentions, and checks exact channel IDs', async () => {
    const c: ExternalConnection = {
      id: 'c',
      provider: 'discord',
      agentSessionId: A,
      label: 'Discord',
      token: 'bot-secret',
      enabled: false,
      verifiedAt: now,
      nextAt: 0,
      identity: { id: '1234567', name: 'Maya' },
    };
    await expect(provider.channel(c, '../users/@me')).rejects.toThrow('invalid_channel_id');
    route = (_req, res) => reply(res, { id: '1234567890' });
    expect(await provider.send(c, '987654321', '@everyone hi', 'local-id')).toBe('1234567890');
    expect(calls[0]).toMatchObject({
      path: '/discord/channels/987654321/messages',
      auth: 'Bot bot-secret',
      body: { allowed_mentions: { parse: [] }, enforce_nonce: true, content: '@everyone hi' },
    });
  });
  it('consumes a Discord burst across pages without importing messages before linking', async () => {
    await service.connect('alice', { provider: 'discord', agentSessionId: A, token: 'discord-test-token' });
    const id = connection().id;
    await service.link('alice', id, { roomId, channelId: '987654321' });
    await service.setEnabled('alice', id, true);
    const baseline = BigInt(snapshot().links[0].cursor);
    const incoming = (offset: number) => ({
      id: (baseline + BigInt(offset)).toString(),
      author: { id: 'HUMAN1', username: 'Owner', bot: false },
      type: 0,
      content: `message ${offset}`,
    });
    route = (req, res, body) => {
      if (!req.url?.includes('/messages')) return defaultRoute(req, res, body);
      reply(
        res,
        req.url.includes('before=')
          ? [incoming(2), incoming(1), incoming(0)]
          : Array.from({ length: 100 }, (_, n) => incoming(102 - n))
      );
    };
    await service.poll();
    expect(snapshot().links[0].cursor).toBe(baseline.toString());
    expect(snapshot().links[0].pageCursor).toBe((baseline + 3n).toString());
    now += 6000;
    await service.poll();
    expect(snapshot().links[0].cursor).toBe((baseline + 102n).toString());
    const messages = chat.room(roomId)!.messages.filter((m) => m.from.kind === 'external');
    expect(messages).toHaveLength(102);
    expect(messages.some((m) => m.text === 'message 0')).toBe(false);
    expect(messages[0].from).toMatchObject({ provider: 'discord', name: 'discord: Owner', userId: 'HUMAN1' });
  });
  it('shares a bot rate window fairly across multiple explicitly bound connections', async () => {
    const first = await enableAndLink();
    await service.connect('alice', { provider: 'slack', agentSessionId: A, token: TOKEN, label: 'Second binding' });
    const second = snapshot().connections.find((c) => c.id !== first)!.id;
    await service.link('alice', second, { roomId, channelId: 'CTEST' });
    await service.setEnabled('alice', second, true);
    await service.poll();
    expect(calls.filter((c) => c.path.includes('conversations.history'))).toHaveLength(1);
    now += 70000;
    await service.poll();
    expect(calls.filter((c) => c.path.includes('conversations.history'))).toHaveLength(2);
    expect(snapshot().connections.at(-1)!.id).toBe(second);
  });
  it('routes isolate owners, redact secrets and reject agent configuration/extra fields', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
      req.authUser = { username: String(req.headers['x-test-owner'] || 'alice'), role: 'user' };
    });
    registerExternalChatRoutes(app, {} as never, service);
    const created = await app.inject({
      method: 'POST',
      url: '/api/external-chat/connections',
      payload: { provider: 'slack', agentSessionId: A, token: TOKEN },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain(TOKEN);
    const id = connection().id;
    const bob = await app.inject({
      method: 'PUT',
      url: `/api/external-chat/connections/${id}`,
      headers: { 'x-test-owner': 'bob' },
      payload: { enabled: true },
    });
    expect(bob.statusCode).toBe(404);
    expect(
      (await app.inject({ url: '/api/external-chat', headers: { 'x-codeman-parent-session': A } })).statusCode
    ).toBe(403);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/external-chat/connections',
      payload: { provider: 'slack', agentSessionId: A, token: TOKEN, endpoint: TOKEN },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(TOKEN);
    await app.close();
  });
});
