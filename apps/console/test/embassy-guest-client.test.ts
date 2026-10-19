import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBASSY_GUEST_MAX_POSTS,
  EmbassyGuestClient,
  createEmbassyGuestHttps,
  embassyGuestAddressAllowed,
  parseEmbassyGuestKey,
  type EmbassyGuestRequest,
  type EmbassyGuestResponse,
} from '../src/embassy-guest-client.js';
import { registerEmbassyGuestRoutes } from '../src/web/routes/embassy-guest-routes.js';

const ORIGIN = 'https://embassy.example.ts.net:8443';
const TOKEN = 'T'.repeat(43);
const KEY = `embassy-v1|${ORIGIN}|${TOKEN}`;
const SESSION = 'S'.repeat(43);
const ROOM = '46c990d2-c599-4c44-9234-acd91682464d';

const post = (sequence: number, text = `p${sequence}`) => ({
  ackId: `ack-${sequence}`,
  sequence,
  at: 1,
  text,
  trust: 'external',
  author: { kind: 'guest', company: 'Lab', identity: 'g', extra: 'dropped' },
});

function fake(pages: Array<EmbassyGuestResponse | Error>) {
  const seen: EmbassyGuestRequest[] = [];
  const transport = async (r: EmbassyGuestRequest): Promise<EmbassyGuestResponse> => {
    seen.push(r);
    if (r.path === '/api/embassy/join')
      return {
        status: 200,
        body: {
          sessionToken: SESSION,
          hostCompany: 'Host',
          room: { id: ROOM, name: 'Room', closed: false },
          guest: { company: 'Lab', identity: 'g' },
          expiresAt: Date.now() + 3600_000,
        },
      };
    const next = pages.shift() ?? { status: 200, body: { posts: [] } };
    if (next instanceof Error) throw next;
    return next;
  };
  return { seen, transport };
}

const dirs: string[] = [];
const fresh = (pages: Array<EmbassyGuestResponse | Error> = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'embassy-guest-'));
  dirs.push(dir);
  const f = fake(pages);
  return { ...f, file: join(dir, 'embassy-guest.json'), client: new EmbassyGuestClient({ file: join(dir, 'embassy-guest.json'), transport: f.transport }) };
};

