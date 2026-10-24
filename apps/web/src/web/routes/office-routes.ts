/** Human-only account management and a bounded channel surface for limited logins. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ChatroomService } from '../../chatroom-service.js';
import type { ChatRoom } from '../../chatroom-store.js';
import { OfficeAuthService } from '../../owner-auth/office.js';
import { OwnerAuthError } from '../../owner-auth/service.js';
import { OWNER_COOKIE, sameOrigin } from '../../owner-auth/policy.js';

const Rooms = z.array(z.string().min(1).max(100)).max(50);
const Avatar = z.string().regex(/^\/assets\/avatars\/pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png$/);
const Create = z
  .object({
    username: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/),
    name: z.string().trim().min(1).max(80),
    role: z.enum(['owner', 'limited']).default('limited'),
    rooms: Rooms.default([]),
  })
  .strict();
const Update = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(['owner', 'limited']).optional(),
    rooms: Rooms.optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
const Profile = z.object({ name: z.string().trim().min(1).max(80), avatar: Avatar.nullable() }).strict();

export function registerOfficeRoutes(app: FastifyInstance, auth: OfficeAuthService, chat: ChatroomService): void {
  const token = (req: FastifyRequest) => req.cookies?.[OWNER_COOKIE];
  const person = (req: FastifyRequest, owner = false) => {
    const identity = auth.identity(token(req)),
      session = auth.session(token(req));
    if (!identity || !session) throw new OwnerAuthError('Sign in first', 401);
    if (session.restricted) throw new OwnerAuthError('Change the one-time password first', 403);
    if (req.headers['x-reverie-parent-session'] !== undefined || req.headers['x-reverie-service-token'] !== undefined)
      throw new OwnerAuthError('Use your human login', 403);
    if (owner && identity.role !== 'owner') throw new OwnerAuthError('Only an owner manages human accounts', 403);
    if ((req.method !== 'GET' && !sameOrigin(req)) || req.headers['sec-fetch-site'] === 'cross-site')
      throw new OwnerAuthError('Requests must come from this console', 403);
    return identity;
  };
  const room = (req: FastifyRequest, id: string): ChatRoom => {
    const identity = person(req),
      found = chat.room(id);
    if (!found || !auth.canRead(identity, found)) throw new OwnerAuthError('No such channel', 404);
    return found;
  };
  const validateRooms = (ids: string[]) => {
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => {
        const r = chat.room(id);
        return !r || r.kind === 'dm' || !!r.archivedAt || r.owner !== undefined;
      })
    )
      throw new OwnerAuthError('Choose current ordinary channels in this office', 400);
  };
  const handle =
    (work: (req: FastifyRequest) => unknown | Promise<unknown>) =>
    async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        return { success: true, data: await work(req) };
      } catch (error) {
        if (error instanceof OwnerAuthError)
          return reply.code(error.status).send({ success: false, error: error.message });
        if (error instanceof z.ZodError)
          return reply.code(400).send({ success: false, error: 'Invalid account or message fields' });
        throw error;
      }
    };
  app.get(
    '/api/office/me',
    handle((req) => ({ person: person(req) }))
  );
  app.put(
    '/api/office/me',
    handle(async (req) => {
      const self = person(req),
        body = Profile.parse(req.body);
      if (self.primary) throw new OwnerAuthError('Edit the primary owner profile from the chat profile button', 409);
      return { person: await auth.update(self.id, { name: body.name, avatar: body.avatar ?? undefined }) };
    })
  );
  app.post(
    '/api/office/presence',
    handle((req) => {
      person(req);
      auth.heartbeat(token(req)!);
      return { present: true };
    })
  );
  app.get(
    '/api/office/presence',
    handle((req) => {
      const self = person(req),
        id = (req.query as { roomId?: string }).roomId;
      const found = id ? chat.room(id) : undefined;
      if (!found || (self.role === 'limited' && !auth.canRead(self, found)))
        throw new OwnerAuthError('No such channel', 404);
      return { people: auth.members(found) };
    })
  );
  app.get(
    '/api/office/accounts',
    handle((req) => {
      const self = person(req, true);
      return {
        self,
        people: auth.list(),
        rooms: chat
          .rooms()
          .filter((r) => r.kind !== 'dm' && !r.archivedAt && r.owner === undefined)
          .map((r) => ({ id: r.id, name: r.name })),
      };
    })
  );
  app.post(
    '/api/office/accounts',
    handle(async (req) => {
      const self = person(req, true),
        input = Create.parse(req.body);
      validateRooms(input.rooms);
      const result = await auth.create(input, self.id);
      await auth.audit('office_account_created', {
        actor: self.id,
        person: result.person.id,
        role: result.person.role,
      });
      return result;
    })
  );
  app.put(
    '/api/office/accounts/:id',
    handle(async (req) => {
      const self = person(req, true),
        patch = Update.parse(req.body),
        id = (req.params as { id: string }).id;
      if (!Object.keys(patch).length) throw new OwnerAuthError('Choose a change', 400);
      if (patch.rooms) validateRooms(patch.rooms);
      const changed = await auth.update(id, patch);
      await auth.audit('office_account_updated', { actor: self.id, person: id, fields: Object.keys(patch) });
      return { person: changed };
    })
  );
  app.post(
    '/api/office/accounts/:id/reset-password',
    handle(async (req) => {
      const self = person(req, true),
        id = (req.params as { id: string }).id;
      const result = await auth.reset(id, self.id);
      await auth.audit('office_account_reset', { actor: self.id, person: id });
      return result;
    })
  );
  app.get(
    '/api/office/rooms',
    handle((req) => {
      const self = person(req);
      return {
        rooms: chat
          .rooms()
          .filter((r) => auth.canRead(self, r))
          .map((r) => ({ id: r.id, name: r.name, topic: r.topic || '' })),
      };
    })
  );
  app.get(
    '/api/office/rooms/:id',
    handle((req) => {
      const found = room(req, (req.params as { id: string }).id);
      // No goals, memories, pending prompts, delivery state, file paths/attachments or user read cursors.
      return {
        room: { id: found.id, name: found.name, topic: found.topic || '' },
        people: auth.members(found),
        agents: found.members.map((m) => ({ name: chat.nameOf(m.sessionId) })),
        messages: found.messages.slice(-200).map((m) => ({
          id: m.id,
          at: m.at,
          text: m.deleted ? '' : m.text,
          deleted: !!m.deleted,
          from: {
            kind: m.from.kind,
            name: m.from.name,
            ...(m.from.kind === 'human'
              ? { humanId: m.from.humanId, access: m.from.access }
              : m.from.kind === 'user'
                ? { humanId: m.from.humanId }
                : {}),
          },
        })),
      };
    })
  );
  const posts = new Map<string, { at: number; count: number }>();
  app.post(
    '/api/office/rooms/:id/messages',
    handle((req) => {
      const self = person(req),
        found = room(req, (req.params as { id: string }).id);
      const body = z
        .object({ text: z.string().trim().min(1).max(8000) })
        .strict()
        .parse(req.body);
      const now = Date.now(),
        bucket = posts.get(self.id);
      for (const [id, value] of posts) if (now - value.at > 60_000) posts.delete(id);
      if (bucket && now - bucket.at < 60_000 && bucket.count >= 30)
        throw new OwnerAuthError('Please wait before posting again', 429);
      posts.set(
        self.id,
        bucket && now - bucket.at < 60_000 ? { at: bucket.at, count: bucket.count + 1 } : { at: now, count: 1 }
      );
      const from =
        self.role === 'limited'
          ? { kind: 'human' as const, name: self.name, humanId: self.id, access: 'limited' as const }
          : { kind: 'user' as const, name: self.name, humanId: self.id, mark: 'owner_typed' as const };
      const message = chat.post(found.id, from, body.text);
      return { message: { id: message.id } };
    })
  );
  for (const [path, file, type] of [
    ['/people', 'people.html', 'text/html'],
    ['/people.js', 'people.js', 'application/javascript'],
    ['/office', 'office.html', 'text/html'],
    ['/office.js', 'office.js', 'application/javascript'],
    ['/office.css', 'office.css', 'text/css'],
  ])
    app.get(path, async (req, reply) => {
      try {
        const self = person(req, path.startsWith('/people'));
        if (self.role === 'owner' && path === '/office') return reply.redirect('/');
        return reply
          .header('Cache-Control', 'no-store')
          .type(type + '; charset=utf-8')
          .send(await readFile(new URL('../public/' + file, import.meta.url), 'utf8'));
      } catch (error) {
        if (error instanceof OwnerAuthError)
          return reply.code(error.status).send({ success: false, error: error.message });
        throw error;
      }
    });
}
