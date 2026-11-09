/** Actual private ROOT/Office authentication plus closed consent DATA. The
 * nominated offer below is fixture DATA, never an attested native offer or a
 * HostPoolAdministration producer. No product route, B socket or host effects.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { writeCompanyStateFile } from '../src/company-store.js';
import {
  POOL_INSTALLATION_CONSENT_PURPOSE,
  ResourceOwnerAuthority,
  type PoolInstallationConsentContext,
  type PoolInstallationOfferContext,
  type PoolInstallationOfferData,
} from '../src/resource-owner-authority.js';
import { answerPoolInstallationChallenge, poolInstallationConsentRequest } from '../src/pool-installation-consent.js';

const password = 'Synthetic-pool-consent-fixture-42!';
const offerNonce = '10000000-0000-4000-8000-000000000002';
const nonce = '10000000-0000-4000-8000-000000000003';
let directory: string, app: FastifyInstance, store: OwnerAuthStore, auth: OfficeAuthService;
let authority: ResourceOwnerAuthority, primary: string, tokens: string[], authorities: ResourceOwnerAuthority[];
let nominated: PoolInstallationOfferData, viewed: PoolInstallationOfferContext | undefined;
let consent: PoolInstallationConsentContext | undefined;
beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'pool-consent-'));
  store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  primary = await auth.setup('fixture-primary', password, password, '127.0.0.1');
  tokens = [primary];
  authority = new ResourceOwnerAuthority(auth);
  authorities = [authority];
  nominated = { offerNonce, requestDigest: 'a'.repeat(64), principal: auth.registrationIdentity(primary) };
  viewed = undefined;
  consent = undefined;
  app = Fastify();
  await app.register(cookie);
  app.post('/view', (request, reply) => {
    try {
      viewed = authority.capturePoolInstallationOffer(request, nominated);
      return { requestId: viewed.requestId, stage: viewed.stage };
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post('/consent', (request, reply) => {
    try {
      if (!viewed) throw new Error('No original view');
      consent = authority.capturePoolInstallationConsent(request, viewed);
      return poolInstallationConsentRequest(authority, consent);
    } catch (error) {
      return failure(reply, error);
    }
  });
});
function failure(reply: import('fastify').FastifyReply, error: unknown) {
  const status = error instanceof Error && 'status' in error ? Number(error.status) : 403;
  return reply.code(status).send({ error: error instanceof Error ? error.message : 'Refused' });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const source of authorities) source.close();
  for (const token of tokens) auth.logout(token);
  await app.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const body = () => ({ consent: true, offerNonce, requestDigest: nominated.requestDigest });
const post = (url: string, payload?: object, token = primary, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token, ...headers },
  });
function challenge(context = consent!) {
  return {
    kind: 'pool-installation-owner-check',
    purpose: POOL_INSTALLATION_CONSENT_PURPOSE,
    version: 1,
    requestId: context.requestId,
    nonce,
    offerNonce: context.offerNonce,
    requestDigest: context.requestDigest,
    principal: context.principal,
  };
}
async function owner() {
  const created = await auth.create({ username: 'fixture-member', name: 'Member', role: 'owner', rooms: [] });
  const login = await auth.login('fixture-member', created.oneTimePassword, '127.0.0.1');
  const token = await auth
    .forSession(login.session)
    .changePassword(login.session, { current: created.oneTimePassword, next: password }, '127.0.0.1');
  tokens.push(token);
  return { id: created.person.id, token };
}

it.each(['primary', 'secondary'] as const)(
  'requires explicit consent from the exact nominated %s principal',
  async (kind) => {
    const token = kind === 'primary' ? primary : (await owner()).token;
    nominated = { ...nominated, principal: auth.registrationIdentity(token) };
    const before = await readFile(store.file, 'utf8');
    expect((await post('/view', undefined, token)).statusCode).toBe(200);
    expect(() =>
      answerPoolInstallationChallenge(
        authority,
        viewed! as unknown as PoolInstallationConsentContext,
        challenge(viewed! as unknown as PoolInstallationConsentContext)
      )
    ).toThrow();
    const response = await post('/consent', body(), token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: 'pool-installation-consent',
      purpose: POOL_INSTALLATION_CONSENT_PURPOSE,
      version: 1,
      requestId: viewed!.requestId,
      offerNonce,
      requestDigest: nominated.requestDigest,
      principal: nominated.principal,
      consent: true,
    });
    const current = answerPoolInstallationChallenge(authority, consent!, challenge());
    expect(current.principal).toEqual(nominated.principal);
    expect(current.expiresAtEpochMs).toBeLessThanOrEqual(viewed!.expiresAtEpochMs);
    expect(current.consent).toBe(true);
    expect(() => JSON.stringify(consent)).toThrow();
    expect((await post('/consent', body(), token)).statusCode).toBe(403);
    expect(await readFile(store.file, 'utf8')).toBe(before);
  }
);

it('does not resolve a nomination to primary, another owner, title or a same-principal different cookie', async () => {
  const member = await owner();
  nominated = { ...nominated, principal: auth.registrationIdentity(member.token) };
  expect((await post('/view')).statusCode).toBe(403);
  expect((await post('/view', undefined, member.token)).statusCode).toBe(200);
  const second = (await auth.login('fixture-member', password, '127.0.0.1')).session!;
  tokens.push(second);
  expect(auth.registrationIdentity(second)).toEqual(nominated.principal);
  expect((await post('/consent', body(), second)).statusCode).toBe(403);
});

it('refuses malformed/changed consent bodies and never accepts caller requestId or principal selection', async () => {
  expect((await post('/view')).statusCode).toBe(200);
  for (const payload of [
    { ...body(), consent: false },
    { ...body(), consent: 1 },
    { ...body(), consent: 'true' },
    { ...body(), offerNonce: nonce },
    { ...body(), requestDigest: 'b'.repeat(64) },
    { ...body(), requestId: nonce },
    { ...body(), principal: nominated.principal },
    { offerNonce, requestDigest: nominated.requestDigest },
  ])
    expect((await post('/consent', payload)).statusCode).toBe(403);
  expect((await post('/consent', body())).statusCode).toBe(200);
});

it('rejects foreign issuers and reconstructed contexts instead of reconstructing consent from JSON', async () => {
  expect((await post('/view')).statusCode).toBe(200);
  const foreign = new ResourceOwnerAuthority(auth);
  authorities.push(foreign);
  expect(() => foreign.assertContext(viewed!)).toThrow();
  expect(() => authority.assertContext({ ...viewed! })).toThrow();
  expect((await post('/consent', body())).statusCode).toBe(200);
  expect(() => poolInstallationConsentRequest(foreign, consent!)).toThrow();
  expect(() => poolInstallationConsentRequest(authority, { ...consent! })).toThrow();
});

it('keeps the original view expiry across consent and checks the exact challenge tuple', async () => {
  expect((await post('/view')).statusCode).toBe(200);
  vi.spyOn(Date, 'now').mockReturnValue(viewed!.expiresAtEpochMs - 10);
  expect((await post('/consent', body())).statusCode).toBe(200);
  expect(consent!.expiresAtEpochMs).toBe(viewed!.expiresAtEpochMs);
  for (const changed of [
    { version: true },
    { version: '1' },
    { purpose: 'resource-ram-pool-v2' },
    { requestId: nonce },
    { offerNonce: nonce },
    { requestDigest: 'b'.repeat(64) },
    { nonce: '00000000-0000-0000-0000-000000000000' },
    { principal: { ...consent!.principal, sessionEpoch: consent!.principal.sessionEpoch + 1 } },
    { employeeId: nonce },
  ])
    expect(() => answerPoolInstallationChallenge(authority, consent!, { ...challenge(), ...changed })).toThrow();
  expect(answerPoolInstallationChallenge(authority, consent!, challenge()).version).toBe(1);
  vi.mocked(Date.now).mockReturnValue(viewed!.expiresAtEpochMs);
  expect(() => answerPoolInstallationChallenge(authority, consent!, challenge())).toThrow();
});

it('denies guest, mixed credentials and foreign-origin consent POSTs', async () => {
  for (const [token, headers] of [
    ['', {}],
    [primary, { authorization: 'Basic fixture' }],
    [primary, { 'x-reverie-service-token': 'fixture' }],
    [primary, { 'x-reverie-parent-session': nonce }],
    [primary, { 'x-reverie-goal-token': 'fixture' }],
    [primary, { origin: 'http://foreign.example' }],
  ] as [string, Record<string, string>][]) {
    expect((await post('/view')).statusCode).toBe(200);
    expect((await post('/consent', body(), token, headers)).statusCode).toBe(403);
    expect((await post('/consent', body())).statusCode).toBe(200);
  }
});

it('rereads the original cookie before consent rather than treating view as approval', async () => {
  expect((await post('/view')).statusCode).toBe(200);
  auth.logout(primary);
  expect((await post('/consent', body())).statusCode).toBe(403);
  expect(consent).toBeUndefined();
});

it.each(['logout', 'canonical-demotion', 'account-replacement'] as const)(
  'rereads canonical identity on every challenge after %s',
  async (change) => {
    const member = await owner();
    nominated = { ...nominated, principal: auth.registrationIdentity(member.token) };
    expect((await post('/view', undefined, member.token)).statusCode).toBe(200);
    expect((await post('/consent', body(), member.token)).statusCode).toBe(200);
    if (change === 'logout') auth.logout(member.token);
    else if (change === 'canonical-demotion') {
      const peopleFile = join(directory, 'office-people.json');
      const people = JSON.parse(await readFile(peopleFile, 'utf8'));
      people.people.find((person: { id: string }) => person.id === member.id).role = 'limited';
      await writeCompanyStateFile(peopleFile, JSON.stringify(people));
    } else {
      const selected = new OwnerAuthStore(join(directory, 'people', member.id, 'owner-auth.json'));
      await selected.update((account) => {
        account.accountId = nonce;
      });
    }
    expect(() => answerPoolInstallationChallenge(authority, consent!, challenge())).toThrow();
  }
);

it('refuses missing enrollment without repairing it during view or consent', async () => {
  await store.update((account) => {
    delete account.accountId;
  });
  auth.logout(primary);
  primary = (await auth.login('fixture-primary', password, '127.0.0.1')).session!;
  tokens.push(primary);
  const before = await readFile(store.file, 'utf8');
  expect((await post('/view')).statusCode).toBe(409);
  expect(await readFile(store.file, 'utf8')).toBe(before);
});
