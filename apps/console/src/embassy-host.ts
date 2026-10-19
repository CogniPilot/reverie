import fs from 'node:fs/promises';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivate } from './embassy-guest-client.js';
import { EmbassyPairError, formatPairCode, normalizePairCode, parsePairRequest } from './embassy-pair-key.js';

/**
 * Embassy hosting through the channel (pairing contract r2 §1, §4 host side). The console backend holds the channel
 * secret S and talks to the embassy's channel listener on host loopback 127.0.0.1:8472 only, with `Bearer S` and no
 * Origin. The channel reaches exactly one room: issue, list and revoke pair invites, look up, approve and reject pair
 * requests, and read and post as the host.
 *
 * S never leaves this module: no route returns it, no QR or log carries it, and errors name only the route and status.
 * Its digest goes to `channel.sha256` for the r13 host step, which writes the embassy's channel.json. The host step
 * also writes this side's `channel.json` ({v:1, roomId}); without it hosting reports `unconfigured`.
 */

export const EMBASSY_CHANNEL_PORT = 8472;
export const EMBASSY_CHANNEL_TIMEOUT_MS = 10_000;
export const EMBASSY_CHANNEL_RESPONSE_BYTES = 1024 * 1024;
export const EMBASSY_HOST_OPS_MAX = 1000;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- transport ----------

export interface EmbassyChannelCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  bearer: string;
}
export type EmbassyChannelTransport = (call: EmbassyChannelCall) => Promise<{ status: number; body: unknown }>;

/** Plain HTTP to host loopback only: a loopback Host header, no Origin, no keep-alive, no redirects, one deadline
 * and a 1 MiB answer cap. */
export function createEmbassyChannelHttp(
  port = EMBASSY_CHANNEL_PORT,
  timeoutMs = EMBASSY_CHANNEL_TIMEOUT_MS
): EmbassyChannelTransport {
  return (call) =>
    new Promise((resolve, reject) => {
      const payload = call.body === undefined ? undefined : Buffer.from(JSON.stringify(call.body));
      const headers: Record<string, string> = {
        host: `127.0.0.1:${port}`,
        accept: 'application/json',
        authorization: `Bearer ${call.bearer}`,
      };
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(payload.length);
      }
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        req.destroy();
        reject(new Error('Embassy channel unreachable'));
      };
      const deadline = setTimeout(fail, timeoutMs);
      const req = http.request(
        { host: '127.0.0.1', port, path: call.path, method: call.method, headers, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > EMBASSY_CHANNEL_RESPONSE_BYTES) return fail();
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try {
              body = text ? JSON.parse(text) : undefined;
            } catch {
              body = undefined;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
          res.on('error', fail);
        }
      );
      req.on('error', fail);
      req.end(payload);
    });
}

// ---------- wire schemas ----------

const State = z.enum(['pending', 'approved', 'claimed', 'rejected', 'expired', 'revoked']);
const label = z.string().max(120);
const Invite = z.object({
  id: z.string().regex(ID),
  roomId: z.string(),
  expiresAt: z.number().int(),
  revoked: z.boolean(),
  requestId: z.string().nullable(),
  requestState: State.nullable(),
  guest: z.object({ company: label, identity: label }).nullable(),
});
const Issued = z.object({ invite: Invite, key: z.string().max(512).nullable(), replayed: z.boolean() });
const Room = z.object({ room: z.object({ id: z.string(), name: label }).passthrough(), origin: z.string().max(300) });
const Lookup = z.object({
  requestId: z.string().regex(UUID),
  state: State,
  company: label,
  identity: label,
  expiresAt: z.number().int(),
});
const Decided = z.object({ state: State, claimExpiresAt: z.number().int().nullable() });

export const EmbassyHostInviteSchema = z.object({ clientRequestId: z.string().uuid() }).strict();
export const EmbassyHostLookupSchema = z.union([
  z.object({ qr: z.string().max(512) }).strict(),
  z.object({ code: z.string().max(16) }).strict(),
]);
export const EmbassyHostDecisionSchema = z
  .object({ requestId: z.string().regex(UUID), code: z.string().max(16) })
  .strict();
export const EmbassyHostPostSchema = z
  .object({ text: z.string().min(1).max(4096), requestId: z.string().uuid().optional() })
  .strict();

export type EmbassyHostInviteState =
  | 'open'
  | 'pending'
  | 'approved'
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'rejected';

/** The console's honest state for one pair invite: `connected` is the embassy's `claimed`; an invite with no
 * request is open, expired or revoked. */
export function embassyHostInviteState(invite: z.infer<typeof Invite>, now: number): EmbassyHostInviteState {
  if (invite.requestState) return invite.requestState === 'claimed' ? 'connected' : invite.requestState;
  if (invite.revoked) return 'revoked';
  return invite.expiresAt <= now ? 'expired' : 'open';
}

