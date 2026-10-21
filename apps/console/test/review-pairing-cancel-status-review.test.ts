import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type InjectOptions } from 'fastify';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbassyGuestClient, type EmbassyGuestRequest, type EmbassyGuestResponse } from '../src/embassy-guest-client.js';
import {
  EMBASSY_HOST_OPS_MAX,
  EmbassyHost,
  createEmbassyChannelHttp,
  type EmbassyChannelCall,
} from '../src/embassy-host.js';
import { EmbassyPairing } from '../src/embassy-pairing.js';
import { registerEmbassyPairingRoutes } from '../src/web/routes/embassy-pairing-routes.js';
import { buildHostPolicy } from '../src/web/network-auth-policy.js';
import { registerHostGuard, registerSecurityHeaders } from '../src/web/middleware/auth.js';

const ORIGIN = 'https://embassy.example.ts.net:8443';
const ROOM = '00000015-001b-4000-8000-000000000025';
const sha = (v: string) => createHash('sha256').update(v).digest('base64url');
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A stateful stand-in for the embassy's public pairing routes and guest room, following contract r2 §3. */
class FakeEmbassy {
  invites = new Map<string, { roomId: string; requestId?: string }>();
  requests = new Map<
    string,
    { token: string; claimHash: string; state: string; code: string; claims: number; company: string; identity: string }
  >();
  sessions = new Map<string, string>(); // session -> requestId
  calls: Array<{ path: string; body: unknown }> = [];
  down = false;
  /** Process the next call of this path, then throw as if the answer was lost. */
  loseAnswer = new Set<string>();
  fail5xx = new Set<string>();
  holds = new Map<string, { release: () => void; gate: Promise<void> }>();
  /** Identities that collide with a room label: 409 GUEST_LABEL, invite not consumed. */
  takenLabels = new Set<string>();

  issue(roomId = ROOM): string {
    const token = randomUUID().replace(/-/g, '').padEnd(43, 'x').slice(0, 43);
    this.invites.set(token, { roomId });
    return `embassy-v2|${ORIGIN}|${roomId}|${token}`;
  }
  hold(path: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.holds.set(path, { release, gate });
    return release;
  }
  request(id: string) {
    return this.requests.get(id)!;
  }
  only() {
    expect(this.requests.size).toBe(1);
    const [id, r] = [...this.requests.entries()][0];
    return { id, ...r };
  }
  approve(id = this.only().id) {
    this.request(id).state = 'approved';
  }
  claimCount() {
    return this.calls.filter((c) => c.path === '/api/embassy/pair-claim').length;
  }

  transport = async (r: EmbassyGuestRequest): Promise<EmbassyGuestResponse> => {
    if (this.down) throw new Error('down');
    const hold = this.holds.get(r.path);
    if (hold) {
      this.holds.delete(r.path);
      await hold.gate;
    }
    this.calls.push({ path: r.path, body: r.body });
    if (this.fail5xx.has(r.path)) return { status: 503, body: { error: { code: 'INTERNAL', message: 'x' } } };
    const res = this.answer(r);
    if (this.loseAnswer.delete(r.path)) throw new Error('lost');
    return res;
  };

