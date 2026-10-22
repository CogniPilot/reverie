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

describe('embassy pairing, guest side (contract r2 §4)', () => {
  it('runs the whole loop: request QR, approval, claim, connected under the stable connectionId', async () => {
    const g = await guestConsole();
    const qr = g.embassy.issue();
    const created = await g.pairing.create(undefined, { qr, clientRequestId: randomUUID(), identity: 'Student One' });
    expect(created.state).toBe('pending');
    const req = g.embassy.only();
    expect(created.requestQr).toBe(`embassy-pair-v1|${ORIGIN}|${req.id}|${req.code}`);
    expect(created.code).toBe(`${req.code.slice(0, 4)}-${req.code.slice(4)}`);
    expect(created.room.id).toBe(ROOM);
    // The token is gone in the same write that stored the requestId; only the claim hash ever left.
    const onDisk = record(g.dir, created.handle);
    expect(onDisk.token).toBeUndefined();
    expect(onDisk.requestId).toBe(req.id);
    const sent = g.embassy.calls[0].body as Record<string, unknown>;
    expect(sent.claimHash).toBe(onDisk.claimHash);
    expect(JSON.stringify(sent)).not.toContain(onDisk.claimSecret as string);

    expect((await g.pairing.get(undefined, created.handle)).state).toBe('pending');
    expect(g.embassy.claimCount()).toBe(0);
    g.embassy.approve();
    const connected = await g.pairing.get(undefined, created.handle);
    expect(connected.state).toBe('connected');
    expect(connected.connectionId).toBe(onDisk.connectionId);
    expect(connected).not.toHaveProperty('requestQr');
    const rooms = g.guest.list(undefined).connections;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: onDisk.connectionId, roomId: ROOM, roomName: 'Pilot', origin: ORIGIN });
    // Connected polls never claim again, and make no pairing call at all.
    const callsBefore = g.embassy.calls.filter((c) => c.path.startsWith('/api/embassy/pair-')).length;
    await g.pairing.get(undefined, created.handle);
    await g.pairing.tick();
    expect(g.embassy.claimCount()).toBe(1);
    expect(g.embassy.calls.filter((c) => c.path.startsWith('/api/embassy/pair-')).length).toBe(callsBefore);
    const shown = JSON.stringify([created, connected, g.pairing.list(undefined)]);
    for (const secret of [onDisk.claimSecret, onDisk.claimHash, qr.split('|')[3]]) expect(shown).not.toContain(secret);
  });

  it('PC-K1: a lost ACK leaves the token on disk; a restart re-sends the identical request and gets the same one', async () => {
    const g = await guestConsole();
    const qr = g.embassy.issue();
    g.embassy.loseAnswer.add('/api/embassy/pair-request');
    const created = await g.pairing.create(undefined, { qr, clientRequestId: randomUUID() });
    expect(created.state).toBe('creating');
    expect(created).not.toHaveProperty('requestQr');
    const before = record(g.dir, created.handle);
    expect(before.token).toBe(qr.split('|')[3]);
    const admitted = g.embassy.only();

    const after = await g.boot(); // console restart on the same data
    await after.pairing.tick();
    const view = await after.pairing.get(undefined, created.handle);
    expect(view.state).toBe('pending');
    expect(g.embassy.requests.size).toBe(1);
    expect(record(g.dir, created.handle).requestId).toBe(admitted.id);
    expect(record(g.dir, created.handle).token).toBeUndefined();
    const sends = g.embassy.calls.filter((c) => c.path === '/api/embassy/pair-request');
    expect(sends).toHaveLength(2);
    expect(sends[1].body).toEqual(sends[0].body);
  });

  it('Inspector note 1: a recovered request keeps its real state instead of pending', async () => {
    for (const hostDid of ['approved', 'rejected'] as const) {
      const g = await guestConsole();
      g.embassy.loseAnswer.add('/api/embassy/pair-request');
      const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
      expect(created.state).toBe('creating');
      g.embassy.only();
      // The host acted while this console never heard back.
      g.embassy.request(g.embassy.only().id).state = hostDid;
      const after = await g.boot();
      await after.pairing.tick();
      // The recovery answer itself decides the state: no pair-status call was needed to learn it.
      expect(record(g.dir, created.handle).state).toBe(hostDid === 'approved' ? 'connected' : 'rejected');
      expect(g.embassy.calls.some((c) => c.path === '/api/embassy/pair-status')).toBe(false);
      const view = await after.pairing.get(undefined, created.handle);
      expect(view.state).toBe(hostDid === 'approved' ? 'connected' : 'rejected');
      expect(g.embassy.claimCount()).toBe(hostDid === 'approved' ? 1 : 0);
    }
  });

  it('Inspector note 2: one clientRequestId is admitted once, before any handle exists, even when sends race', async () => {
    const g = await guestConsole();
    const qr = g.embassy.issue();
    const clientRequestId = randomUUID();
    const release = g.embassy.hold('/api/embassy/pair-request');
    const racing = [1, 2, 3].map(() => g.pairing.create(undefined, { qr, clientRequestId }));
    await flush();
    release();
    const views = await Promise.all(racing);
    expect(new Set(views.map((v) => v.handle)).size).toBe(1);
    expect(recordFiles(g.dir)).toHaveLength(1);
    expect(g.embassy.requests.size).toBe(1);
    expect(views.every((v) => v.state === 'pending')).toBe(true);
    // A retry after a restart still returns the same handle.
    const after = await g.boot();
    expect((await after.pairing.create(undefined, { qr, clientRequestId })).handle).toBe(views[0].handle);
    expect(recordFiles(g.dir)).toHaveLength(1);
  });

  it('Inspector note 3: a timeout or 5xx never rotates the session; only a refused or missing one is re-claimed', async () => {
    const g = await guestConsole();
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    g.embassy.approve();
    expect((await g.pairing.get(undefined, created.handle)).state).toBe('connected');
    const connectionId = record(g.dir, created.handle).connectionId as string;
    await flush();
    expect(g.guest.list(undefined).connections[0].status).toBe('live');

    // Network failure, then a 5xx on the room poll: the session is still possibly valid. Reconnect keeps it.
    g.embassy.down = true;
    await g.guest.tick();
    g.embassy.down = false;
    g.embassy.fail5xx.add(`/embassy/rooms/${ROOM}/posts?after=0`);
    await g.guest.tick();
    g.embassy.fail5xx.clear();
    expect((await g.pairing.reconnect(undefined, created.handle)).state).toBe('connected');
    expect(g.embassy.claimCount()).toBe(1);
    // A crash after the upsert but before `connected`: the stored session counts, no re-claim on restore.
    const raw = record(g.dir, created.handle);
    writeFileSync(join(g.dir, 'embassy-pairings', `${created.handle}.json`), JSON.stringify({ ...raw, state: 'approved' }));
    const after = await g.boot();
    expect((await after.pairing.get(undefined, created.handle)).state).toBe('connected');
    expect(g.embassy.claimCount()).toBe(1);

    // The embassy refuses the stored session (401): now, and only on the owner's reconnect, one re-claim.
    g.embassy.sessions.clear();
    await after.guest.tick();
    expect(after.guest.list(undefined).connections[0].status).toBe('expired');
    await after.pairing.tick();
    expect((await after.pairing.get(undefined, created.handle)).state).toBe('connected');
    expect(g.embassy.claimCount()).toBe(1); // a refused session is re-claimed only on the owner's reconnect
    const back = await after.pairing.reconnect(undefined, created.handle);
    expect(back.state).toBe('connected');
    expect(back.connectionId).toBe(connectionId);
    expect(g.embassy.claimCount()).toBe(2);
    await flush();
    const rooms = after.guest.list(undefined).connections;
    expect(rooms).toHaveLength(1);
    expect(rooms[0].status).toBe('live');
  });

  it('Inspector note 4: a retired binding refuses a late claim and a late save', async () => {
    const g = await guestConsole();
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    g.embassy.approve();
    const release = g.embassy.hold('/api/embassy/pair-claim');
    const polling = g.pairing.get(undefined, created.handle); // claim now in flight under the lock
    await flush();
    const cancelling = g.pairing.cancel(undefined, created.handle); // generation bumped at once, then waits
    release();
    const [polled, cancelled] = await Promise.all([polling, cancelling]);
    expect(polled.state).not.toBe('connected');
    expect(cancelled.state).toBe('cancelled');
    const connectionId = record(g.dir, created.handle).connectionId as string;
    // The late session was never stored, the embassy heard the cancel, and nothing can revive the binding.
    expect(g.guest.holds(undefined, connectionId)).toBe(false);
    expect(g.guest.list(undefined).connections.filter((c) => c.status !== 'left')).toHaveLength(0);
    expect(g.embassy.calls.some((c) => c.path === '/api/embassy/pair-cancel')).toBe(true);
    expect(g.embassy.only().state).toBe('revoked');
    expect(g.embassy.sessions.size).toBe(0);
    // Retire a live binding, then try a late save under its id.
    const h = await guestConsole();
    const c2 = await h.pairing.create(undefined, { qr: h.embassy.issue(), clientRequestId: randomUUID() });
    h.embassy.approve();
    await h.pairing.get(undefined, c2.handle);
    const id2 = record(h.dir, c2.handle).connectionId as string;
    await h.pairing.cancel(undefined, c2.handle);
    const late = {
      sessionToken: 'L'.repeat(43),
      hostCompany: 'Host',
      room: { id: ROOM, name: 'Pilot' },
      guest: { company: 'Lab', identity: 'g' },
      expiresAt: Date.now() + 1000_000,
    };
    await expect(h.guest.adopt(undefined, id2, ORIGIN, ROOM, late)).rejects.toThrow(/cancelled/);
    expect(h.guest.holds(undefined, id2)).toBe(false);
    expect((await h.pairing.get(undefined, c2.handle)).state).toBe('cancelled');
    expect(record(h.dir, c2.handle).cancelPending).toBe(false);
  });

  it('cancel before the request was confirmed recovers the request first, then cancels it', async () => {
    const g = await guestConsole();
    g.embassy.loseAnswer.add('/api/embassy/pair-request');
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    expect(created.state).toBe('creating');
    await g.pairing.cancel(undefined, created.handle);
    expect(g.embassy.only().state).toBe('revoked');
    expect(record(g.dir, created.handle).token).toBeUndefined();
    expect(recordFiles(g.dir)).toHaveLength(1); // kept, not deleted
  });

  it('a refused invite fails without a replacement; claim limit and malformed QR are reported', async () => {
    const g = await guestConsole();
    const qr = g.embassy.issue();
    const forged = qr.replace(/\|[^|]+$/, `|${'Z'.repeat(43)}`);
    const refused = await g.pairing.create(undefined, { qr: forged, clientRequestId: randomUUID() });
    expect(refused).toMatchObject({ state: 'failed', error: 'INVALID_INVITE' });
    expect(record(g.dir, refused.handle).token).toBeUndefined();
    await g.pairing.tick();
    expect(g.embassy.calls.filter((c) => c.path === '/api/embassy/pair-request')).toHaveLength(1);
    const wrongRoom = await g.pairing.create(undefined, {
      qr: qr.replace(ROOM, '00000000-0000-4000-8000-000000000000'),
      clientRequestId: randomUUID(),
    });
    expect(wrongRoom.state).toBe('failed');
    expect(g.embassy.requests.size).toBe(0); // the room check never consumed the invite
    await expect(g.pairing.create(undefined, { qr: 'embassy-v1|x', clientRequestId: randomUUID() })).rejects.toMatchObject({
      status: 400,
      code: 'PAIR_BAD_QR',
    });
    const ok = await g.pairing.create(undefined, { qr, clientRequestId: randomUUID() });
    g.embassy.approve();
    g.embassy.request(g.embassy.only().id).claims = 10;
    expect(await g.pairing.get(undefined, ok.handle)).toMatchObject({ state: 'failed', error: 'CLAIM_LIMIT' });
  });

  it('records are private files in a private directory', async () => {
    const g = await guestConsole();
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    expect(statSync(join(g.dir, 'embassy-pairings')).mode & 0o777).toBe(0o700);
    expect(statSync(join(g.dir, 'embassy-pairings', `${created.handle}.json`)).mode & 0o777).toBe(0o600);
  });
});

