/**
 * @fileoverview The hosting owner's pictures for embassy guests: the store, and the host routes that set, serve and
 * remove them. Only an approved or connected guest of the hosted room gets one, only the signed-in owner sets or
 * sees it, the image is checked by its own bytes and size, and revoking the guest or closing the room deletes it.
 *
 * Port: N/A (app.inject and a fake embassy channel)
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type InjectOptions } from 'fastify';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AvatarError, AvatarStore, MAX_AVATAR_BYTES } from '../src/agent-avatars.js';
import { EMBASSY_GUEST_AVATAR_URL, EmbassyGuestAvatars } from '../src/embassy-guest-avatars.js';
import { EmbassyHost, type EmbassyChannelCall } from '../src/embassy-host.js';
import type { EmbassyPairing } from '../src/embassy-pairing.js';
import { registerEmbassyPairingRoutes } from '../src/web/routes/embassy-pairing-routes.js';
import { buildHostPolicy } from '../src/web/network-auth-policy.js';

const ROOM = '00000015-001b-4000-8000-000000000025';
const ORIGIN = 'https://embassy.example.ts.net:8443';
const APPROVED = '0000000a-0000-4000-8000-00000000000a';
const CLAIMED = '0000000b-0000-4000-8000-00000000000b';
const PENDING = '0000000c-0000-4000-8000-00000000000c';
const REVOKED = '0000000d-0000-4000-8000-00000000000d';
const REJECTED = '0000000e-0000-4000-8000-00000000000e';
const UNKNOWN = '0000000f-0000-4000-8000-00000000000f';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('zorblat')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('zorblat')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'embassy-guest-avatars-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  delete process.env.REVERIE_MULTIUSER;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A hosted room with one invite per guest state; DELETE revokes an invite and POST /close revokes them all. */
function fakeChannel() {
  const invites = [
    { id: 'inv-approved', requestId: APPROVED, requestState: 'approved', revoked: false },
    { id: 'inv-claimed', requestId: CLAIMED, requestState: 'claimed', revoked: false },
    { id: 'inv-pending', requestId: PENDING, requestState: 'pending', revoked: false },
    { id: 'inv-revoked', requestId: REVOKED, requestState: 'approved', revoked: true },
    { id: 'inv-rejected', requestId: REJECTED, requestState: 'rejected', revoked: false },
  ];
  const base = `/embassy/channel/rooms/${ROOM}`;
  // A held invites read answers with the state at the moment it was asked, but only once released: an embassy
  // reply that arrives late, after a revoke or close has completed meanwhile.
  let held: { asked: () => void; released: Promise<void> } | undefined;
  const holdNextInvites = () => {
    let release!: () => void;
    let asked!: () => void;
    const askedP = new Promise<void>((done) => (asked = done));
    held = { asked, released: new Promise<void>((done) => (release = done)) };
    return { asked: askedP, release };
  };
  const transport = async (call: EmbassyChannelCall) => {
    if (call.method === 'GET' && call.path === base)
      return { status: 200, body: { room: { id: ROOM, name: 'Pilot' }, origin: ORIGIN } };
    if (call.method === 'GET' && call.path === `${base}/invites`) {
      const body = {
        invites: invites.map((i) => ({
          ...i,
          roomId: ROOM,
          expiresAt: Date.now() + 900_000,
          guest: { company: 'Robotronix', identity: 'Zorblat' },
        })),
      };
      const hold = held;
      held = undefined;
      if (hold) {
        hold.asked();
        await hold.released;
      }
      return { status: 200, body };
    }
    const revoke = call.path.match(new RegExp(`^${base}/invites/(.+)$`));
    if (call.method === 'DELETE' && revoke) {
      const invite = invites.find((i) => i.id === revoke[1]);
      if (!invite) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } };
      invite.revoked = true;
      return { status: 200, body: { revoked: true } };
    }
    if (call.method === 'POST' && call.path === `${base}/close`) {
      invites.forEach((i) => (i.revoked = true));
      return { status: 200, body: { closed: true, revoked: invites.length } };
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } };
  };
  return { transport, invites, holdNextInvites };
}

