import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EmbassyGuestClient, type EmbassyGuestRequest, type EmbassyGuestResponse } from '../src/embassy-guest-client.js';
import { EmbassyPairing } from '../src/embassy-pairing.js';

// CP-K4 (r6): init retires the guest session of every restored cancelling or cancelled pairing before anything can
// poll, and refuses to start when that local retirement cannot be saved. Rex's control covers `cancelling`.

const stops: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// A connected pairing whose process then stopped, plus a way to rewrite its saved record and boot again.
async function connectedThenStopped() {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-cold-retire-r6-')); dirs.push(dir);
  const origin = 'https://embassy.example.ts.net:8443', roomId = randomUUID(), requestId = randomUUID();
  const calls: string[] = []; let state = 'pending';
  const transport = async (r: EmbassyGuestRequest): Promise<EmbassyGuestResponse> => {
    calls.push(r.path);
    if (r.path === '/api/embassy/pair-request') return { status: 201, body: {
      requestId, code: '3BCD5FGH', state, roomId, roomName: 'Shared', hostCompany: 'Host', expiresAt: Date.now() + 600000,
    } };
    if (r.path === '/api/embassy/pair-status') return { status: 200, body: { state, expiresAt: Date.now() + 600000, claimExpiresAt: null } };
    if (r.path === '/api/embassy/pair-claim') { state = 'claimed'; return { status: 200, body: {
      sessionToken: 'S'.repeat(43), hostCompany: 'Host', room: { id: roomId, name: 'Shared' },
      guest: { company: 'Visitor', identity: 'Guest' }, expiresAt: Date.now() + 3600000,
    } }; }
    if (r.path.startsWith('/embassy/rooms/')) return { status: 200, body: { posts: [] } };
    throw new Error(`Unexpected fixture route: ${r.path}`);
  };
  const boot = async () => {
    const guest = new EmbassyGuestClient({ file: join(dir, 'embassy-guest.json'), transport });
    await guest.init();
    stops.push(async () => { await guest.stop(); });
    const pairing = new EmbassyPairing({ dir: join(dir, 'embassy-pairings'), guest, transport });
    await pairing.init();
    stops.push(async () => { await pairing.stop(); });
    return { guest, pairing };
  };
  const first = await boot();
  const created = await first.pairing.create(undefined, { qr: `embassy-v2|${origin}|${roomId}|${'T'.repeat(43)}`, clientRequestId: randomUUID() });
  state = 'approved'; const connected = await first.pairing.get(undefined, created.handle);
  expect(connected.state).toBe('connected'); const connectionId = connected.connectionId!;
  await first.guest.tick(); expect(first.guest.holds(undefined, connectionId)).toBe(true);
  await first.pairing.stop(); await first.guest.stop();
  const file = join(dir, 'embassy-pairings', `${created.handle}.json`);
  const rewrite = (patch: Record<string, unknown>) => {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    Object.assign(record, patch); record.generation++;
    writeFileSync(file, JSON.stringify(record));
  };
  return { boot, calls, connectionId, file, rewrite };
}

it('CP-K4: a restored confirmed cancellation also retires its still-live guest session before any poll', async () => {
  // Crash boundary: the confirmed `cancelled` state was saved, then the process stopped before the guest retirement write.
  const t = await connectedThenStopped();
  t.rewrite({ state: 'cancelled', cancelPending: false });
  const before = t.calls.length, restored = await t.boot();
  expect(restored.guest.holds(undefined, t.connectionId)).toBe(false);
  await restored.guest.tick();
  expect(t.calls.slice(before)).toEqual([]);
  expect(restored.pairing.list(undefined).pairings[0].state).toBe('cancelled');
});

it('CP-K4: init is rejected, with no request and the debt kept, when the local retirement cannot be saved', async () => {
  const t = await connectedThenStopped();
  t.rewrite({ state: 'cancelling', cancelPending: true });
  const before = t.calls.length;
  vi.spyOn(EmbassyGuestClient.prototype, 'retire').mockRejectedValue(new Error('retirement write failed'));
  await expect(t.boot()).rejects.toThrow('retirement write failed');
  expect(t.calls.slice(before)).toEqual([]);
  expect(JSON.parse(readFileSync(t.file, 'utf8'))).toMatchObject({ state: 'cancelling', cancelPending: true });
});