// ---------- host side ----------

function fakeChannel(room = ROOM) {
  const calls: EmbassyChannelCall[] = [];
  const invites = new Map<string, { id: string; idemKey: string; requestState: string | null; revoked: boolean }>();
  let fail: Error | undefined;
  let answer: { status: number; body: unknown } | undefined;
  const transport = async (call: EmbassyChannelCall) => {
    calls.push(call);
    if (fail) throw fail;
    if (answer) return answer;
    const base = `/embassy/channel/rooms/${room}`;
    if (call.method === 'GET' && call.path === base) return { status: 200, body: { room: { id: room, name: 'Pilot' }, origin: ORIGIN } };
    if (call.method === 'POST' && call.path === `${base}/invites`) {
      const idemKey = (call.body as { idemKey: string }).idemKey;
      let inv = [...invites.values()].find((i) => i.idemKey === idemKey);
      const replayed = !!inv;
      if (!inv) {
        inv = { id: randomUUID(), idemKey, requestState: null, revoked: false };
        invites.set(inv.id, inv);
      }
      const open = !inv.requestState && !inv.revoked;
      return {
        status: replayed ? 200 : 201,
        body: {
          invite: { id: inv.id, roomId: room, expiresAt: Date.now() + 900_000, revoked: inv.revoked, requestId: null, requestState: inv.requestState, guest: null },
          key: open ? `embassy-v2|${ORIGIN}|${room}|${'K'.repeat(43)}` : null,
          replayed,
        },
      };
    }
    if (call.method === 'GET' && call.path === `${base}/invites`)
      return {
        status: 200,
        body: {
          invites: [...invites.values()].map((i) => ({
            id: i.id,
            roomId: room,
            expiresAt: Date.now() + 900_000,
            revoked: i.revoked,
            requestId: i.requestState ? randomUUID() : null,
            requestState: i.requestState,
            guest: i.requestState ? { company: 'Lab', identity: 'Student One' } : null,
          })),
        },
      };
    if (call.method === 'POST' && call.path === `${base}/pair/lookup`)
      return {
        status: 200,
        body: { requestId: '00000009-000a-4000-8000-00000000000b', state: 'claimed', company: 'Lab', identity: 'Student One', expiresAt: 1 },
      };
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } };
  };
  return {
    calls,
    invites,
    transport,
    failWith: (e?: Error) => (fail = e),
    answerWith: (a?: { status: number; body: unknown }) => (answer = a),
  };
}