interface Ops {
  v: 1;
  ops: Record<string, { idemKey: string; inviteId?: string }>;
}

export interface EmbassyHostDeps {
  /** `<console data>/embassy-channel`: secret (0600), channel.sha256, and the host step's channel.json. */
  dir: string;
  /** `<console data>/embassy-host/ops.json`. */
  opsFile: string;
  transport?: EmbassyChannelTransport;
  now?: () => number;
}

export class EmbassyHost {
  private secret?: string;
  private origin?: string;
  private digest?: string;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly transport: EmbassyChannelTransport;

  constructor(private readonly deps: EmbassyHostDeps) {
    this.transport = deps.transport ?? createEmbassyChannelHttp();
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }

  /** Creates S on first use (32 random bytes, 0600 in a 0700 dir) and writes its sha256 for the host step. An
   * existing secret is kept; a malformed one is refused rather than replaced (rotation is a deliberate owner step). */
  async init(): Promise<void> {
    const file = join(this.deps.dir, 'secret');
    await fs.mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.deps.dir, 0o700);
    let secret: string;
    try {
      secret = (await fs.readFile(file, 'utf8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the embassy channel secret');
      secret = randomBytes(32).toString('base64url');
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        try {
          await handle.writeFile(secret);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        secret = (await fs.readFile(file, 'utf8')).trim();
      }
    }
    if (!SECRET.test(secret)) throw new Error('Embassy channel secret is malformed; refusing to replace it');
    await fs.chmod(file, 0o600);
    const digest = createHash('sha256').update(secret).digest('hex');
    const digestFile = join(this.deps.dir, 'channel.sha256');
    const prior = await fs.readFile(digestFile, 'utf8').catch(() => '');
    if (prior.trim() !== digest) {
      // Plain hex text, not JSON: the host step copies it verbatim into the embassy's channel.json.
      const temp = `${digestFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, `${digest}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, digestFile);
    }
    this.secret = secret;
    this.digest = digest;
  }

  private async roomId(): Promise<string> {
    let raw: string;
    try {
      raw = await fs.readFile(join(this.deps.dir, 'channel.json'), 'utf8');
    } catch {
      throw new EmbassyPairError(503, 'HOSTING_UNCONFIGURED', 'Embassy hosting is not set up on this host');
    }
    const parsed = z
      .object({ v: z.literal(1), roomId: z.string().regex(ID) })
      .strict()
      .safeParse((() => {
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      })());
    if (!parsed.success || !this.secret)
      throw new EmbassyPairError(503, 'HOSTING_UNCONFIGURED', 'Embassy hosting is not set up on this host');
    return parsed.data.roomId;
  }

  /** One channel call. A transport failure is EMBASSY_UNREACHABLE; a channel auth refusal means the host step and
   * this secret disagree, so it reads as unconfigured. The embassy's own codes pass through with their status. */
  private async call(method: EmbassyChannelCall['method'], path: string, body?: unknown) {
    const room = await this.roomId();
    let res: { status: number; body: unknown };
    try {
      res = await this.transport({ method, path: `/embassy/channel/rooms/${room}${path}`, body, bearer: this.secret! });
    } catch {
      throw new EmbassyPairError(502, 'EMBASSY_UNREACHABLE', 'The embassy did not answer');
    }
    if (res.status >= 200 && res.status < 300) return res;
    const error = (res.body as { error?: { code?: unknown } } | undefined)?.error;
    const code = typeof error?.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : undefined;
    if (code?.startsWith('CHANNEL_') || res.status === 421)
      throw new EmbassyPairError(503, 'HOSTING_UNCONFIGURED', 'The embassy refused this host channel');
    if (!code || res.status >= 500 || res.status < 400)
      throw new EmbassyPairError(502, 'EMBASSY_UNREACHABLE', `The embassy answered ${res.status}`);
    throw new EmbassyPairError(res.status, code, `The embassy refused: ${code}`);
  }

  private parsed<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new EmbassyPairError(502, 'EMBASSY_UNREACHABLE', 'The embassy answer was malformed');
    return result.data;
  }

  /** Fails closed: anything but a well-formed room answer is unconfigured or unreachable. */
  async status(): Promise<{
    status: 'ready' | 'unconfigured' | 'unreachable';
    origin?: string;
    room?: { id: string; name: string };
    bindingId?: string;
  }> {
    try {
      const res = await this.call('GET', '');
      const { room, origin } = this.parsed(Room, res.body);
      this.origin = origin;
      // A cache fence for the UI, never authorization: it changes whenever S, the origin or the room changes.
      const bindingId = createHash('sha256')
        .update(`reverie-embassy-binding-v1\n${this.digest}\n${origin}\n${room.id}`)
        .digest('hex')
        .slice(0, 32);
      return { status: 'ready', origin, room: { id: room.id, name: room.name }, bindingId };
    } catch (error) {
      if (error instanceof EmbassyPairError && error.code === 'HOSTING_UNCONFIGURED') return { status: 'unconfigured' };
      return { status: 'unreachable' };
    }
  }

  private async loadOps(): Promise<Ops> {
    try {
      const ops = JSON.parse(await fs.readFile(this.deps.opsFile, 'utf8')) as Ops;
      if (ops.v !== 1 || typeof ops.ops !== 'object' || ops.ops === null) throw new Error('version');
      return ops;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, ops: {} };
      throw new Error('Cannot load embassy host operations; refusing to reset them');
    }
  }

  /** PC-K2: the idemKey is on disk before the channel call, so any retry of this clientRequestId (a lost answer, a
   * console restart) reconciles to the same invite. Nothing is auto-revoked or replaced, and at the cap a new
   * operation is refused, never made room for. */
  async createInvite(clientRequestId: string) {
    const idemKey = await this.locked(async () => {
      const ops = await this.loadOps();
      const known = ops.ops[clientRequestId];
      if (known) return known.idemKey;
      if (Object.keys(ops.ops).length >= EMBASSY_HOST_OPS_MAX)
        throw new EmbassyPairError(409, 'INVITE_LIMIT', 'Too many invite operations are recorded on this host');
      ops.ops[clientRequestId] = { idemKey: randomUUID() };
      await writePrivate(this.deps.opsFile, ops);
      return ops.ops[clientRequestId].idemKey;
    });
    const res = await this.call('POST', '/invites', { idemKey });
    const { invite, key } = this.parsed(Issued, res.body);
    await this.locked(async () => {
      const ops = await this.loadOps();
      const entry = ops.ops[clientRequestId];
      if (entry && entry.inviteId !== invite.id) {
        entry.inviteId = invite.id;
        await writePrivate(this.deps.opsFile, ops);
      }
    });
    return {
      inviteId: invite.id,
      qr: key,
      qrAvailable: key !== null,
      expiresAt: invite.expiresAt,
      state: embassyHostInviteState(invite, this.now()),
    };
  }

  async listInvites() {
    const res = await this.call('GET', '/invites');
    const { invites } = this.parsed(z.object({ invites: z.array(Invite).max(1000) }), res.body);
    const now = this.now();
    return invites.map((invite) => ({
      inviteId: invite.id,
      expiresAt: invite.expiresAt,
      state: embassyHostInviteState(invite, now),
      ...(invite.guest ? { guest: invite.guest } : {}),
    }));
  }

  async revokeInvite(inviteId: string): Promise<{ revoked: true }> {
    if (!ID.test(inviteId)) throw new EmbassyPairError(404, 'NOT_FOUND', 'Invite not found');
    await this.call('DELETE', `/invites/${inviteId}`);
    return { revoked: true };
  }

  /** A scanned request QR must name this host's own origin; a typed code needs no origin. */
  async lookup(input: { qr: string } | { code: string }) {
    let body: { code: string; requestId?: string };
    if ('qr' in input) {
      const request = parsePairRequest(input.qr);
      if (!this.origin) await this.status();
      if (!this.origin) throw new EmbassyPairError(502, 'EMBASSY_UNREACHABLE', 'The embassy did not answer');
      if (request.origin !== this.origin)
        throw new EmbassyPairError(400, 'PAIR_WRONG_HOST', 'This request is for a different embassy host');
      body = { code: request.code, requestId: request.requestId };
    } else {
      body = { code: normalizePairCode(input.code) };
    }
    const res = await this.call('POST', '/pair/lookup', body);
    const found = this.parsed(Lookup, res.body);
    return {
      requestId: found.requestId,
      state: found.state === 'claimed' ? ('connected' as const) : found.state,
      guest: { company: found.company, identity: found.identity },
      expiresAt: found.expiresAt,
      code: formatPairCode(body.code),
    };
  }

  async decide(decision: 'approve' | 'reject', requestId: string, code: string) {
    const res = await this.call('POST', `/pair/${requestId}/${decision}`, { code: normalizePairCode(code) });
    const decided = this.parsed(Decided, res.body);
    return {
      state: decided.state === 'claimed' ? ('connected' as const) : decided.state,
      claimExpiresAt: decided.claimExpiresAt,
    };
  }

  async posts(after: number) {
    const res = await this.call('GET', `/posts?after=${after}`);
    return this.parsed(z.object({ posts: z.array(z.unknown()).max(1000) }), res.body);
  }

  async post(input: z.infer<typeof EmbassyHostPostSchema>) {
    const res = await this.call('POST', '/posts', input);
    return this.parsed(z.object({ post: z.unknown() }), res.body);
  }
}
