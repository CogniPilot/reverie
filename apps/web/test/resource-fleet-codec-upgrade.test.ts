import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { FleetResourcesService, registerFleetResourceRoutes } from '../src/resource-fleet-service.js';
import { FleetReplyCodecUpgradeRequired, NativeFleetPreviewRefusal } from '../src/native-owner-channel.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

it('reports a pre-preview codec mismatch as upgrade required, without an issued outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-codec-'));
  const auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const token = await auth.setup('FixtureOwner', 'Synthetic-codec-42!', 'Synthetic-codec-42!', '127.0.0.1');
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  const company = new CompanyService(store, {
    getSession: () => undefined,
    chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn(), setStatus: vi.fn() },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  });
  const service = new FleetResourcesService(company, auth);
  const preview = vi.spyOn(service.native!, 'preview').mockRejectedValue(new FleetReplyCodecUpgradeRequired());
  const apply = vi.spyOn(service.native!, 'apply');
  const app = Fastify();
  await app.register(cookie);
  registerFleetResourceRoutes(app, ownerVerifier({ service: auth, ctx: {} as SessionPort }), service);
  try {
    const reply = await app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/native-preview',
      payload: {},
      headers: { host: 'localhost', origin: 'http://localhost', cookie: `reverie_owner=${token}` },
    });
    expect(reply.statusCode).toBe(503);
    expect(reply.json()).toMatchObject({
      success: false,
      code: 'FLEET_REPLY_CODEC_UPGRADE_REQUIRED',
      outcome: 'upgrade-required',
      consentDispatched: false,
    });
    expect(reply.json().error).toContain('website and native broker together');
    expect(preview).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    preview.mockRejectedValueOnce(new NativeFleetPreviewRefusal());
    const refused = await app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/native-preview',
      payload: {},
      headers: { host: 'localhost', origin: 'http://localhost', cookie: `reverie_owner=${token}` },
    });
    expect(refused.json()).toMatchObject({
      success: false,
      code: 'FLEET_PREVIEW_CHANNEL_REFUSED',
      outcome: 'not-started',
      consentDispatched: false,
    });
    expect(apply).not.toHaveBeenCalled();
  } finally {
    service.native!.close();
    await app.close();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