  private err(status: number, code: string): EmbassyGuestResponse {
    return { status, body: { error: { code, message: code } } };
  }
  private answer(r: EmbassyGuestRequest): EmbassyGuestResponse {
    const b = (r.body ?? {}) as Record<string, string>;
    if (r.method === 'GET' && r.path.startsWith(`/embassy/rooms/${ROOM}/posts`))
      return this.sessions.has(r.cookie ?? '') ? { status: 200, body: { posts: [] } } : this.err(401, 'INVALID_GUEST');
    if (r.path === '/api/embassy/pair-request') {
      const invite = this.invites.get(b.token);
      if (!invite || invite.roomId !== b.roomId) return this.err(401, 'INVALID_INVITE');
      const view = (id: string, status: number) => {
        const q = this.request(id);
        return {
          status,
          body: { requestId: id, code: q.code, state: q.state, roomId: invite.roomId, roomName: 'Pilot', hostCompany: 'Host', expiresAt: Date.now() + 600_000 },
        };
      };
      if (invite.requestId) {
        const q = this.request(invite.requestId);
        return q.claimHash === b.claimHash ? view(invite.requestId, 200) : this.err(401, 'INVALID_INVITE');
      }
      if (this.takenLabels.has(b.identity)) return this.err(409, 'GUEST_LABEL');
      const id = randomUUID();
      const code = Array.from({ length: 8 }, (_, i) => CROCK[(this.requests.size * 7 + i * 3) % 32]).join('');
      this.requests.set(id, { token: b.token, claimHash: b.claimHash, state: 'pending', code, claims: 0, company: b.company, identity: b.identity });
      invite.requestId = id;
      return view(id, 201);
    }
    const q = this.requests.get(b.requestId);
    if (!q || sha(b.claimSecret) !== q.claimHash) return this.err(404, 'PAIR_NOT_FOUND');
    if (r.path === '/api/embassy/pair-status')
      return { status: 200, body: { state: q.state, expiresAt: Date.now() + 600_000, claimExpiresAt: null } };
    if (r.path === '/api/embassy/pair-cancel') {
      if (['pending', 'approved', 'claimed'].includes(q.state)) q.state = 'revoked';
      for (const [s, id] of this.sessions) if (id === b.requestId) this.sessions.delete(s);
      return { status: 200, body: { state: q.state } };
    }
    if (r.path === '/api/embassy/pair-claim') {
      if (q.state === 'pending') return this.err(409, 'PAIR_PENDING');
      if (q.state === 'rejected') return this.err(410, 'PAIR_REJECTED');
      if (q.state === 'revoked') return this.err(410, 'PAIR_REVOKED');
      if (q.state === 'expired') return this.err(410, 'PAIR_EXPIRED');
      if (q.claims >= 10) return this.err(429, 'CLAIM_LIMIT');
      for (const [s, id] of this.sessions) if (id === b.requestId) this.sessions.delete(s);
      const session = randomUUID().replace(/-/g, '').padEnd(43, 's').slice(0, 43);
      this.sessions.set(session, b.requestId);
      q.claims++;
      q.state = 'claimed';
      return {
        status: 200,
        body: {
          sessionToken: session,
          hostCompany: 'Host',
          room: { id: ROOM, name: 'Pilot' },
          guest: { company: q.company, identity: q.identity },
          expiresAt: Date.now() + 86_400_000,
        },
      };
    }
    return this.err(404, 'NOT_FOUND');
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'embassy-pairing-'));
  dirs.push(dir);
  return dir;
};

/** A guest console: the real guest client and pairing module over the fake embassy, restartable on one data dir. */
async function guestConsole(embassy = new FakeEmbassy(), dir = temp(), now?: () => number) {
  const boot = async () => {
    const guest = new EmbassyGuestClient({ file: join(dir, 'embassy-guest.json'), transport: embassy.transport });
    await guest.init();
    const pairing = new EmbassyPairing({ dir: join(dir, 'embassy-pairings'), guest, transport: embassy.transport, now });
    await pairing.init();
    return { guest, pairing };
  };
  return { embassy, dir, boot, ...(await boot()) };
}
const recordFiles = (dir: string) => readdirSync(join(dir, 'embassy-pairings')).filter((f) => f.endsWith('.json'));
const record = (dir: string, handle: string) =>
  JSON.parse(readFileSync(join(dir, 'embassy-pairings', `${handle}.json`), 'utf8')) as Record<string, unknown>;
const flush = () => new Promise((r) => setTimeout(r, 20));


it('VERIFIER-CANCEL-STATUS: cancellation fences an approved status arriving before claim begins', async () => {
  const g = await guestConsole();
  const made = await g.pairing.create(undefined, {qr:g.embassy.issue(),clientRequestId:randomUUID()});
  g.embassy.approve();
  const release = g.embassy.hold('/api/embassy/pair-status');
  const get = g.pairing.get(undefined,made.handle);
  await flush();
  const cancel = g.pairing.cancel(undefined,made.handle);
  release();
  const [polled,cancelled] = await Promise.all([get,cancel]);
  await g.guest.stop(); await g.pairing.stop();
  expect(cancelled.state).toBe('cancelled');
  expect.soft(g.embassy.claimCount(), 'a status result after cancel must not begin a new claim').toBe(0);
  expect.soft(polled.state, 'the outstanding GET must not report connected after cancellation was requested').not.toBe('connected');
});
