import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EmbassyGuestClient, type EmbassyGuestRequest, type EmbassyGuestResponse } from '../src/embassy-guest-client.js';
import { EmbassyPairing } from '../src/embassy-pairing.js';

const stops: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it('cold restore retires a connected guest with durable cancellation debt before any poll', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-cold-retirement-')); dirs.push(dir);
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
    const pairing = new EmbassyPairing({ dir: join(dir, 'embassy-pairings'), guest, transport });
    await pairing.init();
    stops.push(async () => { await pairing.stop(); await guest.stop(); });
    return { guest, pairing };
  };
  const first = await boot();
  const created = await first.pairing.create(undefined, { qr: `embassy-v2|${origin}|${roomId}|${'T'.repeat(43)}`, clientRequestId: randomUUID() });
  state = 'approved'; const connected = await first.pairing.get(undefined, created.handle);
  expect(connected.state).toBe('connected'); const connectionId = connected.connectionId!;
  await first.guest.tick(); expect(first.guest.holds(undefined, connectionId)).toBe(true);
  await first.pairing.stop(); await first.guest.stop();
  // Reachable crash boundary: cancel saved its debt, then stopped before the guest retirement write.
  const file = join(dir, 'embassy-pairings', `${created.handle}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.state = 'cancelling'; record.cancelPending = true; record.generation++;
  writeFileSync(file, JSON.stringify(record));
  const before = calls.length, restored = await boot();
  expect(restored.pairing.list(undefined).pairings[0].state).toBe('cancelling');
  expect.soft(restored.guest.holds(undefined, connectionId)).toBe(false);
  await restored.guest.tick();
  expect.soft(calls.slice(before)).toEqual([]);
  expect(restored.pairing.list(undefined).pairings[0].state).toBe('cancelling');
  expect(JSON.parse(readFileSync(file, 'utf8')).cancelPending).toBe(true);
});
