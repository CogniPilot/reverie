/** Persistent, capability-authenticated Embassy room on the existing console service. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { EmbassyChannelCall, EmbassyChannelTransport } from './embassy-host.js';
import { EmbassyPairError } from './embassy-pair-key.js';
import { parseEmbassyGuestKey } from './embassy-guest-client.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const uuid = z.string().uuid();
const label = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !/[\p{Cc}\u2028\u2029]/u.test(s));
const code = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);
const states = z.enum(['pending', 'approved', 'claimed', 'rejected', 'expired', 'revoked']);
const Request = z
  .object({
    id: uuid,
    inviteId: uuid,
    claimHash: token,
    code,
    company: label,
    identity: label,
    state: states,
    expiresAt: z.number(),
    claimExpiresAt: z.number().nullable(),
    sessionExpiresAt: z.number().nullable(),
    sessionHash: token.nullable(),
    claims: z.number().int().min(0).max(10),
  })
  .strict();
const Invite = z
  .object({
    id: uuid,
    idemKey: uuid,
    tokenHash: token,
    expiresAt: z.number(),
    revoked: z.boolean(),
    requestId: uuid.nullable(),
  })
  .strict();
const Post = z
  .object({
    ackId: uuid,
    sequence: z.number().int().positive(),
    at: z.number(),
    text: z.string().min(1).max(4096),
    requestId: uuid.optional(),
    author: z
      .object({ kind: z.enum(['host', 'guest']), company: label, identity: label, requestId: uuid.optional() })
      .strict(),
  })
  .strict();
const State = z
  .object({
    v: z.literal(1),
    roomId: uuid,
    origin: z.string().nullable(),
    company: label,
    /** The owner's name for the room (James 10-23: rename); absent means the default. */
    name: label.optional(),
    invites: z.array(Invite).max(1000),
    requests: z.array(Request).max(1000),
    posts: z.array(Post).max(2000),
  })
  .strict();
type Store = z.infer<typeof State>;
type Pair = z.infer<typeof Request>;
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const secret = () => randomBytes(32).toString('base64url');
const fail = (status: number, reason: string, message = reason): never => {
  throw new EmbassyPairError(status, reason, message);
};
const INVITE_TTL = 10 * 60_000,
  SESSION_TTL = 24 * 3600_000;
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function embassyAdvertisedOrigin(value: unknown): string {
  if (typeof value !== 'string')
    return fail(400, 'INVALID_ORIGIN', 'Enter the HTTPS address other companies use to reach this Reverie app');
  try {
    return parseEmbassyGuestKey(`embassy-v1|${value.trim()}|${'A'.repeat(43)}`).origin;
  } catch {
    return fail(
      400,
      'INVALID_ORIGIN',
      'Use a canonical HTTPS address with a DNS hostname, without a path, credentials, query or fragment'
    );
  }
}