async function setup() {
  const dir = temp();
  const channel = fakeChannel();
  const avatars = new EmbassyGuestAvatars(
    new AvatarStore(join(dir, 'embassy-guest-avatars')),
    join(dir, 'embassy-host', 'guest-avatars.json')
  );
  const host = new EmbassyHost({
    dir: join(dir, 'embassy-channel'),
    opsFile: join(dir, 'embassy-host', 'ops.json'),
    transport: channel.transport,
    guestAvatars: avatars,
  });
  await host.init();
  writeFileSync(join(dir, 'embassy-channel', 'channel.json'), JSON.stringify({ v: 1, roomId: ROOM }));
  const state = { owner: true };
  const app = Fastify();
  registerEmbassyPairingRoutes(
    app,
    host,
    {} as EmbassyPairing,
    () => state.owner,
    () => buildHostPolicy('127.0.0.1'),
    avatars
  );
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, headers: { 'x-reverie-csrf': '1', ...(opts.headers as Record<string, string>) } });
  const put = (requestId: string, body: Buffer, type = 'image/png') =>
    call({
      method: 'PUT',
      url: `/api/embassy-host/guests/${requestId}/avatar`,
      payload: body,
      headers: { 'content-type': type },
    });
  const image = (requestId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/embassy-host/guests/${requestId}/avatar`, headers });
  const stored = () => {
    try {
      // Versioned files, `guest-<requestId>-<version>.<ext>`, reduced to `guest-<requestId>.<ext>`.
      return readdirSync(join(dir, 'embassy-guest-avatars'))
        .map((name) => name.replace(/-\d+\./, '.'))
        .sort();
    } catch {
      return [];
    }
  };
  return { dir, app, host, avatars, state, call, put, image, stored, channel };
}

describe('EmbassyGuestAvatars', () => {
  it('stores a checked picture under the request id with a versioned URL, and removes it', async () => {
    const dir = temp();
    let now = 1000;
    const avatars = new EmbassyGuestAvatars(new AvatarStore(join(dir, 'pics')), join(dir, 'map.json'), () => now);
    const url = await avatars.set(avatars.token(APPROVED), PNG);
    expect(url).toBe(`/api/embassy-host/guests/${APPROVED}/avatar?v=1000`);
    expect(url).toMatch(EMBASSY_GUEST_AVATAR_URL);
    expect(statSync(join(dir, 'pics', `guest-${APPROVED}-1000.png`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'map.json')).mode & 0o777).toBe(0o600);
    // A new picture in another format replaces the old one, under a newer version even if the clock did not move.
    expect(await avatars.set(avatars.token(APPROVED), JPEG)).toBe(`/api/embassy-host/guests/${APPROVED}/avatar?v=1001`);
    expect(readdirSync(join(dir, 'pics'))).toEqual([`guest-${APPROVED}-1001.jpg`]);
    expect((await avatars.get(APPROVED))?.type).toBe('image/jpeg');
    now = 5000;
    await avatars.set(avatars.token(CLAIMED), PNG);
    expect(await avatars.urls()).toEqual({
      [APPROVED]: `/api/embassy-host/guests/${APPROVED}/avatar?v=1001`,
      [CLAIMED]: `/api/embassy-host/guests/${CLAIMED}/avatar?v=5000`,
    });
    expect(await avatars.remove(APPROVED)).toBe(true);
    expect(await avatars.remove(APPROVED)).toBe(false);
    expect(await avatars.get(APPROVED)).toBeUndefined();
    expect(await avatars.removeAll()).toBe(1);
    expect(readdirSync(join(dir, 'pics'))).toEqual([]);
    expect(await avatars.urls()).toEqual({});
  });

  it('refuses a non-image, an oversized image, a bad id and a corrupt map', async () => {
    const dir = temp();
    const avatars = new EmbassyGuestAvatars(new AvatarStore(join(dir, 'pics')), join(dir, 'map.json'));
    await expect(avatars.set(avatars.token(APPROVED), SVG)).rejects.toMatchObject({ status: 415 });
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]);
    await expect(avatars.set(avatars.token(APPROVED), big)).rejects.toBeInstanceOf(AvatarError);
    await expect(avatars.set(avatars.token(APPROVED), big)).rejects.toMatchObject({ status: 413 });
    await expect(avatars.set(avatars.token('../owner'), PNG)).rejects.toThrow('Invalid guest request id');
    await expect(avatars.set(avatars.token(APPROVED.toUpperCase()), PNG)).rejects.toThrow('Invalid guest request id');
    expect(await avatars.urls()).toEqual({});
    writeFileSync(join(dir, 'map.json'), '{"v":3,"versions":{}}');
    await expect(avatars.urls()).rejects.toThrow('refusing to reset');
  });
});

describe('embassy guest picture routes', () => {
  it('sets a picture only for an approved or connected guest of the hosted room', async () => {
    const t = await setup();
    const set = await t.put(APPROVED, PNG);
    expect(set.statusCode).toBe(200);
    expect(set.json().data.url).toMatch(EMBASSY_GUEST_AVATAR_URL);
    expect((await t.put(CLAIMED, JPEG, 'image/jpeg')).statusCode).toBe(200);
    for (const requestId of [PENDING, REVOKED, REJECTED, UNKNOWN, 'not-a-request']) {
      const refused = await t.put(requestId, PNG);
      expect(refused.statusCode, requestId).toBe(404);
      expect(refused.json().errorCode, requestId).toBe('NOT_FOUND');
    }
    expect(t.stored()).toEqual([`guest-${APPROVED}.png`, `guest-${CLAIMED}.jpg`]);
    const status = await t.call({ method: 'GET', url: '/api/embassy-host' });
    expect(Object.keys(status.json().data.guestAvatars).sort()).toEqual([APPROVED, CLAIMED]);
    expect(status.json().data.guestAvatars[APPROVED]).toBe(set.json().data.url);
  });

  it('checks the image by its bytes and size, whatever type it declares', async () => {
    const t = await setup();
    const svg = await t.put(APPROVED, SVG, 'image/png');
    expect(svg.statusCode).toBe(415);
    expect(svg.json().errorCode).toBe('INVALID_IMAGE');
    const big = await t.put(APPROVED, Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]));
    expect(big.statusCode).toBe(413);
    expect((await t.put(APPROVED, Buffer.alloc(0))).statusCode).toBe(400);
    expect(t.stored()).toEqual([]);
  });

  it('only the signed-in owner, from this console, sets or removes a picture', async () => {
    const t = await setup();
    t.state.owner = false;
    expect((await t.put(APPROVED, PNG)).json().errorCode).toBe('OWNER_ONLY');
    t.state.owner = true;
    const agent = await t.call({
      method: 'PUT',
      url: `/api/embassy-host/guests/${APPROVED}/avatar`,
      payload: PNG,
      headers: { 'content-type': 'image/png', 'x-reverie-parent-session': 'zorblat-session' },
    });
    expect(agent.json().errorCode).toBe('OWNER_ONLY');
    const csrf = await t.app.inject({
      method: 'DELETE',
      url: `/api/embassy-host/guests/${APPROVED}/avatar`,
    });
    expect(csrf.json().errorCode).toBe('CSRF_REFUSED');
    process.env.REVERIE_MULTIUSER = '1';
    expect((await t.put(APPROVED, PNG)).json().errorCode).toBe('OWNER_ONLY');
    expect(t.stored()).toEqual([]);
  });

  it('serves the picture only to the signed-in owner, never to an agent or another site', async () => {
    const t = await setup();
    await t.put(APPROVED, PNG);
    const ok = await t.image(APPROVED);
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(PNG)).toBe(true);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(ok.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect((await t.image(APPROVED, { 'x-reverie-parent-session': 'zorblat-session' })).statusCode).toBe(403);
    expect((await t.image(APPROVED, { origin: 'https://robotronix.example' })).statusCode).toBe(403);
    expect((await t.image(APPROVED, { origin: 'null' })).statusCode).toBe(403);
    t.state.owner = false;
    expect((await t.image(APPROVED)).statusCode).toBe(403);
    t.state.owner = true;
    expect((await t.image(CLAIMED)).statusCode).toBe(404);
    expect((await t.image('../agent-avatars/x')).statusCode).toBe(404);
  });

  it('removing, revoking the guest or closing the room deletes the picture', async () => {
    const t = await setup();
    await t.put(APPROVED, PNG);
    await t.put(CLAIMED, PNG);
    const removed = await t.call({ method: 'DELETE', url: `/api/embassy-host/guests/${APPROVED}/avatar` });
    expect(removed.json().data).toEqual({ removed: true });
    expect((await t.image(APPROVED)).statusCode).toBe(404);
    await t.put(APPROVED, PNG);
    expect((await t.call({ method: 'DELETE', url: '/api/embassy-host/invites/inv-claimed' })).statusCode).toBe(200);
    expect(t.stored()).toEqual([`guest-${APPROVED}.png`]);
    expect((await t.image(CLAIMED)).statusCode).toBe(404);
    // The revoked guest is no longer a guest: a new picture is refused.
    expect((await t.put(CLAIMED, PNG)).statusCode).toBe(404);
    const closed = await t.call({ method: 'POST', url: '/api/embassy-host/close', payload: { confirm: 'close' } });
    expect(closed.statusCode).toBe(200);
    expect(t.stored()).toEqual([]);
    expect(await t.avatars.urls()).toEqual({});
  });
});

describe('embassy guest pictures across a revoke, a close or a failed write', () => {
  const root = process.getuid?.() === 0;

  for (const lifecycle of ['revoke', 'close'] as const) {
    it(`an upload whose guest check answers after a ${lifecycle} never brings the picture back`, async () => {
      const t = await setup();
      const { asked, release } = t.channel.holdNextInvites();
      const upload = t.put(APPROVED, PNG);
      await asked; // the upload's guest check is with the embassy, still answering "approved"
      const done =
        lifecycle === 'revoke'
          ? await t.call({ method: 'DELETE', url: '/api/embassy-host/invites/inv-approved' })
          : await t.call({ method: 'POST', url: '/api/embassy-host/close', payload: { confirm: 'close' } });
      expect(done.statusCode).toBe(200);
      release();
      const refused = await upload;
      expect(refused.statusCode).toBe(409);
      expect(refused.json().errorCode).toBe('GUEST_CHANGED');
      expect(t.stored()).toEqual([]);
      expect((await t.image(APPROVED)).statusCode).toBe(404);
      expect(await t.avatars.urls()).toEqual({});
    });
  }

  it.skipIf(root)('a failed map write while replacing a picture leaves the old URL serving the old bytes', async () => {
    const t = await setup();
    const first = (await t.put(APPROVED, PNG)).json().data.url;
    const hostDir = join(t.dir, 'embassy-host');
    chmodSync(hostDir, 0o500); // the map cannot be rewritten
    try {
      expect((await t.put(APPROVED, JPEG, 'image/jpeg')).statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      chmodSync(hostDir, 0o700);
    }
    expect((await t.avatars.urls())[APPROVED]).toBe(first);
    const served = await t.image(APPROVED);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.rawPayload.equals(PNG)).toBe(true);
    expect(t.stored()).toEqual([`guest-${APPROVED}.png`]);
  });

  it('a picture that could not be deleted on close stays listed while the others go, and a retry deletes it', async () => {
    const t = await setup();
    await t.put(APPROVED, PNG);
    await t.put(CLAIMED, PNG);
    const pictures = join(t.dir, 'embassy-guest-avatars');
    // One picture's file cannot be deleted: a directory stands in its place.
    const stuck = readdirSync(pictures).find((name) => name.startsWith(`guest-${APPROVED}-`))!;
    rmSync(join(pictures, stuck));
    mkdirSync(join(pictures, stuck));
    await expect(t.avatars.removeAll()).rejects.toThrow();
    expect(Object.keys(await t.avatars.urls())).toEqual([APPROVED]);
    expect(t.stored()).toEqual([`guest-${APPROVED}.png`]);
    rmSync(join(pictures, stuck), { recursive: true });
    writeFileSync(join(pictures, stuck), PNG);
    expect(await t.avatars.removeAll()).toBe(1);
    expect(t.stored()).toEqual([]);
    expect(await t.avatars.urls()).toEqual({});
  });
});
