import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { authenticatedPlanMover } from '../src/web/plan-move-auth.js';
import type { AuthSessionRecord } from '../src/web/ports/auth-port.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';

describe('plan move browser credential gate, independent of owner-auth log mode', () => {
  const request = async (
    headers: Record<string, string>,
    record?: AuthSessionRecord,
    ownerSession?: { restricted: boolean }
  ) => {
    const app = Fastify();
    await app.register(cookie);
    const sessions = new Map(record ? [['signed-in', record]] : []);
    let moved = false;
    app.post('/api/plans/moves', (req, reply) => {
      const ownerAuth = ownerSession
        ? { session: (token: string | undefined) => (token === 'owner-cookie' ? ownerSession : undefined) }
        : undefined;
      if (!authenticatedPlanMover(req, sessions, ownerAuth)) return reply.code(403).send({ success: false });
      moved = true;
      return { success: true };
    });
    try {
      const result = await app.inject({ method: 'POST', url: '/api/plans/moves', headers });
      return { code: result.statusCode, moved };
    } finally {
      await app.close();
    }
  };
  const credential: AuthSessionRecord = { ip: '127.0.0.1', ua: 'test', createdAt: Date.now(), method: 'basic' };
  const origin = { host: 'console.test', origin: 'https://console.test' };

  it('refuses header-less requests without a cookie', async () => {
    expect(await request(origin)).toEqual({ code: 403, moved: false });
  });

  it('refuses invalid or expired credentials', async () => {
    expect(await request({ ...origin, cookie: 'codeman_session=expired' }, credential)).toEqual({
      code: 403,
      moved: false,
    });
  });

  it('accepts a current signed-in owner cookie from the same origin', async () => {
    expect(await request({ ...origin, cookie: 'codeman_session=signed-in' }, credential)).toEqual({
      code: 200,
      moved: true,
    });
  });

  it('refuses any agent hint even with a valid owner cookie', async () => {
    expect(
      await request(
        { ...origin, cookie: 'codeman_session=signed-in', 'x-codeman-parent-session': 'claimed-live-session' },
        credential
      )
    ).toEqual({ code: 403, moved: false });
  });

  it('refuses cross-origin requests and password-change-only credentials', async () => {
    expect(
      await request(
        { host: 'console.test', origin: 'https://other.test', cookie: 'codeman_session=signed-in' },
        credential
      )
    ).toEqual({ code: 403, moved: false });
    expect(
      await request({ ...origin, cookie: 'codeman_session=signed-in' }, { ...credential, mustChangePassword: true })
    ).toEqual({ code: 403, moved: false });
  });

  it('never gives a regular multi-user cookie owner move authority', async () => {
    expect(await request({ ...origin, cookie: 'codeman_session=signed-in' }, { ...credential, role: 'user' })).toEqual({
      code: 403,
      moved: false,
    });
  });

  it('rejects a restricted owner-auth session while accepting its unrestricted control', async () => {
    const headers = { ...origin, cookie: `${OWNER_COOKIE}=owner-cookie` };
    expect(await request(headers, undefined, { restricted: false })).toEqual({ code: 200, moved: true });
    expect(await request(headers, undefined, { restricted: true })).toEqual({ code: 403, moved: false });
  });
});