async function hostConsole(configured = true) {
  const dir = temp();
  const channel = fakeChannel();
  const host = new EmbassyHost({ dir: join(dir, 'embassy-channel'), opsFile: join(dir, 'embassy-host', 'ops.json'), transport: channel.transport });
  await host.init();
  if (configured) writeFileSync(join(dir, 'embassy-channel', 'channel.json'), JSON.stringify({ v: 1, roomId: ROOM }));
  const secret = readFileSync(join(dir, 'embassy-channel', 'secret'), 'utf8');
  return { dir, channel, host, secret };
}

describe('r5: cancellation confirmation and room binding (Inspector CP-K1..K3)', () => {
  type Hook = (r: EmbassyGuestRequest) => EmbassyGuestResponse | undefined;
  /** A fake whose answers a test can override at any time (the hook is read on every call). */
  const hooked = () => {
    const e = new FakeEmbassy();
    const send = e.transport;
    const box: { hook?: Hook } = {};
    e.transport = async (r) => box.hook?.(r) ?? send(r);
    return { e, box };
  };
  const err = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });

  it('CP-K1: an unconfirmed cancel answers cancelling, is durable across a restart, and a later read confirms it', async () => {
    const g = await guestConsole();
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    g.embassy.down = true;
    expect((await g.pairing.cancel(undefined, created.handle)).state).toBe('cancelling');
    expect(record(g.dir, created.handle)).toMatchObject({ state: 'cancelling', cancelPending: true });
    expect(g.embassy.only().state).toBe('pending');
    const after = await g.boot();
    expect((await after.pairing.get(undefined, created.handle)).state).toBe('cancelling'); // still down
    g.embassy.down = false;
    expect((await after.pairing.get(undefined, created.handle)).state).toBe('cancelled');
    expect(g.embassy.only().state).toBe('revoked');
    expect(record(g.dir, created.handle).cancelPending).toBe(false);
    // A second cancel on a confirmed record sends nothing.
    const sent = g.embassy.calls.length;
    expect((await after.pairing.cancel(undefined, created.handle)).state).toBe('cancelled');
    expect(g.embassy.calls.length).toBe(sent);
  });

  it('an r4 record saved as cancelled with the debt still owed loads as cancelling and is driven to cancelled', async () => {
    const g = await guestConsole();
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    g.embassy.down = true;
    await g.pairing.cancel(undefined, created.handle);
    const raw = record(g.dir, created.handle);
    writeFileSync(join(g.dir, 'embassy-pairings', `${created.handle}.json`), JSON.stringify({ ...raw, state: 'cancelled' }));
    const after = await g.boot();
    expect((await after.pairing.get(undefined, created.handle)).state).toBe('cancelling');
    g.embassy.down = false;
    await after.pairing.tick();
    expect((await after.pairing.get(undefined, created.handle)).state).toBe('cancelled');
    expect(g.embassy.only().state).toBe('revoked');
  });

  it('only 404 PAIR_NOT_FOUND confirms a cancel; another 404, 408, 429 or a malformed 200 keeps the debt', async () => {
    const { e, box } = hooked();
    const g = await guestConsole(e);
    const created = await g.pairing.create(undefined, { qr: e.issue(), clientRequestId: randomUUID() });
    for (const answer of [err(404, 'NOT_FOUND'), err(408, 'REQUEST_TIMEOUT'), err(429, 'RATE_LIMIT'), { status: 200, body: { state: 'pending' } }]) {
      box.hook = (r) => (r.path === '/api/embassy/pair-cancel' ? answer : undefined);
      expect((await g.pairing.cancel(undefined, created.handle)).state).toBe('cancelling');
      expect(record(g.dir, created.handle)).toMatchObject({ cancelPending: true, requestId: e.only().id });
    }
    box.hook = (r) => (r.path === '/api/embassy/pair-cancel' ? err(404, 'PAIR_NOT_FOUND') : undefined);
    expect((await g.pairing.get(undefined, created.handle)).state).toBe('cancelled');
    expect(record(g.dir, created.handle).cancelPending).toBe(false);
  });

  it('CP-K2: an unconfirmed recovery answer (malformed 200, 408, uncorrelated 401) keeps the only token', async () => {
    for (const answer of [{ status: 200, body: {} }, err(408, 'REQUEST_TIMEOUT'), err(401, 'INVALID_ACCESS')]) {
      const { e, box } = hooked();
      e.loseAnswer.add('/api/embassy/pair-request');
      const g = await guestConsole(e);
      const qr = e.issue();
      const created = await g.pairing.create(undefined, { qr, clientRequestId: randomUUID() });
      expect(created.state).toBe('creating');
      box.hook = (r) => (r.path === '/api/embassy/pair-request' ? answer : undefined);
      await g.pairing.get(undefined, created.handle);
      expect(record(g.dir, created.handle).token).toBe(qr.split('|')[3]);
      expect((await g.pairing.cancel(undefined, created.handle)).state).toBe('cancelling');
      expect(record(g.dir, created.handle)).toMatchObject({ token: qr.split('|')[3], cancelPending: true });
      expect(e.only().state).toBe('pending');
      box.hook = undefined; // the identical request now gets its replay, then the cancel is confirmed
      expect((await g.pairing.get(undefined, created.handle)).state).toBe('cancelled');
      expect(e.only().state).toBe('revoked');
      expect(record(g.dir, created.handle).token).toBeUndefined();
    }
  });

  it('a pending poll fails only on 404 PAIR_NOT_FOUND; another 404 or 401 code leaves it pending', async () => {
    const { e, box } = hooked();
    const g = await guestConsole(e);
    const created = await g.pairing.create(undefined, { qr: e.issue(), clientRequestId: randomUUID() });
    for (const answer of [err(404, 'NOT_FOUND'), err(401, 'INVALID_ACCESS')]) {
      box.hook = (r) => (r.path === '/api/embassy/pair-status' ? answer : undefined);
      expect((await g.pairing.get(undefined, created.handle)).state).toBe('pending');
    }
    box.hook = (r) => (r.path === '/api/embassy/pair-status' ? err(404, 'PAIR_NOT_FOUND') : undefined);
    expect(await g.pairing.get(undefined, created.handle)).toMatchObject({ state: 'failed', error: 'PAIR_NOT_FOUND' });
  });

  it('CP-K3: the guest store refuses to adopt a claim for another room, or to rebind a connection to another room', async () => {
    const g = await guestConsole();
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    g.embassy.approve();
    expect((await g.pairing.get(undefined, created.handle)).state).toBe('connected');
    const id = record(g.dir, created.handle).connectionId as string;
    const other = randomUUID();
    const claimed = (room: string) => ({
      sessionToken: 'R'.repeat(43),
      hostCompany: 'Host',
      room: { id: room, name: 'Other' },
      guest: { company: 'Lab', identity: 'g' },
      expiresAt: Date.now() + 1000_000,
    });
    await expect(g.guest.adopt(undefined, id, ORIGIN, ROOM, claimed(other))).rejects.toThrow();
    await expect(g.guest.adopt(undefined, id, ORIGIN, other, claimed(other))).rejects.toThrow(/another room/);
    await expect(g.guest.adopt(undefined, id, 'https://elsewhere.example', ROOM, claimed(ROOM))).rejects.toThrow(/another room/);
    expect(g.guest.binding(undefined, id)).toEqual({ origin: ORIGIN, roomId: ROOM.toLowerCase() });
  });

  it('CP-K3: a reconnect whose claim names another room fails PAIR_ROOM_MISMATCH and stores nothing', async () => {
    const { e, box } = hooked();
    const g = await guestConsole(e);
    const created = await g.pairing.create(undefined, { qr: e.issue(), clientRequestId: randomUUID() });
    e.approve();
    expect((await g.pairing.get(undefined, created.handle)).state).toBe('connected');
    const id = record(g.dir, created.handle).connectionId as string;
    e.sessions.clear();
    // Wait (bounded) until the guest store has seen the 401, so reconnect re-claims.
    for (let i = 0; i < 50 && g.guest.holds(undefined, id); i++) {
      await flush();
      await g.guest.tick();
    }
    expect(g.guest.holds(undefined, id)).toBe(false);
    const other = randomUUID();
    box.hook = (r) => {
      if (r.path !== '/api/embassy/pair-claim') return undefined;
      return { status: 200, body: { sessionToken: 'W'.repeat(43), hostCompany: 'Host', room: { id: other, name: 'Wrong' }, guest: { company: 'Lab', identity: 'g' }, expiresAt: Date.now() + 1000_000 } };
    };
    const back = await g.pairing.reconnect(undefined, created.handle);
    expect(back).toMatchObject({ state: 'failed', error: 'PAIR_ROOM_MISMATCH' });
    expect(g.guest.holds(undefined, id)).toBe(false);
    expect(g.guest.binding(undefined, id)).toEqual({ origin: ORIGIN, roomId: ROOM.toLowerCase() });
    expect(record(g.dir, created.handle).requestId).toBe(e.only().id); // kept, so cancel can still end it
    expect((await g.pairing.cancel(undefined, created.handle)).state).toBe('cancelled');
  });

  it('CP-K3: a reconnect over a connection bound to another room fails PAIR_ROOM_MISMATCH before any adopt', async () => {
    const g = await guestConsole();
    const created = await g.pairing.create(undefined, { qr: g.embassy.issue(), clientRequestId: randomUUID() });
    g.embassy.approve();
    expect((await g.pairing.get(undefined, created.handle)).state).toBe('connected');
    const id = record(g.dir, created.handle).connectionId as string;
    const file = join(g.dir, 'embassy-guest.json');
    const store = JSON.parse(readFileSync(file, 'utf8')) as { connections: Array<{ id: string; roomId: string; status: string }> };
    const other = randomUUID();
    // A store whose binding names another room, with a refused session, so reconnect re-claims.
    for (const c of store.connections) if (c.id === id) Object.assign(c, { roomId: other, status: 'expired' });
    writeFileSync(file, JSON.stringify(store));
    const after = await g.boot();
    const claims = g.embassy.claimCount();
    expect(after.guest.holds(undefined, id)).toBe(false);
    expect(await after.pairing.reconnect(undefined, created.handle)).toMatchObject({ state: 'failed', error: 'PAIR_ROOM_MISMATCH' });
    expect(after.guest.binding(undefined, id)?.roomId).toBe(other); // never rebound
    expect(g.embassy.claimCount()).toBe(claims + 1);
  });
});

