import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { BuiltinEmbassy, embassyAdvertisedOrigin } from '../src/embassy-builtin.js';
import { EmbassyHost } from '../src/embassy-host.js';
import { parsePairInvite } from '../src/embassy-pair-key.js';
import { isEmbassyProtocolRoute } from '../src/embassy-public-routes.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function setup() {
  const dir = await fs.mkdtemp(join(os.tmpdir(), 'builtin-'));
  dirs.push(dir);
  let now = Date.now();
  const deps = {
    file: join(dir, 'host/state.json'),
    channelFile: join(dir, 'channel/channel.json'),
    secretFile: join(dir, 'channel/secret'),
    now: () => now,
  };
  const builtin = new BuiltinEmbassy(deps),
    host = new EmbassyHost({
      dir: join(dir, 'channel'),
      opsFile: join(dir, 'host/ops.json'),
      transport: builtin.channelTransport,
    });
  await host.init();
  await builtin.init();
  return { builtin, host, deps, advance: (ms: number) => (now += ms) };
}
it('initializes private durable identity without public networking and fails closed on corruption', async () => {
  const f = await setup(),
    first = await f.builtin.settings();
  expect(first).toMatchObject({ builtin: true, needsAdvertisedOrigin: true, origin: null });
  expect((await f.host.status()).status).toBe('ready');
  expect((await fs.stat(f.deps.file)).mode & 511).toBe(384);
  const restart = new BuiltinEmbassy(f.deps);
  await restart.init();
  expect(await restart.settings()).toEqual(first);
  await fs.writeFile(f.deps.file, 'broken');
  await expect(restart.init()).rejects.toThrow();
  expect(await fs.readFile(f.deps.file, 'utf8')).toBe('broken');
});
it('requires an explicit canonical HTTPS address', async () => {
  const f = await setup();
  await expect(f.host.createInvite(randomUUID())).rejects.toThrow();
  for (const origin of [
    'http://example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://example.com/path',
    'https://user@example.com',
  ])
    expect(() => embassyAdvertisedOrigin(origin)).toThrow();
  expect(embassyAdvertisedOrigin('https://embassy.example.com')).toBe('https://embassy.example.com');
});
it('requires owner approval and private claim proof; persists, rotates and revokes guest credentials', async () => {
  const f = await setup();
  await f.builtin.configure('https://embassy.example.com');
  const invite = parsePairInvite((await f.host.createInvite(randomUUID())).qr),
    claimSecret = randomBytes(32).toString('base64url'),
    input = {
      roomId: invite.roomId,
      token: invite.token,
      claimHash: createHash('sha256').update(claimSecret).digest('base64url'),
      company: 'Other company',
      identity: 'Guest',
    };
  const pending: any = await f.builtin.pair('request', input),
    proof = { requestId: pending.requestId, claimSecret };
  expect(await f.builtin.pair('request', input)).toEqual(pending);
  await expect(f.builtin.pair('claim', proof)).rejects.toMatchObject({ status: 409 });
  await expect(f.builtin.pair('status', { ...proof, claimSecret: 'A'.repeat(43) })).rejects.toMatchObject({
    status: 404,
  });
  await f.host.decide('approve', pending.requestId, pending.code);
  const joined: any = await f.builtin.pair('claim', proof),
    body = { text: 'Hello', requestId: randomUUID() };
  await expect(f.builtin.guestPosts(invite.roomId, 'A'.repeat(43), '0')).rejects.toMatchObject({ status: 401 });
  await expect(f.builtin.guestPosts(invite.roomId, joined.sessionToken, undefined, body)).rejects.toMatchObject({
    status: 403,
  });
  const post = await f.builtin.guestPosts(invite.roomId, joined.sessionToken, undefined, body, invite.origin);
  expect(await f.builtin.guestPosts(invite.roomId, joined.sessionToken, undefined, body, invite.origin)).toEqual(post);
  const restart = new BuiltinEmbassy(f.deps);
  await restart.init();
  expect(await restart.guestPosts(invite.roomId, joined.sessionToken, '0')).toMatchObject({
    posts: [{ text: 'Hello' }],
  });
  const rotated: any = await restart.pair('claim', proof);
  await expect(restart.guestPosts(invite.roomId, joined.sessionToken, '0')).rejects.toMatchObject({ status: 401 });
  await restart.pair('cancel', proof);
  await expect(restart.guestPosts(invite.roomId, rotated.sessionToken, '0')).rejects.toMatchObject({ status: 401 });
});
it('renames the hosted room and closing it ends every guest session', async () => {
  const f = await setup();
  await f.builtin.configure('https://embassy.example.com');
  expect((await f.host.status()).room?.name).toBe('Company Embassy');
  expect(await f.host.rename({ name: 'Drone Lab Embassy' })).toMatchObject({ room: { name: 'Drone Lab Embassy' } });
  const restart = new BuiltinEmbassy(f.deps);
  await restart.init();
  expect((await f.host.status()).room?.name).toBe('Drone Lab Embassy');
  // A joined guest, then close.
  const invite = parsePairInvite((await f.host.createInvite(randomUUID())).qr),
    claimSecret = randomBytes(32).toString('base64url');
  const pending: any = await f.builtin.pair('request', {
    roomId: invite.roomId, token: invite.token, claimHash: createHash('sha256').update(claimSecret).digest('base64url'),
    company: 'Other company', identity: 'Guest',
  });
  await f.host.decide('approve', pending.requestId, pending.code);
  const joined: any = await f.builtin.pair('claim', { requestId: pending.requestId, claimSecret });
  await f.host.createInvite(randomUUID()); // an unused open invite
  expect(await f.host.close()).toEqual({ closed: true, revoked: 3 });
  await expect(f.builtin.guestPosts(invite.roomId, joined.sessionToken, '0')).rejects.toMatchObject({ status: 401 });
  await expect(f.builtin.pair('claim', { requestId: pending.requestId, claimSecret })).rejects.toBeTruthy();
  expect((await f.host.listInvites()).every((i: any) => i.revoked || i.state === 'revoked')).toBe(true);
  const posts: any = await f.host.posts(0);
  expect(JSON.stringify(posts)).toContain('The host closed this embassy');
});
it('closing a room already at the post quota still revokes everything and still posts the notice', async () => {
  const f = await setup();
  await f.builtin.configure('https://embassy.example.com');
  const invite = parsePairInvite((await f.host.createInvite(randomUUID())).qr),
    claimSecret = randomBytes(32).toString('base64url');
  const pending: any = await f.builtin.pair('request', {
    roomId: invite.roomId, token: invite.token, claimHash: createHash('sha256').update(claimSecret).digest('base64url'),
    company: 'Other company', identity: 'Guest',
  });
  await f.host.decide('approve', pending.requestId, pending.code);
  const joined: any = await f.builtin.pair('claim', { requestId: pending.requestId, claimSecret });
  // Fill the room to the 2,000-post quota.
  const full = JSON.parse(await fs.readFile(f.deps.file, 'utf8'));
  full.posts = Array.from({ length: 2000 }, (_, i) => ({
    ackId: randomUUID(), sequence: i + 1, at: 1, text: `post ${i + 1}`, author: { kind: 'guest', company: 'Other company', identity: 'Guest' },
  }));
  await fs.writeFile(f.deps.file, JSON.stringify(full));
  expect(await f.host.close()).toEqual({ closed: true, revoked: 2 });
  await expect(f.builtin.guestPosts(invite.roomId, joined.sessionToken, '0')).rejects.toMatchObject({ status: 401 });
  const saved = JSON.parse(await fs.readFile(f.deps.file, 'utf8'));
  expect(saved.requests.every((q: any) => q.state === 'revoked' && q.sessionHash === null)).toBe(true);
  expect(saved.posts).toHaveLength(2000);
  // The oldest post made room; sequences keep increasing, so a reader at the old last sequence still gets the notice.
  expect(saved.posts[0].sequence).toBe(2);
  expect(saved.posts.at(-1)).toMatchObject({ sequence: 2001, text: 'The host closed this embassy. Guest access has ended.' });
  expect(saved.posts.every((p: any, i: number) => i === 0 || p.sequence > saved.posts[i - 1].sequence)).toBe(true);
  const after: any = await f.host.posts(2000);
  expect(JSON.stringify(after)).toContain('The host closed this embassy');
  const restart = new BuiltinEmbassy(f.deps);
  await restart.init();
  expect((await f.host.status()).room).toBeTruthy();
});
it('limits the public protocol boundary to exact capability-authenticated routes', () => {
  expect(isEmbassyProtocolRoute('POST', '/api/embassy/pair-request')).toBe(true);
  for (const path of ['/api/company', '/api/embassy-host/settings', '/api/embassy/pair-request/extra'])
    expect(isEmbassyProtocolRoute('POST', path)).toBe(false);
});
it('passes the real owner-enforce middleware only for credential-authenticated protocol routes', async () => {
  const [
    { default: Fastify },
    { default: cookie },
    { OwnerAuthStore },
    { OwnerAuthService },
    { registerOwnerPolicy },
    { registerAuthMiddleware },
    { registerBuiltinEmbassyRoutes },
  ] = await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('../src/owner-auth/store.js'),
    import('../src/owner-auth/service.js'),
    import('../src/owner-auth/policy.js'),
    import('../src/web/middleware/auth.js'),
    import('../src/web/routes/embassy-builtin-routes.js'),
  ]);
  const f = await setup(),
    dir = join(f.deps.file, '..'),
    store = new OwnerAuthStore(join(dir, 'owner.json'));
  await fs.writeFile(store.markerFile, 'enforce\n');
  const service = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl') }),
    app = Fastify(),
    prior = process.env.REVERIE_PASSWORD;
  process.env.REVERIE_PASSWORD = 'synthetic-shared-password';
  try {
    await app.register(cookie);
    registerAuthMiddleware(app, false, '', service);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions: new Map() } as any,
      isCapabilityRequest: () => false,
      relations: {
        known: () => false,
        related: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerBuiltinEmbassyRoutes(
      app,
      f.builtin,
      () => false,
      () => ({}) as any
    );
    app.get('/api/company', () => ({ private: true }));
    const read = await app.inject({ url: '/embassy/rooms/' + (await f.builtin.settings()).roomId + '/posts' });
    expect(read.statusCode).toBe(401);
    expect(read.headers['www-authenticate']).toBeUndefined();
    expect(read.json().error.code).toBe('INVALID_GUEST');
    const settings = await app.inject({
      method: 'POST',
      url: '/api/embassy-host/settings',
      payload: { origin: 'https://embassy.example.com' },
    });
    expect(settings.statusCode).toBe(401);
    expect((await app.inject({ url: '/api/company' })).statusCode).toBe(401);
    await f.builtin.configure('https://embassy.example.com');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/embassy/pair-request',
      payload: {
        roomId: (await f.builtin.settings()).roomId,
        token: 'A'.repeat(43),
        claimHash: 'B'.repeat(43),
        company: 'Other',
        identity: 'Guest',
      },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_INVITE');
    expect(bad.headers['www-authenticate']).toBeUndefined();
  } finally {
    await app.close();
    if (prior === undefined) delete process.env.REVERIE_PASSWORD;
    else process.env.REVERIE_PASSWORD = prior;
  }
});
it('interoperates with the actual guest pairing state machine through approval and connection', async () => {
  const { EmbassyPairing } = await import('../src/embassy-pairing.js'),
    { EmbassyGuestClient } = await import('../src/embassy-guest-client.js');
  const f = await setup();
  await f.builtin.configure('https://embassy.example.com');
  const transport: any = async (call: any) => {
    try {
      if (call.path.startsWith('/api/embassy/pair-'))
        return { status: 200, body: await f.builtin.pair(call.path.split('pair-')[1], call.body) };
      const room = /\/embassy\/rooms\/([^/]+)\/posts/.exec(call.path);
      if (room)
        return {
          status: 200,
          body: await f.builtin.guestPosts(
            room[1],
            call.cookie?.replace(/^embassy_guest=/, ''),
            new URL('https://x' + call.path).searchParams.get('after') ?? '0'
          ),
        };
      return { status: 404, body: {} };
    } catch (e: any) {
      return { status: e.status ?? 500, body: { error: { code: e.code } } };
    }
  };
  const guest = new EmbassyGuestClient({ file: join(f.deps.file, '../guest.json'), transport }),
    pairing = new EmbassyPairing({ dir: join(f.deps.file, '../pairings'), guest, transport });
  await guest.init();
  await pairing.init();
  try {
    const invite = await f.host.createInvite(randomUUID()),
      created = await pairing.create(undefined, {
        qr: invite.qr!,
        clientRequestId: randomUUID(),
        company: 'Other',
        identity: 'Visitor',
      });
    expect(created.state).toBe('pending');
    const req = await f.host.lookup({ qr: created.requestQr! });
    await f.host.decide('approve', req.requestId, req.code);
    await pairing.tick();
    expect(pairing.list(undefined).pairings[0].state).toBe('connected');
  } finally {
    await pairing.stop();
    await guest.stop();
  }
});
it('bounds anonymous request rate and expires approved claims without persisting raw invite secrets', async () => {
  const f = await setup();
  for (let i = 0; i < 20; i++) f.builtin.checkRate('synthetic', 'request');
  expect(() => f.builtin.checkRate('synthetic', 'request')).toThrow();
  f.advance(60001);
  expect(() => f.builtin.checkRate('synthetic', 'request')).not.toThrow();
  await f.builtin.configure('https://embassy.example.com');
  const issued = await f.host.createInvite(randomUUID()),
    invite = parsePairInvite(issued.qr),
    proof = randomBytes(32).toString('base64url'),
    pending: any = await f.builtin.pair('request', {
      roomId: invite.roomId,
      token: invite.token,
      claimHash: createHash('sha256').update(proof).digest('base64url'),
      company: 'Other',
      identity: 'Visitor',
    });
  expect(await fs.readFile(f.deps.file, 'utf8')).not.toContain(invite.token);
  await f.host.decide('approve', pending.requestId, pending.code);
  f.advance(600001);
  await expect(f.builtin.pair('claim', { requestId: pending.requestId, claimSecret: proof })).rejects.toMatchObject({
    status: 410,
    code: 'PAIR_EXPIRED',
  });
});
it('requires a verified owner and CSRF confirmation to configure the host address', async () => {
  const { default: Fastify } = await import('fastify'),
    { registerBuiltinEmbassyRoutes } = await import('../src/web/routes/embassy-builtin-routes.js');
  const f = await setup(),
    app = Fastify();
  registerBuiltinEmbassyRoutes(
    app,
    f.builtin,
    (req) => req.headers['x-test-owner'] === 'yes',
    () => ({}) as any
  );
  try {
    const payload = { origin: 'https://embassy.example.com' };
    expect((await app.inject({ method: 'POST', url: '/api/embassy-host/settings', payload })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/embassy-host/settings',
          payload,
          headers: { 'x-test-owner': 'yes' },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/embassy-host/settings',
          payload,
          headers: { 'x-test-owner': 'yes', 'x-reverie-parent-session': randomUUID(), 'x-reverie-embassy': '1' },
        })
      ).statusCode
    ).toBe(403);
    const { EMBASSY_CSRF_HEADER } = await import('../src/web/routes/embassy-pairing-routes.js');
    const saved = await app.inject({
      method: 'POST',
      url: '/api/embassy-host/settings',
      payload,
      headers: { 'x-test-owner': 'yes', [EMBASSY_CSRF_HEADER]: '1' },
    });
    expect(saved.statusCode).toBe(200);
    expect(await f.builtin.settings()).toMatchObject({ origin: payload.origin, needsAdvertisedOrigin: false });
  } finally {
    await app.close();
  }
});