describe('embassy guest client', () => {
  afterEach(() => void 0);

  it('parses only canonical P27 keys', () => {
    expect(parseEmbassyGuestKey(KEY)).toEqual({ origin: ORIGIN, token: TOKEN });
    for (const bad of [
      `embassy-v1|http://embassy.example.ts.net|${TOKEN}`,
      `embassy-v1|https://127.0.0.1|${TOKEN}`,
      `embassy-v1|https://embassy.example.ts.net/x|${TOKEN}`,
      `embassy-v1|https://user@embassy.example.ts.net|${TOKEN}`,
      `embassy-v2|${ORIGIN}|${TOKEN}`,
      `embassy-v1|${ORIGIN}|${TOKEN.slice(1)}`,
    ])
      expect(() => parseEmbassyGuestKey(bad)).toThrow('Invalid embassy invite key');
  });

  it('allows public and tailnet addresses only', () => {
    for (const ok of ['8.8.8.8', '100.101.102.103', 'fd7a:115c:a1e0::1', '2606:4700::1111'])
      expect(embassyGuestAddressAllowed(ok)).toBe(true);
    for (const bad of ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '224.0.0.1', 'nonsense'])
      expect(embassyGuestAddressAllowed(bad)).toBe(false);
  });

  it('imports in order, keeps known author fields only, and stops on out-of-order pages', async () => {
    const t = fresh([{ status: 200, body: { posts: [post(1), post(2)] } }, { status: 200, body: { posts: [post(2)] } }]);
    await t.client.init();
    const c = await t.client.join(undefined, KEY, ORIGIN);
    await t.client.tick();
    const posts = t.client.posts(undefined, c.id, 0).posts;
    expect(posts.map((p) => p.sequence)).toEqual([1, 2]);
    expect(posts[0].author).toEqual({ kind: 'guest', company: 'Lab', identity: 'g' });
    // The second page repeats sequence 2: refused, cursor not advanced, polling stops.
    await t.client.tick();
    expect(t.client.list(undefined).connections[0].status).toBe('refused');
    const calls = t.seen.length;
    await t.client.tick();
    expect(t.seen.length).toBe(calls);
  });

  it('stops at the local post cap instead of trimming', async () => {
    const pages = [];
    for (let s = 1; s <= EMBASSY_GUEST_MAX_POSTS; s += 100)
      pages.push({ status: 200, body: { posts: Array.from({ length: 100 }, (_, i) => post(s + i)) } });
    pages.push({ status: 200, body: { posts: [post(EMBASSY_GUEST_MAX_POSTS + 1)] } });
    const t = fresh(pages);
    await t.client.init();
    const c = await t.client.join(undefined, KEY, ORIGIN);
    for (let i = 0; i < 6; i++) await t.client.tick();
    expect(t.client.list(undefined).connections[0].status).toBe('storage-full');
    expect(t.client.posts(undefined, c.id, 0).posts[0].sequence).toBe(1);
    expect(JSON.parse(readFileSync(join(t.file.replace(/\.json$/, ''), `${c.id}.json`), 'utf8')).posts.length).toBe(EMBASSY_GUEST_MAX_POSTS);
  });

  it('refuses oversized or malformed pages without advancing', async () => {
    const t = fresh([{ status: 200, body: { posts: [{ ...post(1), text: 'x'.repeat(5000) }] } }]);
    await t.client.init();
    const c = await t.client.join(undefined, KEY, ORIGIN);
    await t.client.tick();
    expect(t.client.posts(undefined, c.id, 0).posts).toEqual([]);
    expect(t.client.list(undefined).connections[0].lastError).toMatch(/Embassy answered 200/);
  });

  it('disable aborts an in-flight poll at once and drops its late reply', async () => {
    let signal: AbortSignal | undefined;
    let release!: (r: EmbassyGuestResponse) => void;
    const t = fresh();
    const client = new EmbassyGuestClient({
      file: t.file,
      transport: async (r) => {
        if (r.method === 'GET') {
          signal = r.signal;
          return new Promise<EmbassyGuestResponse>((resolve) => (release = resolve)); // ignores the abort: worst case
        }
        return t.transport(r);
      },
    });
    await client.init();
    const c = await client.join(undefined, KEY, ORIGIN);
    const polling = client.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(signal?.aborted).toBe(false);
    await client.setEnabled(undefined, c.id, false);
    expect(signal?.aborted).toBe(true);
    release({ status: 200, body: { posts: [post(1)] } });
    await polling;
    expect(client.posts(undefined, c.id, 0).posts).toEqual([]);
    expect(client.list(undefined).connections[0].status).toBe('disabled');
  });
});

