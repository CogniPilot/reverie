/** Immutable owning-test website. Imports the real account/authority/client;
 * no owner-shaped proof responder, resource effect or result is implemented.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import process from 'node:process';
import { OwnerAuthService } from './owner-auth/service.js';
import { OwnerAuthStore } from './owner-auth/store.js';
import { ResourceOwnerAuthority } from './resource-owner-authority.js';
import { RamResourceNativeClient } from './resource-ram-native-client.js';

const employeeId = '10000000-0000-4000-8000-000000000001';
const username = 'NativeFixtureOwner';
const password = 'Quasar!native-fixture-8-passphrase';
if (process.env.REVERIE_DATA_DIR !== '/fixture/data' || process.env.HOME !== '/fixture/home')
  throw new Error('Explicit private fixture paths required');
const auth = new OwnerAuthService({
  store: new OwnerAuthStore('/fixture/data/owner-auth.json'),
  auditFile: '/fixture/data/owner-audit.jsonl',
  setupEnabled: true,
});
const authority = new ResourceOwnerAuthority(auth);
const app = Fastify({ logger: false });
await app.register(cookie);
let initialized = false,
  client,
  context,
  pending = false,
  state = 'HTTP_ONLY';
app.get('/state', async () => ({
  state,
  pending,
  context: context
    ? {
        owner: context.owner ?? null,
        ownerScopeDigest: context.ownerScopeDigest,
        expiresAtEpochMs: context.expiresAtEpochMs,
        purpose: context.purpose,
        stage: context.stage,
      }
    : null,
}));
app.post('/login', async (request, reply) => {
  let token;
  if (!initialized) {
    token = await auth.setup(username, password, password, request.ip);
    initialized = true;
  } else {
    const logged = await auth.login(username, password, request.ip);
    if (logged.next !== 'done' || !logged.session) throw new Error('Actual owner login required');
    token = logged.session;
  }
  reply.setCookie('reverie_owner', token, { path: '/', httpOnly: true, sameSite: 'strict' });
  return { state: 'OWNER_COOKIE_ISSUED' };
});
app.post('/preview', async (request, reply) => {
  if (pending) return reply.code(409).send({ state: 'ORIGINAL_REQUEST_PENDING' });
  const body = request.body;
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).join(',') !== 'idempotencyKey' ||
    typeof body.idempotencyKey !== 'string'
  )
    return reply.code(400).send({ state: 'FIXTURE_REQUEST_REFUSED' });
  context = authority.captureRamPreview(request, employeeId);
  client = await RamResourceNativeClient.open('/run/reverie-native-q/q.sock', authority, context);
  pending = true;
  state = 'SOURCE_REQUEST_PENDING';
  // Native constructor qualification deliberately sends NO fabricated result.
  // Observe the pending request immediately, including expected EOF on cleanup.
  void client.draft(body.idempotencyKey, 512).then(
    () => {
      state = 'UNEXPECTED_HOST_RESULT';
      pending = false;
    },
    () => {
      state = 'CHANNEL_ENDED';
      pending = false;
    }
  );
  return reply.code(202).send({
    state,
    context: {
      owner: context.owner ?? null,
      ownerScopeDigest: context.ownerScopeDigest,
      expiresAtEpochMs: context.expiresAtEpochMs,
      purpose: context.purpose,
      stage: context.stage,
    },
  });
});
app.post('/logout', async (request) => {
  authority.requestOwner(request);
  // Real account revocation, not a hand-written client.close substitute.
  auth.logout(request.cookies.reverie_owner);
  return { state: 'OWNER_SESSION_REVOKED' };
});
await app.listen({ host: '0.0.0.0', port: 3000 });