export class BuiltinEmbassy {
  private chain: Promise<unknown> = Promise.resolve();
  private channelHash = '';
  private buckets = new Map<string, { at: number; count: number }>();
  constructor(
    private readonly deps: {
      file: string;
      channelFile: string;
      secretFile: string;
      origin?: string;
      now?: () => number;
    }
  ) {}
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private async read(): Promise<Store> {
    const handle = await fs.open(this.deps.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error('Invalid state');
      return State.parse(JSON.parse(await handle.readFile('utf8')));
    } finally {
      await handle.close();
    }
  }
  private async write(state: Store) {
    const path = `${this.deps.file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(path, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(State.parse(state)));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(path, this.deps.file);
      const parent = await fs.open(dirname(this.deps.file), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(path, { force: true });
    }
  }
  private run<T>(fn: (state: Store) => Promise<T> | T): Promise<T> {
    const work = this.chain.then(async () => {
      const state = await this.read();
      const result = await fn(state);
      await this.write(state);
      return result;
    });
    this.chain = work.catch(() => {});
    return work;
  }
  async init(): Promise<void> {
    const channelSecret = (await fs.readFile(this.deps.secretFile, 'utf8')).trim();
    if (!token.safeParse(channelSecret).success) throw new Error('Invalid Embassy channel identity');
    this.channelHash = hash(channelSecret);
    await fs.mkdir(dirname(this.deps.file), { recursive: true, mode: 0o700 });
    await fs.chmod(dirname(this.deps.file), 0o700);
    let initial: Store;
    try {
      initial = await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Built-in Embassy state is unreadable; refusing to reset its identity');
      initial = {
        v: 1,
        roomId: randomUUID(),
        origin: this.deps.origin ? embassyAdvertisedOrigin(this.deps.origin) : null,
        company: 'Company',
        invites: [],
        requests: [],
        posts: [],
      };
      try {
        const handle = await fs.open(this.deps.file, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(initial));
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        initial = await this.read();
      }
    }
    await fs.chmod(this.deps.file, 0o600);
    if (initial.origin) embassyAdvertisedOrigin(initial.origin);
    const binding = { v: 1, roomId: initial.roomId };
    try {
      const h = await fs.open(this.deps.channelFile, 'wx', 0o600);
      try {
        await h.writeFile(JSON.stringify(binding));
        await h.sync();
      } finally {
        await h.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const old = JSON.parse(await fs.readFile(this.deps.channelFile, 'utf8'));
      if (old.v !== 1 || old.roomId !== initial.roomId)
        throw new Error('Embassy channel binding disagrees with its persisted identity');
    }
  }
  async settings() {
    const s = await this.read();
    return { builtin: true, origin: s.origin, needsAdvertisedOrigin: !s.origin, roomId: s.roomId };
  }
  async configure(value: unknown) {
    const origin = embassyAdvertisedOrigin(value);
    await this.run((s) => {
      if (s.origin && s.origin !== origin) {
        for (const invite of s.invites) invite.revoked = true;
        for (const request of s.requests) {
          request.state = 'revoked';
          request.sessionHash = null;
        }
      }
      s.origin = origin;
    });
    return this.settings();
  }
  /** A bounded in-memory abuse budget; capability checks remain mandatory even after a restart. */
  checkRate(ip: string, action: string): void {
    const at = this.now();
    for (const [key, value] of this.buckets) if (at - value.at >= 60_000) this.buckets.delete(key);
    const key = ip + ':' + action;
    const prior = this.buckets.get(key);
    if (!prior && this.buckets.size >= 1000) fail(429, 'RATE_LIMITED');
    const bucket = prior ?? { at, count: 0 };
    bucket.count++;
    this.buckets.set(key, bucket);
    if (bucket.count > (action === 'request' ? 20 : 120)) fail(429, 'RATE_LIMITED');
  }
  private requireOrigin(s: Store) {
    if (!s.origin)
      fail(
        409,
        'ADVERTISED_ORIGIN_REQUIRED',
        'Embassy is ready locally. Set its shareable HTTPS address before inviting another company.'
      );
    return s.origin!;
  }
  private state(q: Pair): Pair['state'] {
    const deadline =
      q.state === 'claimed' ? q.sessionExpiresAt : q.state === 'approved' ? q.claimExpiresAt : q.expiresAt;
    if (['pending', 'approved', 'claimed'].includes(q.state) && deadline !== null && deadline <= this.now()) {
      q.state = 'expired';
      q.sessionHash = null;
    }
    return q.state;
  }
  private inviteView(s: Store, invite: z.infer<typeof Invite>) {
    const q = s.requests.find((q) => q.id === invite.requestId);
    return {
      id: invite.id,
      roomId: s.roomId,
      expiresAt: invite.expiresAt,
      revoked: invite.revoked,
      requestId: invite.requestId,
      requestState: q ? this.state(q) : null,
      guest: q ? { company: q.company, identity: q.identity } : null,
    };
  }
  private async mutateChannel(call: EmbassyChannelCall) {
    if (!equal(hash(call.bearer), this.channelHash)) fail(401, 'CHANNEL_AUTH');
    return this.run((s) => {
      const prefix = `/embassy/channel/rooms/${s.roomId}`;
      if (!call.path.startsWith(prefix) || !['', '/', '?'].includes(call.path.charAt(prefix.length)))
        fail(404, 'NOT_FOUND');
      const path = call.path.slice(prefix.length);
      const room = { id: s.roomId, name: s.name ?? 'Company Embassy' };
      if (call.method === 'GET' && path === '') return { room, origin: s.origin ?? '' };
      if (call.method === 'POST' && path === '/name') {
        s.name = z.object({ name: label }).strict().parse(call.body).name;
        return { room: { id: s.roomId, name: s.name } };
      }
      // Closing ends every guest's access at once: all invites and pairings are revoked (their sessions stop working)
      // and the room says so in a last host post. A new invite can reopen it later.
      if (call.method === 'POST' && path === '/close') {
        let revoked = 0;
        for (const invite of s.invites) if (!invite.revoked) { invite.revoked = true; revoked++; }
        for (const q of s.requests) {
          if (q.state !== 'revoked') revoked++;
          q.state = 'revoked';
          q.sessionHash = null;
        }
        // The notice always posts, and revocation above never depends on it: a room already at the post quota makes room
        // by dropping its oldest post. Sequences keep increasing, so a guest reading from its cursor still sees the notice.
        if (s.posts.length >= 2000) s.posts.shift();
        this.post(s, { kind: 'host', company: s.company, identity: 'Host' }, 'The host closed this embassy. Guest access has ended.');
        return { closed: true, revoked };
      }
      if (call.method === 'POST' && path === '/invites') {
        const origin = this.requireOrigin(s);
        const { idemKey } = z.object({ idemKey: uuid }).strict().parse(call.body);
        const old = s.invites.find((i) => i.idemKey === idemKey);
        if (old) return { invite: this.inviteView(s, old), key: null, replayed: true };
        if (s.invites.length >= 1000) fail(409, 'INVITE_LIMIT');
        const raw = secret();
        const invite = {
          id: randomUUID(),
          idemKey,
          tokenHash: hash(raw),
          expiresAt: this.now() + INVITE_TTL,
          revoked: false,
          requestId: null,
        };
        s.invites.push(invite);
        return { invite: this.inviteView(s, invite), key: `embassy-v2|${origin}|${s.roomId}|${raw}`, replayed: false };
      }
      if (call.method === 'GET' && path === '/invites') return { invites: s.invites.map((i) => this.inviteView(s, i)) };
      const revoke = /^\/invites\/([0-9a-f-]+)$/.exec(path);
      if (call.method === 'DELETE' && revoke) {
        const invite = s.invites.find((i) => i.id === revoke[1]);
        if (!invite) fail(404, 'NOT_FOUND');
        invite!.revoked = true;
        for (const q of s.requests.filter((q) => q.inviteId === invite!.id)) {
          q.state = 'revoked';
          q.sessionHash = null;
        }
        return { revoked: true };
      }
      if (call.method === 'POST' && path === '/pair/lookup') {
        const input = z.object({ code, requestId: uuid.optional() }).strict().parse(call.body);
        const q = s.requests.find((q) => q.code === input.code && (!input.requestId || q.id === input.requestId));
        if (!q) fail(404, 'PAIR_NOT_FOUND');
        return {
          requestId: q!.id,
          state: this.state(q!),
          company: q!.company,
          identity: q!.identity,
          expiresAt: q!.expiresAt,
        };
      }
      const decision = /^\/pair\/([0-9a-f-]+)\/(approve|reject)$/.exec(path);
      if (call.method === 'POST' && decision) {
        const input = z.object({ code }).strict().parse(call.body);
        const q = s.requests.find((q) => q.id === decision[1] && q.code === input.code);
        if (!q) fail(404, 'PAIR_NOT_FOUND');
        if (this.state(q!) === 'pending') {
          q!.state = decision[2] === 'approve' ? 'approved' : 'rejected';
          q!.claimExpiresAt = decision[2] === 'approve' ? this.now() + INVITE_TTL : null;
        } else if (
          (decision[2] === 'reject' && q!.state !== 'rejected') ||
          (decision[2] === 'approve' && !['approved', 'claimed'].includes(q!.state))
        )
          fail(409, 'PAIR_STATE');
        return { state: q!.state, claimExpiresAt: q!.claimExpiresAt };
      }
      if (call.method === 'GET' && path.startsWith('/posts?after='))
        return { posts: this.page(s, path.slice('/posts?after='.length)) };
      if (call.method === 'POST' && path === '/posts') {
        const body = z
          .object({ text: z.string().trim().min(1).max(4096), requestId: uuid.optional() })
          .strict()
          .parse(call.body);
        return {
          post: this.post(s, { kind: 'host', company: s.company, identity: 'Host' }, body.text, body.requestId),
        };
      }
      return fail(404, 'NOT_FOUND');
    });
  }
  channelTransport: EmbassyChannelTransport = async (call) => {
    try {
      return { status: 200, body: await this.mutateChannel(call) };
    } catch (error) {
      if (error instanceof EmbassyPairError) return { status: error.status, body: { error: { code: error.code } } };
      if (error instanceof z.ZodError) return { status: 400, body: { error: { code: 'INVALID_INPUT' } } };
      throw new Error('Built-in Embassy channel could not save its state');
    }
  };
  private page(s: Store, value: unknown) {
    const raw = value ?? '0';
    if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) fail(400, 'INVALID_CURSOR');
    return s.posts
      .filter((p) => p.sequence > Number(raw))
      .slice(0, 200)
      .map(({ requestId, ...p }) => p);
  }
  private post(s: Store, author: z.infer<typeof Post>['author'], text: string, requestId?: string) {
    if (requestId) {
      const prior = s.posts.find(
        (p) => p.requestId === requestId && p.author.kind === author.kind && p.author.requestId === author.requestId
      );
      if (prior) {
        if (prior.text !== text) fail(409, 'REQUEST_CONFLICT');
        return prior;
      }
    }
    if (s.posts.length >= 2000) fail(409, 'POST_LIMIT');
    const post = { ackId: randomUUID(), sequence: (s.posts.at(-1)?.sequence ?? 0) + 1, at: this.now(), text, author, requestId };
    s.posts.push(post);
    return post;
  }
  async pair(action: 'request' | 'status' | 'claim' | 'cancel', body: unknown, origin?: string) {
    return this.run((s) => {
      this.requireOrigin(s);
      if (origin && origin !== s.origin) fail(403, 'ORIGIN_REFUSED');
      if (action === 'request') {
        const input = z
          .object({ token, roomId: uuid, claimHash: token, company: label, identity: label })
          .strict()
          .parse(body);
        const invite = s.invites.find((i) => equal(i.tokenHash, hash(input.token)) && input.roomId === s.roomId);
        if (!invite || invite.revoked || invite.expiresAt <= this.now()) fail(401, 'INVALID_INVITE');
        let q = s.requests.find((q) => q.id === invite!.requestId);
        if (q && !equal(q.claimHash, input.claimHash)) fail(401, 'INVALID_INVITE');
        if (!q) {
          if (s.requests.length >= 1000) fail(409, 'PAIR_LIMIT');
          if (
            input.identity.toLowerCase() === 'host' ||
            s.requests.some(
              (q) =>
                ['pending', 'approved', 'claimed'].includes(this.state(q)) &&
                q.company === input.company &&
                q.identity === input.identity
            )
          )
            fail(409, 'GUEST_LABEL');
          let freshCode: string;
          do {
            freshCode = [...randomBytes(8)].map((b) => alphabet[b % 32]).join('');
          } while (s.requests.some((q) => q.code === freshCode));
          q = {
            id: randomUUID(),
            inviteId: invite!.id,
            claimHash: input.claimHash,
            code: freshCode,
            company: input.company,
            identity: input.identity,
            state: 'pending',
            expiresAt: this.now() + INVITE_TTL,
            claimExpiresAt: null,
            sessionExpiresAt: null,
            sessionHash: null,
            claims: 0,
          };
          s.requests.push(q);
          invite!.requestId = q.id;
        }
        return {
          requestId: q.id,
          code: q.code,
          state: this.state(q),
          roomId: s.roomId,
          roomName: 'Company Embassy',
          hostCompany: s.company,
          expiresAt: q.expiresAt,
        };
      }
      const input = z.object({ requestId: uuid, claimSecret: token }).strict().parse(body);
      const q = s.requests.find((q) => q.id === input.requestId && equal(q.claimHash, hash(input.claimSecret)));
      if (!q) fail(404, 'PAIR_NOT_FOUND');
      const state = this.state(q!);
      if (action === 'status')
        return { state, roomId: s.roomId, expiresAt: q!.expiresAt, claimExpiresAt: q!.claimExpiresAt };
      if (action === 'cancel') {
        if (['pending', 'approved', 'claimed'].includes(state)) q!.state = 'revoked';
        q!.sessionHash = null;
        return { state: q!.state };
      }
      if (state === 'pending') fail(409, 'PAIR_PENDING');
      if (!['approved', 'claimed'].includes(state)) fail(410, 'PAIR_' + state.toUpperCase());
      if (q!.claims >= 10) fail(429, 'CLAIM_LIMIT');
      const sessionToken = secret();
      q!.sessionHash = hash(sessionToken);
      q!.state = 'claimed';
      q!.claims++;
      // Reclaims rotate the token without extending its already-approved access lifetime.
      q!.sessionExpiresAt ??= this.now() + SESSION_TTL;
      return {
        sessionToken,
        hostCompany: s.company,
        room: { id: s.roomId, name: 'Company Embassy' },
        guest: { company: q!.company, identity: q!.identity },
        expiresAt: q!.sessionExpiresAt,
      };
    });
  }
  async guestPosts(roomId: string, session: unknown, after: unknown, body?: unknown, origin?: string) {
    return this.run((s) => {
      if (roomId !== s.roomId || typeof session !== 'string' || !token.safeParse(session).success)
        fail(401, 'INVALID_GUEST');
      const q = s.requests.find(
        (q) => q.sessionHash && equal(q.sessionHash, hash(session as string)) && this.state(q) === 'claimed'
      );
      if (!q) fail(401, 'INVALID_GUEST');
      if (origin && origin !== s.origin) fail(403, 'ORIGIN_REFUSED');
      if (body !== undefined) {
        if (origin !== s.origin) fail(403, 'ORIGIN_REFUSED');
        const input = z
          .object({ text: z.string().trim().min(1).max(4096), requestId: uuid })
          .strict()
          .parse(body);
        return {
          post: this.post(
            s,
            { kind: 'guest', company: q!.company, identity: q!.identity, requestId: q!.id },
            input.text,
            input.requestId
          ),
        };
      }
      return { posts: this.page(s, after) };
    });
  }
}