describe('embassy guest https transport (GC-K1: DNS inside the deadline and cancel)', () => {
  const GET = { origin: ORIGIN, method: 'GET' as const, path: '/embassy/health' };
  const hangingDns = () => new Promise<Array<{ address: string; family: number }>>(() => {});
  const noSocket = () => {
    const opened = { count: 0 };
    const request = (() => {
      opened.count++;
      throw new Error('socket opened');
    }) as unknown as typeof import('node:https').request;
    return { opened, request };
  };

  it('a DNS lookup that never answers still meets the deadline, with no socket', async () => {
    const { opened, request } = noSocket();
    const send = createEmbassyGuestHttps({ lookup: hangingDns, request, timeoutMs: 50 });
    const t = Date.now();
    await expect(send(GET)).rejects.toThrow('Embassy timed out');
    expect(Date.now() - t).toBeLessThan(1000);
    expect(opened.count).toBe(0);
  });

  it('abort during DNS settles at once', async () => {
    const { opened, request } = noSocket();
    const send = createEmbassyGuestHttps({ lookup: hangingDns, request, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = send({ ...GET, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('Embassy request cancelled');
    await expect(send({ ...GET, signal: controller.signal })).rejects.toThrow('Embassy request cancelled');
    expect(opened.count).toBe(0);
  });

  it('a DNS answer that arrives after cancel or deadline never opens a socket', async () => {
    const { opened, request } = noSocket();
    let answer!: (a: Array<{ address: string; family: number }>) => void;
    const lookup = () => new Promise<Array<{ address: string; family: number }>>((r) => (answer = r));
    const send = createEmbassyGuestHttps({ lookup, request, timeoutMs: 30 });
    await expect(send(GET)).rejects.toThrow('Embassy timed out');
    answer([{ address: '100.64.0.1', family: 4 }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(opened.count).toBe(0);
  });

  it('control: a resolver rejection and a refused address fail without a socket', async () => {
    const { opened, request } = noSocket();
    await expect(createEmbassyGuestHttps({ lookup: () => Promise.reject(new Error('NXDOMAIN')), request })(GET)).rejects.toThrow(
      'Embassy host did not resolve'
    );
    await expect(createEmbassyGuestHttps({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request })(GET)).rejects.toThrow(
      'refused address'
    );
    expect(opened.count).toBe(0);
  });

  it('a real client poll stuck in DNS settles on Disable, and stop() does not wait for DNS', async () => {
    const t = fresh();
    const https = createEmbassyGuestHttps({ lookup: hangingDns, request: noSocket().request, timeoutMs: 60_000 });
    const client = new EmbassyGuestClient({
      file: t.file,
      transport: (r) => (r.path === '/api/embassy/join' ? t.transport(r) : https(r)),
    });
    await client.init();
    const c = await client.join(undefined, KEY, ORIGIN);
    const polling = client.tick();
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await client.setEnabled(undefined, c.id, false);
    await polling;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.list(undefined).connections[0].status).toBe('disabled');
    await client.setEnabled(undefined, c.id, true);
    const again = client.tick();
    await new Promise((r) => setTimeout(r, 20));
    const s2 = Date.now();
    await client.stop();
    await again;
    expect(Date.now() - s2).toBeLessThan(1000);
    expect(client.posts(undefined, c.id, 0).posts).toEqual([]);
  });
});

describe('embassy guest routes', () => {
  it('refuses agent sessions and never echoes a key', async () => {
    const t = fresh();
    await t.client.init();
    const app = Fastify();
    // A verifier that accepts: the owner-session matrix is in embassy-guest-policy.test.ts.
    registerEmbassyGuestRoutes(app, t.client, () => true);
    const agent = await app.inject({ method: 'GET', url: '/api/embassy-guest', headers: { 'x-codeman-parent-session': 'x' } });
    expect(agent.statusCode).toBe(403);
    const agentJoin = await app.inject({
      method: 'POST',
      url: '/api/embassy-guest/join',
      headers: { 'x-codeman-parent-session': 'x' },
      payload: { key: KEY, confirmedOrigin: ORIGIN },
    });
    expect(agentJoin.statusCode).toBe(403);
    expect(t.seen.length).toBe(0);
    const bad = await app.inject({ method: 'POST', url: '/api/embassy-guest/preview', payload: { key: KEY + 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain(TOKEN);
    const joined = await app.inject({ method: 'POST', url: '/api/embassy-guest/join', payload: { key: KEY, confirmedOrigin: ORIGIN } });
    expect(joined.statusCode).toBe(200);
    expect(joined.body).not.toContain(SESSION);
    expect(joined.body).not.toContain(TOKEN);
    const list = await app.inject({ method: 'GET', url: '/api/embassy-guest' });
    expect(list.body).not.toContain(SESSION);
    await app.close();
    await t.client.stop();
  });
});
