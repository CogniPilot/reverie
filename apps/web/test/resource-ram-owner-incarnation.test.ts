/** Actual qualified OwnerAuth/Office enrollment services and private HTTP
 * fixtures only. No native grant, enrollment offer, listener or host effects. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { writeCompanyStateFile } from '../src/company-store.js';
import { ResourceOwnerAuthority, type AnyResourceContext } from '../src/resource-owner-authority.js';

const password = 'Synthetic-ram-incarnation-fixture-42!';
const approved = {
  employeeId: '10000000-0000-4000-8000-000000000001',
  draftId: '10000000-0000-4000-8000-000000000002',
  operationId: '10000000-0000-4000-8000-000000000003',
  reservationId: '10000000-0000-4000-8000-000000000004',
  targetSid: '10000000-0000-4000-8000-000000000005',
  profileVersion: '1',
  profileDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
};
const modes = ['legacy-preview', 'legacy-apply', 'ram-preview', 'ram-apply'] as const;
type Mode = (typeof modes)[number];
let directory: string, app: FastifyInstance, store: OwnerAuthStore, auth: OfficeAuthService, primary: string;
let sources: Map<string, ResourceOwnerAuthority>, captured: Map<string, AnyResourceContext>;
beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'ram-owner-incarnation-'));
  store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  primary = await auth.setup('fixture-primary', password, password, '127.0.0.1');
  sources = new Map([['original', new ResourceOwnerAuthority(auth)]]);
  captured = new Map();
  app = Fastify();
  await app.register(cookie);
  app.post<{ Params: { source: string; mode: string } }>('/capture/:source/:mode', async (request, reply) => {
    try {
      const authority = sources.get(request.params.source);
      if (!authority) throw new Error('Unknown actual fixture authority');
      let context: AnyResourceContext;
      switch (request.params.mode) {
        case 'legacy-preview':
          context = authority.capturePreview(request, approved.employeeId);
          break;
        case 'legacy-apply':
          context = authority.capture(request, approved);
          break;
        case 'ram-preview':
          context = authority.captureRamPreview(request, approved.employeeId);
          break;
        case 'ram-apply':
          context = authority.captureRam(request, { ...approved, ramPolicyDigest: 'c'.repeat(64) });
          break;
        default:
          throw new Error('Unknown fixture mode');
      }
      captured.set(request.params.source + ':' + request.params.mode, context);
      return { purpose: context.purpose, stage: context.stage };
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? Number(error.status) : 403;
      return reply.code(status).send({ error: error instanceof Error ? error.message : 'Refused' });
    }
  });
});
afterEach(async () => {
  for (const source of sources.values()) source.close();
  auth.logout(primary);
  await app.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const capture = (mode: Mode, token = primary, source = 'original') =>
  app.inject({
    method: 'POST',
    url: '/capture/' + source + '/' + mode,
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
  });
async function captureAll(token = primary) {
  for (const mode of modes) expect((await capture(mode, token)).statusCode).toBe(200);
  return new Map(modes.map((mode) => [mode, captured.get('original:' + mode)!]));
}
async function member() {
  const created = await auth.create({ username: 'fixture-member', name: 'Member', role: 'owner', rooms: [] });
  const login = await auth.login('fixture-member', created.oneTimePassword, '127.0.0.1');
  const token = await auth
    .forSession(login.session)
    .changePassword(login.session, { current: created.oneTimePassword, next: password }, '127.0.0.1');
  return {
    id: created.person.id,
    token,
    store: new OwnerAuthStore(join(directory, 'people', created.person.id, 'owner-auth.json')),
  };
}

it.each(['primary', 'secondary'] as const)(
  'pins fresh canonical %s account/person identity without writing it',
  async (kind) => {
    const selected = kind === 'primary' ? { token: primary, store } : await member();
    const before = await readFile(selected.store.file, 'utf8');
    const contexts = await captureAll(selected.token);
    for (const [mode, context] of contexts) {
      context.assertCurrent();
      if (context.purpose === 'resource-ram-pool-v2') {
        expect(context.principal).toEqual(auth.registrationIdentity(selected.token));
        expect(Object.isFrozen(context.principal)).toBe(true);
        expect(Reflect.set(context.principal, 'accountId', 'not-a-current-account')).toBe(false);
      } else {
        expect(mode.startsWith('legacy')).toBe(true);
        expect(context).not.toHaveProperty('principal');
      }
    }
    expect(await readFile(selected.store.file, 'utf8')).toBe(before);
    expect(auth.registrationIdentity(selected.token).accountId).toMatch(/^[a-f0-9-]{36}$/);
  }
);

it('invalidates RAM contexts on real same-name replacement setup at reused epoch while v1 is unchanged', async () => {
  const contexts = await captureAll(),
    original = auth.registrationIdentity(primary);
  await rm(store.file);
  await rm(store.markerFile);
  const replacement = new OfficeAuthService({
    store: new OwnerAuthStore(store.file),
    auditFile: join(directory, 'replacement-audit.jsonl'),
    setupEnabled: true,
  });
  const next = await replacement.setup('fixture-primary', password, password, '127.0.0.1');
  const authority = new ResourceOwnerAuthority(replacement);
  sources.set('replacement', authority);
  try {
    const identity = replacement.registrationIdentity(next);
    expect(identity.sessionEpoch).toBe(original.sessionEpoch);
    expect(identity.accountId).not.toBe(original.accountId);
    const raw = await readFile(store.file, 'utf8');
    for (const mode of modes) {
      if (mode.startsWith('legacy')) {
        expect(() => contexts.get(mode)!.assertCurrent()).not.toThrow();
        expect((await capture(mode)).statusCode).toBe(200);
      } else {
        expect(() => contexts.get(mode)!.assertCurrent()).toThrow();
        expect((await capture(mode)).statusCode).toBe(403);
        expect((await capture(mode, next, 'replacement')).statusCode).toBe(200);
      }
    }
    expect(await readFile(store.file, 'utf8')).toBe(raw);
  } finally {
    replacement.logout(next);
  }
});

it('refuses actual canonical fingerprint drift without changing ordinary v1 identity semantics', async () => {
  const contexts = await captureAll(),
    original = auth.registrationIdentity(primary);
  await store.update((account) => {
    account.passwordChangedAt += 1;
  });
  expect(store.readCurrent()!.epoch).toBe(original.sessionEpoch);
  expect(store.readCurrent()!.accountId).toBe(original.accountId);
  const raw = await readFile(store.file, 'utf8');
  for (const mode of modes) {
    if (mode.startsWith('legacy')) expect(() => contexts.get(mode)!.assertCurrent()).not.toThrow();
    else {
      expect(() => contexts.get(mode)!.assertCurrent()).toThrow();
      expect((await capture(mode)).statusCode).toBe(403);
    }
  }
  const fresh = (await auth.login('fixture-primary', password, '127.0.0.1')).session!;
  try {
    for (const mode of ['ram-preview', 'ram-apply'] as const) expect((await capture(mode, fresh)).statusCode).toBe(200);
  } finally {
    auth.logout(fresh);
  }
  expect(await readFile(store.file, 'utf8')).toBe(raw);
});

it.each(['limited', 'disabled', 'removed', 'corrupt'] as const)(
  'rechecks external canonical Office %s at every RAM currentness check',
  async (change) => {
    const selected = await member(),
      contexts = await captureAll(selected.token);
    const accountRaw = await readFile(selected.store.file, 'utf8'),
      peopleFile = join(directory, 'office-people.json');
    const people = JSON.parse(await readFile(peopleFile, 'utf8'));
    if (change === 'removed') people.people = people.people.filter((p: { id: string }) => p.id !== selected.id);
    else if (change === 'limited' || change === 'disabled') {
      const person = people.people.find((p: { id: string }) => p.id === selected.id);
      if (change === 'limited') person.role = 'limited';
      else person.disabled = true;
    }
    await writeCompanyStateFile(peopleFile, change === 'corrupt' ? '{broken' : JSON.stringify(people));
    for (const mode of modes) {
      if (mode.startsWith('legacy')) expect(() => contexts.get(mode)!.assertCurrent()).not.toThrow();
      else {
        expect(() => contexts.get(mode)!.assertCurrent()).toThrow();
        expect((await capture(mode, selected.token)).statusCode).toBe(403);
      }
    }
    expect(await readFile(selected.store.file, 'utf8')).toBe(accountRaw);
  }
);

it.each(['logout', 'limited', 'disabled'] as const)(
  'still respects actual Office %s revocation for RAM and ordinary contexts',
  async (change) => {
    const selected = await member(),
      contexts = await captureAll(selected.token);
    if (change === 'logout') auth.logout(selected.token);
    else await auth.update(selected.id, change === 'limited' ? { role: 'limited' } : { disabled: true });
    for (const context of contexts.values()) expect(() => context.assertCurrent()).toThrow();
    for (const mode of ['ram-preview', 'ram-apply'] as const)
      expect((await capture(mode, selected.token)).statusCode).toBe(403);
  }
);

it('precisely refuses unenrolled RAM without writes and uses only the explicit checked enrollment operation', async () => {
  await store.update((account) => {
    delete account.accountId;
  });
  auth.logout(primary);
  primary = (await auth.login('fixture-primary', password, '127.0.0.1')).session!;
  const raw = await readFile(store.file, 'utf8');
  for (const mode of modes) {
    const response = await capture(mode);
    if (mode.startsWith('legacy')) expect(response.statusCode).toBe(200);
    else {
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('Explicit account enrollment');
    }
  }
  expect(await readFile(store.file, 'utf8')).toBe(raw);
  expect(store.readCurrent()!.accountId).toBeUndefined();
  const enrolled = await auth.enrollRegistrationIdentity(primary);
  expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual({ ...JSON.parse(raw), accountId: enrolled.accountId });
  for (const mode of ['ram-preview', 'ram-apply'] as const) expect((await capture(mode)).statusCode).toBe(200);
});
it('rejects a NIL current account principal without silently replacing it or changing v1', async () => {
  const nil = '00000000-0000-0000-0000-000000000000';
  await store.update((account) => {
    account.accountId = nil;
  });
  auth.logout(primary);
  primary = (await auth.login('fixture-primary', password, '127.0.0.1')).session!;
  expect(auth.registrationIdentity(primary).accountId).toBe(nil);
  const raw = await readFile(store.file, 'utf8');
  for (const mode of modes) expect((await capture(mode)).statusCode).toBe(mode.startsWith('legacy') ? 200 : 403);
  expect(await readFile(store.file, 'utf8')).toBe(raw);
});
