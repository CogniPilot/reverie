/** Actual account/session fixtures only; no host registration, native actor or grant. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootstrap } from '../src/owner-auth/admin.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { writeCompanyStateFile } from '../src/company-store.js';

const password = 'Synthetic-registration-fixture-42!';
let directory: string, store: OwnerAuthStore, auth: OfficeAuthService, primary: string;

beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'owner-registration-'));
  store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  primary = await auth.setup('fixture-primary', password, password, '127.0.0.1');
});

afterEach(async () => {
  auth?.logout(primary);
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function person(role: 'owner' | 'limited', restricted = false) {
  const made = await auth.create({ username: 'fixture-member', name: 'Member', role, rooms: [] });
  const login = await auth.login('fixture-member', made.oneTimePassword, '127.0.0.1');
  const token = restricted
    ? login.session!
    : await auth
        .forSession(login.session)
        .changePassword(login.session, { current: made.oneTimePassword, next: password }, '127.0.0.1');
  return {
    id: made.person.id,
    token,
    store: new OwnerAuthStore(join(directory, 'people', made.person.id, 'owner-auth.json')),
  };
}

it('assigns a durable incarnation at new setup without changing legacy human identity', async () => {
  const identity = auth.registrationIdentity(primary);
  expect(identity.accountId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  expect(identity.personId).toBe('owner');
  expect(identity.sessionEpoch).toBe(store.readCurrent()!.epoch);
  expect(auth.identity(primary)).toMatchObject({ id: 'owner', role: 'owner', primary: true });
  const raw = await readFile(store.file, 'utf8');
  expect(auth.registrationIdentity(primary)).toEqual(identity);
  expect(await readFile(store.file, 'utf8')).toBe(raw);
  expect(auth.isMessageOwner('owner')).toBe(true);
});

it('explicitly enrolls legacy accounts while preserving credentials, MFA and unknown fields', async () => {
  await store.update((account) => {
    delete account.accountId;
  });
  auth.logout(primary);
  primary = (await auth.login('fixture-primary', password, '127.0.0.1')).session!;
  await store.update((account) => {
    account.totp = { secret: 'retained-fixture-secret', enabledAt: 1, lastStep: 1 };
    account.recovery = [{ hash: 'retained-recovery' }];
    account.services = [{ id: 'retained-service', hash: 'retained-hash', name: 'fixture', createdAt: 1 }];
    Object.assign(account, { futureAccountData: { retained: true } });
  });
  const before = JSON.parse(await readFile(store.file, 'utf8'));
  expect(() => auth.registrationIdentity(primary)).toThrow('Explicit account enrollment');
  expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual(before);
  const enrolled = await auth.enrollRegistrationIdentity(primary);
  const after = JSON.parse(await readFile(store.file, 'utf8'));
  expect(after).toEqual({ ...before, accountId: enrolled.accountId });
  expect(await auth.enrollRegistrationIdentity(primary)).toEqual(enrolled);
  expect(new OwnerAuthStore(store.file).readCurrent()!.accountId).toBe(enrolled.accountId);
});

it('uses the real secondary office id alongside the independent durable account incarnation', async () => {
  const member = await person('owner');
  const local = auth.forSession(member.token).registrationIdentity(member.token);
  expect(local.personId).toBe('owner');
  const root = auth.registrationIdentity(member.token);
  expect(root.personId).toBe(member.id);
  expect(root.accountId).toBe(local.accountId);
  expect(root.accountId).not.toBe(auth.registrationIdentity(primary).accountId);
  expect(await auth.enrollRegistrationIdentity(member.token)).toEqual(root);
});

it('resolves service owner DATA from the actual primary or named invited registration without enrollment', async () => {
  const member = await person('owner');
  const before = await readFile(store.file, 'utf8');
  const main = auth.registrationIdentity(primary), invited = auth.registrationIdentity(member.token);
  expect(auth.registeredResourceOwner(undefined)).toEqual(main);
  expect(auth.registeredResourceOwner('fixture-primary')).toEqual(main);
  expect(auth.registeredResourceOwner('fixture-member')).toEqual(invited);
  expect(() => auth.registeredResourceOwner('Member')).toThrow();
  expect(() => auth.registeredResourceOwner('missing')).toThrow();
  expect(await readFile(store.file, 'utf8')).toBe(before);
  await member.store.update(account => { delete account.accountId; });
  expect(() => auth.registeredResourceOwner('fixture-member')).toThrow();
  expect(member.store.readCurrent()!.accountId).toBeUndefined();
  expect(auth.registeredResourceOwner(undefined)).toEqual(main);
});

it.each(['limited', 'disabled'] as const)('refuses a named service owner after actual %s, retaining explicit primary binding', async change => {
  const member = await person('owner');
  const main = auth.registeredResourceOwner(undefined);
  await auth.update(member.id, change === 'limited' ? {role:'limited'} : {disabled:true});
  expect(() => auth.registeredResourceOwner('fixture-member')).toThrow();
  expect(auth.registeredResourceOwner(undefined)).toEqual(main);
});

it('refuses ambiguous canonical usernames and detects actual account incarnation/epoch changes', async () => {
  const member = await person('owner');
  const original = auth.registeredResourceOwner('fixture-member');
  await member.store.update(account => { account.epoch++; });
  expect(auth.registeredResourceOwner('fixture-member').sessionEpoch).toBe(original.sessionEpoch + 1);
  await member.store.update(account => { account.username = 'fixture-primary'; });
  expect(() => auth.registeredResourceOwner('fixture-primary')).toThrow();
  expect(auth.registeredResourceOwner(undefined).accountId).not.toBe(original.accountId);
});

it.each(['limited', 'restricted'] as const)('refuses %s enrollment without assigning a legacy id', async (kind) => {
  const member = await person(kind === 'limited' ? 'limited' : 'owner', kind === 'restricted');
  await member.store.update((account) => {
    delete account.accountId;
  });
  expect(() => auth.registrationIdentity(member.token)).toThrow();
  await expect(auth.enrollRegistrationIdentity(member.token)).rejects.toThrow();
  expect(member.store.readCurrent()!.accountId).toBeUndefined();
});

it.each(['logout', 'limited', 'disabled'] as const)('refuses current identity after actual %s', async (change) => {
  const member = await person('owner');
  const before = auth.registrationIdentity(member.token);
  if (change === 'logout') auth.logout(member.token);
  else await auth.update(member.id, change === 'limited' ? { role: 'limited' } : { disabled: true });
  expect(() => auth.registrationIdentity(member.token)).toThrow();
  await expect(auth.enrollRegistrationIdentity(member.token)).rejects.toThrow();
  expect(member.store.readCurrent()!.accountId).toBe(before.accountId);
});

it('does not identify a replacement account by the reused username or public owner id', async () => {
  const original = auth.registrationIdentity(primary);
  const replaced = await bootstrap(store, 'fixture-primary', { force: true });
  const login = await auth.login('fixture-primary', replaced.oneTimePassword, '127.0.0.1');
  const next = await auth.changePassword(
    login.session,
    { current: replaced.oneTimePassword, next: password },
    '127.0.0.1'
  );
  expect(auth.identity(next)).toMatchObject({ id: 'owner', username: 'fixture-primary' });
  expect(auth.registrationIdentity(next).accountId).not.toBe(original.accountId);
  expect(() => auth.registrationIdentity(primary)).toThrow();
  primary = next;
});

it('refuses corrupt current storage despite a warmed last-good authentication cache', async () => {
  const original = auth.registrationIdentity(primary);
  const raw = await readFile(store.file, 'utf8');
  await writeFile(store.file, '{broken');
  expect(auth.identity(primary)).toBeDefined();
  expect(() => auth.registrationIdentity(primary)).toThrow();
  await expect(auth.enrollRegistrationIdentity(primary)).rejects.toThrow();
  expect(await readFile(store.file, 'utf8')).toBe('{broken');
  await writeFile(store.file, raw);
  expect(auth.registrationIdentity(primary)).toEqual(original);
});

it('refuses a malformed existing incarnation instead of silently replacing it', async () => {
  await store.update((account) => {
    account.accountId = 'not-an-account-uuid';
  });
  const raw = await readFile(store.file, 'utf8');
  expect(() => auth.registrationIdentity(primary)).toThrow();
  await expect(auth.enrollRegistrationIdentity(primary)).rejects.toThrow();
  expect(await readFile(store.file, 'utf8')).toBe(raw);
});

it('refuses an account incarnation substitution even when username and epoch are unchanged', async () => {
  const original = auth.registrationIdentity(primary);
  await store.update((account) => {
    account.accountId = '10000000-0000-4000-8000-000000000001';
  });
  expect(store.readCurrent()!.epoch).toBe(original.sessionEpoch);
  expect(auth.identity(primary)).toMatchObject({ id: 'owner', username: 'fixture-primary' });
  expect(() => auth.registrationIdentity(primary)).toThrow();
  await expect(auth.enrollRegistrationIdentity(primary)).rejects.toThrow();
  expect(store.readCurrent()!.accountId).not.toBe(original.accountId);
});

it('refuses malformed credential fields in valid current JSON without using a session cache', async () => {
  const current = JSON.parse(await readFile(store.file, 'utf8'));
  current.password.hash = 'not-a-password-hash';
  const raw = JSON.stringify(current);
  await writeFile(store.file, raw);
  expect(() => auth.registrationIdentity(primary)).toThrow();
  await expect(auth.enrollRegistrationIdentity(primary)).rejects.toThrow();
  expect(await readFile(store.file, 'utf8')).toBe(raw);
});

it.each(['current', 'legacy'] as const)(
  'never binds a legacy token to a real %s replacement setup at the same epoch',
  async (format) => {
    await store.update((account) => {
      delete account.accountId;
    });
    auth.logout(primary);
    primary = (await auth.login('fixture-primary', password, '127.0.0.1')).session!;
    const originalEpoch = store.readCurrent()!.epoch;
    await rm(store.file);
    await rm(store.markerFile);
    const replacement = new OfficeAuthService({
      store: new OwnerAuthStore(store.file),
      auditFile: join(directory, 'replacement-audit.jsonl'),
      setupEnabled: true,
    });
    const next = await replacement.setup('fixture-primary', password, password, '127.0.0.1');
    try {
      const current = replacement.registrationIdentity(next);
      expect(current.sessionEpoch).toBe(originalEpoch);
      // The second case also covers an older replacement's no-UUID projection:
      // optional-ID equality alone cannot distinguish those account births.
      if (format === 'legacy')
        await store.update((account) => {
          delete account.accountId;
        });
      const replacementRaw = await readFile(store.file, 'utf8');
      expect(auth.identity(primary)).toMatchObject({ id: 'owner', username: 'fixture-primary' });
      expect(() => auth.registrationIdentity(primary)).toThrow();
      await expect(auth.enrollRegistrationIdentity(primary)).rejects.toThrow();
      expect(await readFile(store.file, 'utf8')).toBe(replacementRaw);
      if (format === 'current') expect(replacement.registrationIdentity(next)).toEqual(current);
    } finally {
      replacement.logout(next);
    }
  }
);

it('refuses fresh mustChange at the same epoch despite the original unrestricted local session', async () => {
  const member = await person('owner');
  const local = auth.forSession(member.token);
  const before = local.registrationIdentity(member.token);
  await member.store.update((account) => {
    account.mustChange = true;
  });
  expect(member.store.readCurrent()!.epoch).toBe(before.sessionEpoch);
  expect(() => local.registrationIdentity(member.token)).toThrow();
  await expect(local.enrollRegistrationIdentity(member.token)).rejects.toThrow();
  expect(member.store.readCurrent()!.accountId).toBe(before.accountId);
});

it.each(['limited', 'disabled', 'removed', 'corrupt'] as const)(
  'refuses externally published %s office authority while ordinary cached identity is unchanged',
  async (change) => {
    const member = await person('owner');
    const original = auth.registrationIdentity(member.token);
    const accountRaw = await readFile(member.store.file, 'utf8');
    const peopleFile = join(directory, 'office-people.json');
    const canonical = JSON.parse(await readFile(peopleFile, 'utf8'));
    if (change === 'removed') canonical.people = canonical.people.filter((p: { id: string }) => p.id !== member.id);
    else if (change === 'limited' || change === 'disabled') {
      const person = canonical.people.find((p: { id: string }) => p.id === member.id);
      if (change === 'limited') person.role = 'limited';
      else person.disabled = true;
    }
    await writeCompanyStateFile(peopleFile, change === 'corrupt' ? '{broken' : JSON.stringify(canonical));
    expect(auth.identity(member.token)).toMatchObject({ id: member.id, role: 'owner' });
    expect(member.store.readCurrent()!.epoch).toBe(original.sessionEpoch);
    expect(() => auth.registrationIdentity(member.token)).toThrow();
    await expect(auth.enrollRegistrationIdentity(member.token)).rejects.toThrow();
    expect(await readFile(member.store.file, 'utf8')).toBe(accountRaw);
  }
);
