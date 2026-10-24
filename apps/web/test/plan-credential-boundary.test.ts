/** Actual Basic/owner middleware and plan routes; owned synthetic request/capability store only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import * as admin from '../src/owner-auth/admin.js';
import { registerOwnerPolicy, classify, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerPlanRequestRoutes } from '../src/web/routes/plan-request-routes.js';
import { PlanMoveRequests, type PlanRequestRecord } from '../src/plan-request.js';
import { PlanRequestCapabilities } from '../src/plan-request-capability.js';
import type { PlanMoveExecutor } from '../src/plan-move.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: async () => undefined }));
const SID = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BASIC = 'Basic ' + Buffer.from('admin:synthetic-shared').toString('base64');

describe('plan approval never exports a private capability through ordinary server policy', () => {
  let dir: string, app: FastifyInstance;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plan-custody-boundary-'));
    vi.stubEnv('REVERIE_USERNAME', 'admin');
    vi.stubEnv('REVERIE_PASSWORD', 'synthetic-shared');
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });
  it.each(['enforce', 'log', 'off'] as const)(
    'refuses legacy export in %s even for accepted and mixed principals',
    async (mode) => {
      const store = new OwnerAuthStore(join(dir, 'owner.json'));
      const { oneTimePassword } = await admin.bootstrap(store, 'synthetic-owner');
      const owner = new OwnerAuthService({ store, auditFile: join(dir, 'owner-audit.jsonl') });
      const first = await owner.login('synthetic-owner', oneTimePassword, '127.0.0.1');
      const ownerToken = await owner.changePassword(
        first.session,
        { current: oneTimePassword, next: 'synthetic-Full-owner!42' },
        '127.0.0.1'
      );
      expect(owner.session(ownerToken)?.restricted).toBe(false);
      const serviceToken = await admin.issueServiceToken(store, 'synthetic-service');
      await admin.setPolicy(store, mode, { forceLockoutRisk: true });
      const caps = new PlanRequestCapabilities(join(dir, 'capabilities'));
      let secret = '';
      const write = caps.write.bind(caps);
      vi.spyOn(caps, 'write').mockImplementation(async (value) => {
        secret = value.nonce;
        return write(value);
      });
      const moves = { begin: vi.fn(), get: vi.fn(), cancel: vi.fn() };
      const execution = {
        authorized: () => true,
        executor: {
          snapshot: async () => ({ sessionId: SID, name: 'Example', account: 'first', working: false, mode: 'codex' }),
        } as unknown as PlanMoveExecutor,
      };
      let records: PlanRequestRecord[] = [];
      const requests = new PlanMoveRequests({
        load: async () => records,
        save: async (value) => {
          records = value;
        },
        moves,
        binding: () => SID,
        validateTarget: async () => ({ mode: 'codex' }),
        capability: caps,
        notify: async () => undefined,
        audit: async () => undefined,
        now: () => 100,
      });
      await requests.create(
        { id: 'request', employeeId: 'example', sessionId: SID, toAccount: 'second' },
        undefined,
        execution
      );
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
      const read = vi.spyOn(caps, 'read');
      const sessions = new Map([
        [SID, { id: SID, owner: undefined }],
        [OTHER, { id: OTHER, owner: undefined }],
      ]);
      const ctx = { sessions, authSessions: new Map() };
      app = Fastify();
      await app.register(cookie);
      registerAuthMiddleware(app, false, '', owner);
      registerOwnerPolicy(app, {
        service: owner,
        ctx: ctx as unknown as SessionPort,
        isCapabilityRequest: () => false,
        relations: {
          known: () => true,
          related: (a, b) => a === b,
          upward: () => false,
          keeper: () => false,
          admin: () => false,
        },
      });
      registerPlanRequestRoutes(app, requests, ctx as never, owner, () => execution);
      const own = { 'x-reverie-parent-session': SID };
      const service = { 'x-reverie-service-token': serviceToken };
      const signed = { cookie: `${OWNER_COOKIE}=${ownerToken}` };
      const callers = [
        own,
        { 'x-reverie-parent-session': OTHER },
        service,
        signed,
        { ...service, ...own },
        { ...signed, ...own },
        { ...signed, ...service, ...own },
      ];
      for (const headers of callers)
        for (const suffix of [
          'request/credential',
          '%72equest/credential',
          'request/%63redential',
          'request/credential?x=1',
        ]) {
          const result = await app.inject({
            method: 'POST',
            url: `/api/plans/requests/${suffix}`,
            headers: { authorization: BASIC, host: 'console.test', origin: 'http://console.test', ...headers },
            payload: {},
          });
          expect([401, 403, 404], `${mode} ${suffix}`).toContain(result.statusCode);
          expect(result.body).not.toContain(secret);
        }
      expect(read).not.toHaveBeenCalled();
      expect(requests).not.toHaveProperty('credential');
      expect(classify('POST', '/api/plans/requests/:id/credential', '/api/plans/requests/request/credential')).toBe(
        'owner'
      );
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/plans/requests/request/reject',
        headers: { authorization: BASIC, ...own },
        payload: { nonce: secret },
      });
      expect(rejected.statusCode).toBe(202);
      expect(rejected.json().data.phase).toBe('rejected');
      expect(rejected.body).not.toContain(secret);
      expect(read).not.toHaveBeenCalled();
      expect(moves.begin).not.toHaveBeenCalled();
    }
  );
});
