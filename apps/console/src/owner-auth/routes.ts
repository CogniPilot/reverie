/**
 * @fileoverview Owner sign-in endpoints (`/api/owner/*`) and two small self-contained pages
 * (`/owner/login`, `/owner/account`) that use them, independent of the chat app's bundle.
 *
 * Cookies: the session (`reverie_owner`) is HttpOnly, SameSite=Strict, Secure whenever the browser
 * reached us over HTTPS (directly or through a tunnel), and lives at most SESSION_MAX_MS, while the
 * server also enforces the idle timeout. The remembered-device cookie is the same but lasts 30 days
 * and is sent only to `/api/owner` (it skips the second factor at sign-in, nothing else).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_COOKIE, OWNER_COOKIE } from './policy.js';
import { DEVICE_TTL_MS, OwnerAuthError, SESSION_MAX_MS, type OwnerAuthService } from './service.js';
import { LOGIN_PAGE, ACCOUNT_PAGE, OWNER_SCRIPT } from './pages.js';

type Body = Record<string, unknown>;

/** A Host header naming this machine's loopback (where browsers accept Secure cookies over http too). */
export function isLoopbackHost(host: string): boolean {
  const name = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return name === 'localhost' || name === '::1' || /^127\./.test(name);
}

export function registerOwnerRoutes(app: FastifyInstance, service: OwnerAuthService, https: boolean): void {
  // Secure everywhere except a loopback Host (browsers accept Secure cookies on http://localhost),
  // so the flag does not depend on a proxy's X-Forwarded-Proto.
  const secure = (req: FastifyRequest): boolean => https || !isLoopbackHost(String(req.headers.host ?? ''));
  const setSession = (req: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(OWNER_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secure(req),
      path: '/',
      maxAge: SESSION_MAX_MS / 1000,
    });
  const setDevice = (req: FastifyRequest, reply: FastifyReply, value: string) =>
    reply.setCookie(DEVICE_COOKIE, value, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secure(req),
      path: '/api/owner',
      maxAge: DEVICE_TTL_MS / 1000,
    });
  const clear = (reply: FastifyReply, devices = false) => {
    reply.clearCookie(OWNER_COOKIE, { path: '/' });
    if (devices) reply.clearCookie(DEVICE_COOKIE, { path: '/api/owner' });
  };
  /** Account management needs a full owner session, whatever the enforcement policy. */
  const owner = (req: FastifyRequest): void => {
    const session = service.session(req.cookies?.[OWNER_COOKIE]);
    if (!session) throw new OwnerAuthError('Sign in as the owner', 401);
    if (session.restricted) throw new OwnerAuthError('Change the one-time password first', 403);
  };
  const handle =
    (work: (req: FastifyRequest, reply: FastifyReply, body: Body) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = await work(req, reply, (req.body ?? {}) as Body);
        return { success: true, data };
      } catch (error) {
        if (!(error instanceof OwnerAuthError)) throw error;
        if (error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds));
        reply.code(error.status);
        return {
          success: false,
          error: error.message,
          ...(error.retryAfterSeconds ? { retryAfter: error.retryAfterSeconds } : {}),
        };
      }
    };
  const text = (value: unknown, max = 1024): string => String(value ?? '').slice(0, max);

  app.get('/api/owner/status', async (req) => ({ success: true, data: service.status(req.cookies?.[OWNER_COOKIE]) }));

  app.post(
    '/api/owner/login',
    handle(async (req, reply, body) => {
      const result = await service.login(
        text(body.username, 64),
        text(body.password),
        req.ip,
        req.cookies?.[DEVICE_COOKIE]
      );
      if (result.session) setSession(req, reply, result.session);
      return { next: result.next, challenge: result.challenge };
    })
  );

  app.post(
    '/api/owner/login/second-factor',
    handle(async (req, reply, body) => {
      const result = await service.secondFactor(
        text(body.challenge, 128),
        {
          code: body.code === undefined ? undefined : text(body.code, 16),
          recoveryCode: body.recoveryCode === undefined ? undefined : text(body.recoveryCode, 32),
          remember: body.remember === true,
          label: text(body.label, 80),
        },
        req.ip
      );
      if (result.session) setSession(req, reply, result.session);
      if (result.device) setDevice(req, reply, result.device);
      return { next: result.next };
    })
  );

  app.post(
    '/api/owner/password',
    handle(async (req, reply, body) => {
      const session = await service.changePassword(
        req.cookies?.[OWNER_COOKIE],
        {
          current: text(body.current),
          next: text(body.next, 2048),
          code: body.code === undefined ? undefined : text(body.code, 16),
          deviceCookie: req.cookies?.[DEVICE_COOKIE],
        },
        req.ip
      );
      setSession(req, reply, session);
      return { changed: true };
    })
  );

  app.post(
    '/api/owner/logout',
    handle(async (req, reply) => {
      service.logout(req.cookies?.[OWNER_COOKIE]);
      clear(reply);
      return { signedOut: true };
    })
  );

  app.post(
    '/api/owner/logout-everywhere',
    handle(async (req, reply) => {
      owner(req);
      await service.logoutEverywhere(req.ip);
      clear(reply, true);
      return { signedOut: true };
    })
  );

  app.post(
    '/api/owner/2fa/start',
    handle(async (req, _reply, body) => {
      owner(req);
      const { secret, url } = await service.startTotp(
        req.cookies?.[OWNER_COOKIE],
        body.code === undefined ? undefined : text(body.code, 16),
        req.ip
      );
      const QRCode = await import('qrcode');
      const qr: string = await QRCode.toString(url, { type: 'svg', margin: 2, width: 220 });
      return { secret, url, qr };
    })
  );

  app.post(
    '/api/owner/2fa/confirm',
    handle(async (req, _reply, body) => {
      owner(req);
      return { recoveryCodes: await service.confirmTotp(req.cookies?.[OWNER_COOKIE], text(body.code, 16), req.ip) };
    })
  );

  app.post(
    '/api/owner/2fa/disable',
    handle(async (req, _reply, body) => {
      owner(req);
      await service.disableTotp(req.cookies?.[OWNER_COOKIE], text(body.password), text(body.code, 16), req.ip);
      return { twoFactor: false };
    })
  );

  app.post(
    '/api/owner/recovery-codes',
    handle(async (req, _reply, body) => {
      owner(req);
      return {
        recoveryCodes: await service.newRecoveryCodes(req.cookies?.[OWNER_COOKIE], text(body.code, 16), req.ip),
      };
    })
  );

  app.get(
    '/api/owner/devices',
    handle(async (req) => {
      owner(req);
      return { devices: service.devices() };
    })
  );

  app.delete(
    '/api/owner/devices/:id',
    handle(async (req) => {
      owner(req);
      const revoked = await service.revokeDevice(text((req.params as { id: string }).id, 64), req.ip);
      if (!revoked) throw new OwnerAuthError('No such device', 404);
      return { revoked: true };
    })
  );

  const page = (html: string) => async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
  app.get('/owner/login', page(LOGIN_PAGE));
  app.get('/owner/account', page(ACCOUNT_PAGE));
  app.get('/owner/owner.js', async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').type('text/javascript; charset=utf-8').send(OWNER_SCRIPT)
  );
}
