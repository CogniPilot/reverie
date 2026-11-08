import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ownerFor, parseBody } from '../route-helpers.js';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { EmbassyGuestError } from '../../embassy-guest-client.js';
import { EmbassyPairError } from '../../embassy-pair-key.js';
import {
  EmbassyHostDecisionSchema,
  EmbassyHostInviteSchema,
  EmbassyHostLookupSchema,
  EmbassyHostCloseSchema,
  EmbassyHostPostSchema,
  EmbassyHostRenameSchema,
  type EmbassyHost,
} from '../../embassy-host.js';
import { EmbassyPairingCreateSchema, type EmbassyPairing } from '../../embassy-pairing.js';
import { isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { AvatarError, MAX_AVATAR_BYTES } from '../../agent-avatars.js';
import type { EmbassyGuestAvatars } from '../../embassy-guest-avatars.js';
import { isMultiUserMode } from '../../config/multiuser.js';

/** Fixed, non-secret CSRF marker (integration pins r1 §1). A cross-origin page cannot send it: CORS never allows it. */
export const EMBASSY_CSRF_HEADER = 'x-reverie-csrf';

/** Two-scan pairing routes (pairing contract r2 §4): hosting through the embassy channel, and pairing as a guest.
 * Like the embassy guest routes, every route needs a signed-in full owner session and refuses any agent session
 * header (403 OWNER_ONLY); the global host guard adds the same-origin/CSRF check on writes. No response carries the
 * channel secret, a claim secret, an invite token (except QR1 in `qr`) or a session token, and request logging is
 * off so a scanned QR never reaches a log line. Errors carry the contract code in `errorCode`. */
export function registerEmbassyPairingRoutes(
  app: FastifyInstance,
  host: EmbassyHost,
  pairing: EmbassyPairing,
  verifiedOwner: OwnerVerifier,
  getPolicy: () => HostPolicy,
  guestAvatars?: EmbassyGuestAvatars
): void {
  app.addHook('onRoute', (options) => {
    if (options.url.startsWith('/api/embassy-host') || options.url.startsWith('/api/embassy-pairing'))
      options.logLevel = 'silent';
  });
  const refuse = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.code(status).send({ success: false, error: message, errorCode: code });
  const handle =
    (fn: (req: FastifyRequest) => unknown) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      if (req.headers['x-reverie-parent-session'] !== undefined)
        return refuse(reply, 403, 'OWNER_ONLY', 'Embassy pairing requires a signed-in owner');
      // Every method, GET included: the marker, and an Origin that is absent or allowed. `null` is refused even
      // where the global guard would accept a web-tab capability.
      const origin = req.headers.origin;
      if (
        req.headers[EMBASSY_CSRF_HEADER] !== '1' ||
        origin === 'null' ||
        (origin !== undefined && !isAllowedRequestOrigin(origin, getPolicy()))
      )
        return refuse(reply, 403, 'CSRF_REFUSED', 'Embassy pairing requires a same-origin console request');
      if (!verifiedOwner(req)) return refuse(reply, 403, 'OWNER_ONLY', 'Embassy pairing requires a signed-in owner');
      try {
        return { success: true, data: await fn(req) };
      } catch (error) {
        if (error instanceof EmbassyPairError) return refuse(reply, error.status, error.code, error.message);
        if (error instanceof AvatarError) return refuse(reply, error.status, 'INVALID_IMAGE', error.message);
        if (error instanceof EmbassyGuestError) {
          const status = { INVALID_INPUT: 400, NOT_FOUND: 404, CONFLICT: 409, UPSTREAM: 502 }[error.code];
          return refuse(reply, status, error.code === 'UPSTREAM' ? 'EMBASSY_UNREACHABLE' : error.code, error.message);
        }
        // Validation and I/O errors never echo the request body (it may hold QR1).
        return reply
          .code(400)
          .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Embassy request refused; check the input'));
      }
    };
  const param = (req: FastifyRequest, name: string): string => String((req.params as Record<string, string>)[name]);
  const after = (req: FastifyRequest): number => {
    const raw = (req.query as { after?: unknown }).after ?? '0';
    if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) throw new EmbassyPairError(400, 'INVALID_INPUT', 'Invalid cursor');
    return Number(raw);
  };

  // ---------- host side ----------
  app.get(
    '/api/embassy-host',
    handle(() => host.status())
  );
  app.post(
    '/api/embassy-host/invites',
    handle((req) => host.createInvite(parseBody(EmbassyHostInviteSchema, req.body).clientRequestId))
  );
  app.get(
    '/api/embassy-host/invites',
    handle(() => host.listInvites())
  );
  app.delete(
    '/api/embassy-host/invites/:inviteId',
    handle((req) => host.revokeInvite(param(req, 'inviteId')))
  );
  app.post(
    '/api/embassy-host/lookup',
    handle((req) => host.lookup(parseBody(EmbassyHostLookupSchema, req.body)))
  );
  app.post(
    '/api/embassy-host/approve',
    handle((req) => {
      const body = parseBody(EmbassyHostDecisionSchema, req.body);
      return host.decide('approve', body.requestId, body.code);
    })
  );
  app.post(
    '/api/embassy-host/reject',
    handle((req) => {
      const body = parseBody(EmbassyHostDecisionSchema, req.body);
      return host.decide('reject', body.requestId, body.code);
    })
  );
  app.get(
    '/api/embassy-host/posts',
    handle((req) => host.posts(after(req)))
  );
  app.post(
    '/api/embassy-host/posts',
    handle((req) => host.post(parseBody(EmbassyHostPostSchema, req.body)))
  );
  app.post(
    '/api/embassy-host/rename',
    handle((req) => host.rename(parseBody(EmbassyHostRenameSchema, req.body)))
  );
  app.post(
    '/api/embassy-host/close',
    handle((req) => {
      parseBody(EmbassyHostCloseSchema, req.body);
      return host.close();
    })
  );

  // ---------- guest pictures (host side) ----------
  // The owner's picture for an approved or connected guest of the hosted room, shown in the host's own console. Set
  // and remove go through the same owner/CSRF guard as every host route; single-owner mode only.
  if (guestAvatars) {
    const singleOwner = () => {
      if (isMultiUserMode())
        throw new EmbassyPairError(403, 'OWNER_ONLY', 'Guest pictures are not available in multi-user mode');
    };
    void app.register(async (scope) => {
      scope.addContentTypeParser(
        ['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'],
        { parseAs: 'buffer', bodyLimit: MAX_AVATAR_BYTES + 1024 },
        (_req, body, done) => done(null, body)
      );
      scope.put(
        '/api/embassy-host/guests/:requestId/avatar',
        handle(async (req) => {
          singleOwner();
          const requestId = param(req, 'requestId');
          await host.requireGuest(requestId);
          return { url: await guestAvatars.set(requestId, req.body) };
        })
      );
    });
    app.delete(
      '/api/embassy-host/guests/:requestId/avatar',
      handle(async (req) => {
        singleOwner();
        return { removed: await guestAvatars.remove(param(req, 'requestId')) };
      })
    );
    // An <img> cannot send the CSRF marker, so this read checks the rest of the guard itself: a signed-in owner, no
    // agent session, an absent or allowed Origin. The picture is served like an agent's, and never to another site.
    app.get('/api/embassy-host/guests/:requestId/avatar', async (req, reply) => {
      const origin = req.headers.origin;
      if (
        req.headers['x-reverie-parent-session'] !== undefined ||
        isMultiUserMode() ||
        origin === 'null' ||
        (origin !== undefined && !isAllowedRequestOrigin(origin, getPolicy())) ||
        !verifiedOwner(req)
      )
        return refuse(reply, 403, 'OWNER_ONLY', 'Guest pictures are for the signed-in owner');
      const stored = await guestAvatars.get(param(req, 'requestId'));
      if (!stored) return refuse(reply, 404, 'NOT_FOUND', 'No picture for this guest');
      return reply
        .header('Content-Type', stored.type)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Cache-Control', 'private, max-age=86400')
        .send(stored.data);
    });
  }

  // ---------- guest side ----------
  app.post(
    '/api/embassy-pairing',
    handle((req) => pairing.create(ownerFor(req), parseBody(EmbassyPairingCreateSchema, req.body)))
  );
  app.get(
    '/api/embassy-pairing',
    handle((req) => pairing.list(ownerFor(req)))
  );
  app.get(
    '/api/embassy-pairing/:handle',
    handle((req) => pairing.get(ownerFor(req), param(req, 'handle')))
  );
  app.post(
    '/api/embassy-pairing/:handle/reconnect',
    handle((req) => pairing.reconnect(ownerFor(req), param(req, 'handle')))
  );
  app.delete(
    '/api/embassy-pairing/:handle',
    handle((req) => pairing.cancel(ownerFor(req), param(req, 'handle')))
  );
}