describe('pilot limits (Reviewer and Inspector, 4:50 AM ET)', () => {
  it('GUEST_LABEL is definite: invite unconsumed, DELETE confirms cancelled at once, start over is a new claimant', async () => {
    const g = await guestConsole();
    g.embassy.takenLabels.add('Owner');
    const qr = g.embassy.issue();
    const token = qr.split('|')[3];
    const first = randomUUID();
    const refused = await g.pairing.create(undefined, { qr, clientRequestId: first, identity: 'Owner' });
    expect(refused).toMatchObject({ state: 'failed', error: 'GUEST_LABEL' });
    const old = record(g.dir, refused.handle);
    expect(old.token).toBeUndefined();
    expect(g.embassy.invites.get(token)!.requestId).toBeUndefined();
    const sent = g.embassy.calls.length;
    const cancelled = await g.pairing.cancel(undefined, refused.handle);
    expect(cancelled.state).toBe('cancelled');
    expect(g.embassy.calls.length).toBe(sent); // nothing left to recover or cancel
    expect(record(g.dir, refused.handle).cancelPending).toBe(false);
    // The old clientRequestId still names the old, cancelled handle: never a second claimant on it.
    expect(await g.pairing.create(undefined, { qr, clientRequestId: first, identity: 'Guest Two' })).toMatchObject({
      handle: refused.handle,
      state: 'cancelled',
    });
    // Start over: a fresh clientRequestId and labels give a new handle and a new claim binding on the same invite.
    const fresh = await g.pairing.create(undefined, { qr, clientRequestId: randomUUID(), identity: 'Guest Two' });
    expect(fresh.state).toBe('pending');
    expect(fresh.handle).not.toBe(refused.handle);
    const now = record(g.dir, fresh.handle);
    expect(now.claimHash).not.toBe(old.claimHash);
    expect(now.claimSecret).not.toBe(old.claimSecret);
    expect(g.embassy.only().claimHash).toBe(now.claimHash);
  });

  it('a pairing that failed unconfirmed keeps its token, so cancel still finds and ends a lost-ACK request', async () => {
    let t = Date.now();
    const g = await guestConsole(new FakeEmbassy(), temp(), () => t);
    const qr = g.embassy.issue();
    g.embassy.loseAnswer.add('/api/embassy/pair-request');
    const created = await g.pairing.create(undefined, { qr, clientRequestId: randomUUID() });
    expect(created.state).toBe('creating');
    const lost = g.embassy.only(); // the embassy made the request; the console never heard
    g.embassy.down = true;
    t += 61 * 60_000;
    expect(await g.pairing.get(undefined, created.handle)).toMatchObject({ state: 'failed', error: 'EMBASSY_UNREACHABLE' });
    expect(record(g.dir, created.handle).token).toBe(qr.split('|')[3]);
    g.embassy.down = false;
    expect((await g.pairing.cancel(undefined, created.handle)).state).toBe('cancelled');
    expect(g.embassy.request(lost.id).state).toBe('revoked');
    const after = record(g.dir, created.handle);
    expect(after.token).toBeUndefined();
    expect(after.cancelPending).toBe(false);
  });

  it('records are owner-bound: another owner, or the single-user owner, gets NOT_FOUND and changes nothing', async () => {
    const g = await guestConsole();
    const qr = g.embassy.issue();
    const mine = await g.pairing.create('alice', { qr, clientRequestId: randomUUID() });
    expect(mine.state).toBe('pending');
    for (const other of ['bob', undefined]) {
      await expect(Promise.resolve().then(() => g.pairing.get(other, mine.handle))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(Promise.resolve().then(() => g.pairing.cancel(other, mine.handle))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(Promise.resolve().then(() => g.pairing.reconnect(other, mine.handle))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await g.pairing.list(other)).pairings).toEqual([]);
    }
    expect(record(g.dir, mine.handle).state).toBe('pending');
    expect(g.embassy.only().state).toBe('pending');
  });

  it('host status carries an opaque bindingId that changes with the host binding (cache fence only)', async () => {
    const a = await hostConsole();
    const s1 = await a.host.status();
    expect(s1.bindingId).toMatch(/^[0-9a-f]{32}$/);
    const again = new EmbassyHost({ dir: join(a.dir, 'embassy-channel'), opsFile: join(a.dir, 'ops2.json'), transport: a.channel.transport });
    await again.init();
    expect((await again.status()).bindingId).toBe(s1.bindingId);
    // Same S, another room: a new binding.
    const room2 = randomUUID();
    writeFileSync(join(a.dir, 'embassy-channel', 'channel.json'), JSON.stringify({ v: 1, roomId: room2 }));
    const moved = new EmbassyHost({ dir: join(a.dir, 'embassy-channel'), opsFile: join(a.dir, 'ops3.json'), transport: fakeChannel(room2).transport });
    await moved.init();
    const s2 = await moved.status();
    expect(s2.room?.id).toBe(room2);
    expect(s2.bindingId).toMatch(/^[0-9a-f]{32}$/);
    expect(s2.bindingId).not.toBe(s1.bindingId);
    const b = await hostConsole(); // a new S is a new binding
    expect((await b.host.status()).bindingId).not.toBe(s1.bindingId);
    expect(JSON.stringify(s1)).not.toContain(a.secret);
    expect(JSON.stringify(s1)).not.toContain(createHash('sha256').update(a.secret).digest('hex'));
    expect((await (await hostConsole(false)).host.status()).bindingId).toBeUndefined();
  });
});

describe('embassy hosting through the channel (contract r2 §1, §4)', () => {
  it('creates S once, private, and publishes only its sha256', async () => {
    const h = await hostConsole();
    expect(h.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(h.dir, 'embassy-channel')).mode & 0o777).toBe(0o700);
    expect(statSync(join(h.dir, 'embassy-channel', 'secret')).mode & 0o777).toBe(0o600);
    const digest = readFileSync(join(h.dir, 'embassy-channel', 'channel.sha256'), 'utf8').trim();
    expect(digest).toBe(createHash('sha256').update(h.secret).digest('hex'));
    const again = new EmbassyHost({ dir: join(h.dir, 'embassy-channel'), opsFile: join(h.dir, 'ops.json') });
    await again.init();
    expect(readFileSync(join(h.dir, 'embassy-channel', 'secret'), 'utf8')).toBe(h.secret);
    writeFileSync(join(h.dir, 'embassy-channel', 'secret'), 'garbage');
    await expect(again.init()).rejects.toThrow(/malformed/);
    expect(readFileSync(join(h.dir, 'embassy-channel', 'secret'), 'utf8')).toBe('garbage');
  });

  it('fails closed: unconfigured without channel.json, unconfigured on a channel refusal, unreachable on no answer', async () => {
    const bare = await hostConsole(false);
    expect(await bare.host.status()).toEqual({ status: 'unconfigured' });
    await expect(bare.host.listInvites()).rejects.toMatchObject({ status: 503, code: 'HOSTING_UNCONFIGURED' });
    expect(bare.channel.calls).toHaveLength(0);
    const h = await hostConsole();
    expect(await h.host.status()).toEqual({ status: 'ready', origin: ORIGIN, room: { id: ROOM, name: 'Pilot' }, bindingId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(h.channel.calls[0]).toMatchObject({ method: 'GET', path: `/embassy/channel/rooms/${ROOM}`, bearer: h.secret });
    h.channel.answerWith({ status: 401, body: { error: { code: 'CHANNEL_REQUIRED', message: 'x' } } });
    expect(await h.host.status()).toEqual({ status: 'unconfigured' });
    h.channel.answerWith(undefined);
    h.channel.failWith(new Error('refused'));
    expect(await h.host.status()).toEqual({ status: 'unreachable' });
    await expect(h.host.listInvites()).rejects.toMatchObject({ status: 502, code: 'EMBASSY_UNREACHABLE' });
  });

  it('PC-K2: the idemKey is durable before the call; any retry reconciles the same invite and never replaces it', async () => {
    const h = await hostConsole();
    const clientRequestId = randomUUID();
    h.channel.failWith(new Error('lost'));
    await expect(h.host.createInvite(clientRequestId)).rejects.toMatchObject({ code: 'EMBASSY_UNREACHABLE' });
    const ops = JSON.parse(readFileSync(join(h.dir, 'embassy-host', 'ops.json'), 'utf8'));
    const idemKey = ops.ops[clientRequestId].idemKey;
    expect(idemKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(join(h.dir, 'embassy-host', 'ops.json')).mode & 0o777).toBe(0o600);
    h.channel.failWith(undefined);
    const first = await h.host.createInvite(clientRequestId);
    expect(first).toMatchObject({ qrAvailable: true, state: 'open' });
    expect(first.qr).toMatch(/^embassy-v2\|/);
    // A restarted console replays the same key and gets the same invite; once it is used, no QR and the true state.
    const restarted = new EmbassyHost({ dir: join(h.dir, 'embassy-channel'), opsFile: join(h.dir, 'embassy-host', 'ops.json'), transport: h.channel.transport });
    await restarted.init();
    h.channel.invites.get(first.inviteId)!.requestState = 'claimed';
    const replay = await restarted.createInvite(clientRequestId);
    expect(replay).toMatchObject({ inviteId: first.inviteId, qr: null, qrAvailable: false, state: 'connected' });
    expect(h.channel.invites.size).toBe(1);
    const sent = h.channel.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { idemKey: string }).idemKey);
    expect(new Set(sent)).toEqual(new Set([idemKey]));
    expect(h.channel.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('refuses a new operation at the ops cap and never trims', async () => {
    const h = await hostConsole();
    const ops: Record<string, { idemKey: string }> = {};
    for (let i = 0; i < EMBASSY_HOST_OPS_MAX; i++) ops[randomUUID()] = { idemKey: randomUUID() };
    mkdirSync(join(h.dir, 'embassy-host'), { mode: 0o700 });
    writeFileSync(join(h.dir, 'embassy-host', 'ops.json'), JSON.stringify({ v: 1, ops }));
    await expect(h.host.createInvite(randomUUID())).rejects.toMatchObject({ status: 409, code: 'INVITE_LIMIT' });
    const after = JSON.parse(readFileSync(join(h.dir, 'embassy-host', 'ops.json'), 'utf8'));
    expect(after.ops).toEqual(ops);
    expect(h.channel.calls).toHaveLength(0);
    // A known operation still replays at the cap.
    const known = Object.keys(ops)[0];
    expect((await h.host.createInvite(known)).state).toBe('open');
  });

  it('lookup checks the request QR origin; codes are normalized; claimed reads as connected', async () => {
    const h = await hostConsole();
    const id = '00000009-000a-4000-8000-00000000000b';
    await expect(
      h.host.lookup({ qr: `embassy-pair-v1|https://other.example.ts.net|${id}|ABCDEFGH` })
    ).rejects.toMatchObject({ status: 400, code: 'PAIR_WRONG_HOST' });
    expect(h.channel.calls.some((c) => c.path.endsWith('/pair/lookup'))).toBe(false);
    const found = await h.host.lookup({ qr: `embassy-pair-v1|${ORIGIN}|${id}|ABCDEFGH` });
    expect(found).toMatchObject({ requestId: id, state: 'connected', guest: { company: 'Lab', identity: 'Student One' } });
    expect(h.channel.calls.at(-1)!.body).toEqual({ code: 'ABCDEFGH', requestId: id });
    await h.host.lookup({ code: 'abcd-efgh' });
    expect(h.channel.calls.at(-1)!.body).toEqual({ code: 'ABCDEFGH' });
    await expect(h.host.lookup({ code: 'ILOU-0000' })).rejects.toMatchObject({ code: 'PAIR_BAD_QR' });
    h.channel.invites.set('a', { id: 'a', idemKey: 'k', requestState: 'pending', revoked: false });
    h.channel.invites.set('b', { id: 'b', idemKey: 'k2', requestState: null, revoked: true });
    expect((await h.host.listInvites()).map((i) => i.state).sort()).toEqual(['pending', 'revoked']);
    h.channel.answerWith({ status: 404, body: { error: { code: 'PAIR_NOT_FOUND', message: 'x' } } });
    await expect(h.host.decide('approve', id, 'ABCD-EFGH')).rejects.toMatchObject({ status: 404, code: 'PAIR_NOT_FOUND' });
  });

  it('the loopback transport sends the bearer with a loopback Host and no Origin, and bounds the answer', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/big') {
        res.writeHead(200);
        res.end('x'.repeat(1024 * 1024 + 10));
        return;
      }
      if (req.url === '/slow') return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const send = createEmbassyChannelHttp(port, 300);
      const res = await send({ method: 'POST', path: '/x', body: { a: 1 }, bearer: 'B'.repeat(43) });
      expect(res).toEqual({ status: 200, body: { ok: true } });
      expect(seen[0].host).toBe(`127.0.0.1:${port}`);
      expect(seen[0].authorization).toBe(`Bearer ${'B'.repeat(43)}`);
      expect(seen[0].origin).toBeUndefined();
      await expect(send({ method: 'GET', path: '/big', bearer: 'B'.repeat(43) })).rejects.toThrow(/unreachable/);
      await expect(send({ method: 'GET', path: '/slow', bearer: 'B'.repeat(43) })).rejects.toThrow(/unreachable/);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('embassy pairing routes', () => {
  it('owner only; contract codes; no secret in any answer', async () => {
    const h = await hostConsole();
    const g = await guestConsole();
    let owner = true;
    const app = Fastify();
    registerEmbassyPairingRoutes(app, h.host, g.pairing, () => owner, () => buildHostPolicy('127.0.0.1'));
    const call = (opts: InjectOptions) =>
      app.inject({ ...opts, headers: { 'x-reverie-csrf': '1', ...(opts.headers as Record<string, string>) } });
    try {
      for (const url of ['/api/embassy-host', '/api/embassy-pairing']) {
        const agent = await call({ method: 'GET', url, headers: { 'x-reverie-parent-session': 'x' } });
        expect(agent.statusCode).toBe(403);
        expect(agent.json().errorCode).toBe('OWNER_ONLY');
      }
      owner = false;
      expect((await call({ method: 'POST', url: '/api/embassy-host/invites', payload: { clientRequestId: randomUUID() } })).statusCode).toBe(403);
      owner = true;
      const bodies: string[] = [];
      const status = await call({ method: 'GET', url: '/api/embassy-host' });
      bodies.push(status.body);
      expect(status.json().data.status).toBe('ready');
      const invite = await call({ method: 'POST', url: '/api/embassy-host/invites', payload: { clientRequestId: randomUUID() } });
      bodies.push(invite.body);
      expect(invite.json().data.qrAvailable).toBe(true);
      const wrong = await call({
        method: 'POST',
        url: '/api/embassy-host/lookup',
        payload: { qr: `embassy-pair-v1|https://other.example.ts.net|00000009-000a-4000-8000-00000000000b|ABCDEFGH` },
      });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().errorCode).toBe('PAIR_WRONG_HOST');
      const qr = g.embassy.issue();
      const paired = await call({ method: 'POST', url: '/api/embassy-pairing', payload: { qr, clientRequestId: randomUUID() } });
      bodies.push(paired.body);
      expect(paired.json().data.state).toBe('pending');
      const handle = paired.json().data.handle;
      g.embassy.approve();
      const polled = await call({ method: 'GET', url: `/api/embassy-pairing/${handle}` });
      bodies.push(polled.body);
      expect(polled.json().data.state).toBe('connected');
      bodies.push((await call({ method: 'GET', url: '/api/embassy-pairing' })).body);
      bodies.push((await call({ method: 'POST', url: `/api/embassy-pairing/${handle}/reconnect` })).body);
      const cancelled = await call({ method: 'DELETE', url: `/api/embassy-pairing/${handle}` });
      expect(cancelled.json().data.state).toBe('cancelled');
      expect((await call({ method: 'GET', url: '/api/embassy-pairing/nothex' })).statusCode).toBe(404);
      const bad = await call({ method: 'POST', url: '/api/embassy-pairing', payload: { qr, clientRequestId: 'x' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain(qr.split('|')[3]);
      const rec = record(g.dir, handle);
      const all = bodies.join('\n');
      for (const secret of [h.secret, rec.claimSecret as string, rec.claimHash as string, qr.split('|')[3]])
        expect(all).not.toContain(secret);
      expect(existsSync(join(h.dir, 'embassy-channel', 'secret'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("Inspector's CSRF controls: marker, foreign and null Origin, anonymous, owner plus agent", async () => {
    const h = await hostConsole();
    const g = await guestConsole();
    let owner = true;
    const app = Fastify();
    // The real console chain: security headers (CORS), the global host guard, then the routes.
    registerSecurityHeaders(app, false);
    registerHostGuard(app, () => buildHostPolicy('127.0.0.1'));
    registerEmbassyPairingRoutes(app, h.host, g.pairing, () => owner, () => buildHostPolicy('127.0.0.1'));
    const csrf = { 'x-reverie-csrf': '1' };
    const GUARD = 'guard: Forbidden: cross-site request blocked';
    const code = async (opts: InjectOptions) => {
      const res = await app.inject(opts);
      if (res.statusCode === 200) return 200;
      // The global guard refuses a foreign or null Origin on a write first, as plain text (integration pins r2 §1).
      if (!String(res.headers['content-type'] ?? '').includes('json')) return `guard: ${res.body}`;
      return res.json().errorCode;
    };
    try {
      const url = '/api/embassy-host/invites';
      const body = { clientRequestId: randomUUID() };
      for (const method of ['GET', 'POST'] as const) {
        const payload = method === 'POST' ? body : undefined;
        // missing or wrong marker
        expect(await code({ method, url, payload })).toBe('CSRF_REFUSED');
        expect(await code({ method, url, payload, headers: { 'x-reverie-csrf': 'true' } })).toBe('CSRF_REFUSED');
        // foreign and null Origin even with the marker: on a write the global guard answers first
        const early = method === 'GET' ? 'CSRF_REFUSED' : GUARD;
        expect(await code({ method, url, payload, headers: { ...csrf, origin: 'https://evil.example' } })).toBe(early);
        expect(await code({ method, url, payload, headers: { ...csrf, origin: 'null' } })).toBe(early);
        // owner plus agent header
        expect(await code({ method, url, payload, headers: { ...csrf, 'x-reverie-parent-session': 'x' } })).toBe('OWNER_ONLY');
        // anonymous with the marker and a good Origin
        owner = false;
        expect(await code({ method, url, payload, headers: { ...csrf, origin: 'http://127.0.0.1:3000' } })).toBe('OWNER_ONLY');
        owner = true;
        // owner with the marker: allowed Origin and absent Origin pass
        expect(await code({ method, url, payload, headers: { ...csrf, origin: 'http://127.0.0.1:3000' } })).toBe(200);
        expect(await code({ method, url, payload, headers: csrf })).toBe(200);
      }
      expect(await code({ method: 'DELETE', url: '/api/embassy-pairing/' + 'a'.repeat(32), headers: { origin: 'null' } })).toBe(GUARD);
      // An allowlisted cross-port Origin passes the guard on a write; without the marker the route refuses it.
      expect(await code({ method: 'POST', url, payload: body, headers: { origin: 'http://127.0.0.1:9999' } })).toBe('CSRF_REFUSED');
      // A cross-origin page (another localhost port) cannot get the marker past preflight.
      const pre = await app.inject({
        method: 'OPTIONS',
        url,
        headers: { origin: 'http://localhost:9999', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-reverie-csrf' },
      });
      expect(String(pre.headers['access-control-allow-headers'] ?? '').toLowerCase()).not.toContain('x-reverie-csrf');
      // Refused calls never reach the embassy: only the four passing calls did, and the two POSTs share one invite.
      expect(h.channel.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST', 'POST']);
      expect(h.channel.invites.size).toBe(1);
    } finally {
      await app.close();
    }
  });
});
