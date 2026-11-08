/** Real shared-office accounts and current sessions; no listener or native actor. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { ResourceOwnerAuthority, type AnyResourceContext } from '../src/resource-owner-authority.js';

const password = 'Synthetic-office-resource-only-42!';
const approval = {
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
let directory: string, app: FastifyInstance, auth: OfficeAuthService, authority: ResourceOwnerAuthority;
let primary: string;
let captured: Map<string, AnyResourceContext>;

beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'resource-office-owner-'));
  auth = new OfficeAuthService({
    store: new OwnerAuthStore(join(directory, 'owner-auth.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  primary = await auth.setup('fixture-primary', password, password, '127.0.0.1');
  authority = new ResourceOwnerAuthority(auth);
  captured = new Map();
  app = Fastify();
  await app.register(cookie);
  app.post<{ Params: { mode: string } }>('/capture/:mode', async (request, reply) => {
    try {
      let context: AnyResourceContext;
      switch (request.params.mode) {
        case 'legacy-preview':
          context = authority.capturePreview(request, approval.employeeId);
          break;
        case 'legacy-apply':
          context = authority.capture(request, approval);
          break;
        case 'ram-preview':
          context = authority.captureRamPreview(request, approval.employeeId);
          break;
        case 'ram-apply':
          context = authority.captureRam(request, { ...approval, ramPolicyDigest: 'c'.repeat(64) });
          break;
        default:
          return reply.code(400).send({ error: 'Unknown fixture mode' });
      }
      captured.set(request.params.mode, context);
      return { purpose: context.purpose, stage: context.stage };
    } catch {
      return reply.code(403).send({ error: 'refused' });
    }
  });
});

afterEach(async () => {
  authority?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function person(role: 'owner' | 'limited') {
  const made = await auth.create({ username: 'fixture-member', name: 'Fixture Member', role, rooms: [] });
  const login = await auth.login('fixture-member', made.oneTimePassword, '127.0.0.1');
  expect(login.next).toBe('change-password');
  expect(login.session).toBeTruthy();
  const token = await auth
    .forSession(login.session)
    .changePassword(login.session, { current: made.oneTimePassword, next: password }, '127.0.0.1');
  expect(auth.session(token)).toEqual({ restricted: false, role });
  return { id: made.person.id, token };
}

function capture(mode: (typeof modes)[number], token: string) {
  return app.inject({
    method: 'POST',
    url: '/capture/' + mode,
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
  });
}

it.each(modes)(
  'refuses a genuine limited office account at %s despite its account-local owner identity',
  async (mode) => {
    const member = await person('limited');
    expect(auth.identity(member.token)).toMatchObject({ id: member.id, role: 'limited', primary: false });
    expect(auth.forSession(member.token).identity(member.token)).toMatchObject({
      id: 'owner',
      role: 'owner',
      primary: true,
    });
    const response = await capture(mode, member.token);
    expect(response.statusCode).toBe(403);
    expect(captured.size).toBe(0);
  }
);

it.each(['primary', 'secondary'] as const)(
  'keeps all four captures available to the actual %s office owner',
  async (kind) => {
    const member = kind === 'secondary' ? await person('owner') : undefined;
    const token = member?.token ?? primary;
    expect(auth.identity(token)).toMatchObject({
      id: member?.id ?? 'owner',
      role: 'owner',
      primary: kind === 'primary',
    });
    for (const mode of modes) {
      expect((await capture(mode, token)).statusCode).toBe(200);
      authority.assertContext(captured.get(mode)!);
    }
    expect(captured.size).toBe(4);
  }
);

it.each(['logout', 'limited', 'disabled'] as const)(
  'revokes every retained context and tracked socket after actual %s',
  async (change) => {
    const member = await person('owner');
    const socket = new Socket();
    const releases: Array<() => void> = [];
    try {
      for (const mode of modes) {
        expect((await capture(mode, member.token)).statusCode).toBe(200);
        releases.push(authority.track(captured.get(mode)!, socket));
      }
      expect(socket.destroyed).toBe(false);
      if (change === 'logout') auth.logout(member.token);
      else await auth.update(member.id, change === 'limited' ? { role: 'limited' } : { disabled: true });
      for (const context of captured.values()) expect(() => authority.assertContext(context)).toThrow();
      expect(socket.destroyed).toBe(true);
      for (const mode of modes) expect((await capture(mode, member.token)).statusCode).toBe(403);
    } finally {
      for (const release of releases) release();
      socket.destroy();
    }
  }
);
