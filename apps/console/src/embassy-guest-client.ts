import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Embassy guest client (overnight slice, 2026-10-19). The console joins a hosted embassy room as an ordinary guest,
 * with one invite key, through the embassy's existing guest API only: POST /api/embassy/join, then the session
 * cookie on GET/POST /embassy/rooms/:id/posts. It holds no owner power and opens no listener; every call is outbound.
 *
 * Imported posts live only in this module's own files. They never enter the chatroom store or delivery path, so
 * they cannot wake an agent, fire an @mention, start a task or reach a private room. The session secret is kept in
 * a 0600 file in a 0700 directory and is never returned by any route or written to a log.
 */

export const EMBASSY_GUEST_KEY_MAX = 512;
export const EMBASSY_GUEST_MAX_CONNECTIONS = 8;
export const EMBASSY_GUEST_MAX_POSTS = 2000;
export const EMBASSY_GUEST_TEXT_BYTES = 4096;
export const EMBASSY_GUEST_RESPONSE_BYTES = 1024 * 1024;
export const EMBASSY_GUEST_TIMEOUT_MS = 15_000;
export const EMBASSY_GUEST_POLL_MS = 5000;
export const EMBASSY_GUEST_UNREACHABLE_MS = 45_000;
const PAGE = 100;
const PAGES_PER_TICK = 5;
const COOKIE = 'embassy_guest';
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export type EmbassyGuestStatus =
  | 'connecting'
  | 'live'
  | 'unreachable'
  | 'expired'
  | 'refused'
  | 'storage-full'
  | 'disabled'
  | 'left';

export class EmbassyGuestError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'UPSTREAM',
    message: string
  ) {
    super(message);
  }
}

// ---------- invite key (the P27 string, same constraints as the embassy's own parser) ----------

export function parseEmbassyGuestKey(key: unknown): { origin: string; token: string } {
  const bad = () => new EmbassyGuestError('INVALID_INPUT', 'Invalid embassy invite key');
  if (typeof key !== 'string') throw bad();
  key = key.trim();
  if (
    typeof key !== 'string' ||
    key.length > EMBASSY_GUEST_KEY_MAX ||
    Buffer.byteLength(key) > EMBASSY_GUEST_KEY_MAX
  )
    throw bad();
  const parts = (key as string).split('|');
  if (parts.length !== 3 || parts[0] !== 'embassy-v1' || !SECRET.test(parts[2])) throw bad();
  let address: URL;
  try {
    address = new URL(parts[1]);
  } catch {
    throw bad();
  }
  if (
    address.protocol !== 'https:' ||
    address.origin !== parts[1] ||
    address.username ||
    address.password ||
    address.pathname !== '/' ||
    address.search ||
    address.hash
  )
    throw bad();
  const host = address.hostname;
  if (
    host.length > 253 ||
    !host.includes('.') ||
    /^[0-9.]+$/.test(host) ||
    !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw bad();
  return { origin: address.origin, token: parts[2] };
}

// ---------- destination policy ----------

// Separate lists per family: a BlockList also matches IPv4 input against an IPv6 ::ffff:0:0/96 rule.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked4.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked6.addSubnet(prefix, bits, 'ipv6');
const tailnet4 = new net.BlockList();
tailnet4.addSubnet('100.64.0.0', 10, 'ipv4');
const tailnet6 = new net.BlockList();
tailnet6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/** Public unicast, or a tailnet peer address (100.64/10, fd7a:115c:a1e0::/48). Loopback, private, link-local,
 * metadata, multicast and mapped forms are refused. */
export function embassyGuestAddressAllowed(address: string): boolean {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 4) return tailnet4.check(address, 'ipv4') || !blocked4.check(address, 'ipv4');
  return tailnet6.check(address, 'ipv6') || !blocked6.check(address, 'ipv6');
}

// ---------- transport ----------

export interface EmbassyGuestRequest {
  origin: string;
  method: 'GET' | 'POST';
  path: string;
  cookie?: string;
  body?: unknown;
  /** Aborted when the channel is disabled, left or stopped; a transport should drop the request at once. */
  signal?: AbortSignal;
}
export interface EmbassyGuestResponse {
  status: number;
  body: unknown;
}
export type EmbassyGuestTransport = (request: EmbassyGuestRequest) => Promise<EmbassyGuestResponse>;

class TransportFailure extends Error {}

export interface EmbassyGuestHttpsDeps {
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof https.request;
  timeoutMs?: number;
}

/** One bounded HTTPS request: verified TLS, a DNS answer checked against the destination policy and pinned for the
 * connection, no proxy, no redirects, no keep-alive, a 1 MiB response cap, and one deadline covering DNS, connect and
 * body. The deadline and the abort listener exist before DNS starts, and a DNS answer that arrives after the request
 * settled never opens a socket. The lookup and request hooks exist for tests. */
export function createEmbassyGuestHttps(deps: EmbassyGuestHttpsDeps = {}): EmbassyGuestTransport {
  const lookup = deps.lookup ?? ((host: string) => dns.lookup(host, { all: true, verbatim: true }));
  const open = deps.request ?? https.request;
  const timeoutMs = deps.timeoutMs ?? EMBASSY_GUEST_TIMEOUT_MS;
  return (request) =>
    new Promise<EmbassyGuestResponse>((resolve, reject) => {
      let settled = false;
      let req: ReturnType<typeof https.request> | undefined;
      const settle = (fn: () => void): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(deadline);
        request.signal?.removeEventListener('abort', cancel);
        fn();
        return true;
      };
      const fail = (message: string): void => {
        const error = new TransportFailure(message);
        if (settle(() => reject(error))) req?.destroy(error);
      };
      const cancel = (): void => fail('Embassy request cancelled');
      const deadline = setTimeout(() => fail('Embassy timed out'), timeoutMs);
      if (request.signal?.aborted) return cancel();
      request.signal?.addEventListener('abort', cancel, { once: true });

      const url = new URL(request.path, request.origin);
      if (url.origin !== request.origin) return fail('Embassy path escaped its origin');
      lookup(url.hostname).then(
        (answers) => {
          if (settled) return; // late DNS after cancel or deadline: no socket
          if (!answers.length || !answers.every((a) => embassyGuestAddressAllowed(a.address)))
            return fail('Embassy host resolves to a refused address');
          connect(url, answers[0]);
        },
        () => fail('Embassy host did not resolve')
      );

      function connect(url: URL, pinned: { address: string; family: number }): void {
        const payload = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body));
        const headers: Record<string, string> = { accept: 'application/json' };
        if (payload) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(payload.length);
        }
        // The embassy requires its own Origin on cookie-bearing writes (its CSRF rule); this client is that origin's guest.
        if (request.method === 'POST' && request.cookie) headers.origin = request.origin;
        if (request.cookie) headers.cookie = `${COOKIE}=${request.cookie}`;
        req = open(
          {
            protocol: 'https:',
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: request.method,
            headers,
            agent: false,
            servername: url.hostname,
            timeout: timeoutMs,
            lookup: (_host, options, callback) => {
              if ((options as { all?: boolean }).all)
                (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > EMBASSY_GUEST_RESPONSE_BYTES) return fail('Embassy response too large');
              chunks.push(chunk);
            });
            res.on('end', () => {
              const status = res.statusCode ?? 0;
              if (status >= 300 && status < 400) return fail('Embassy redirect refused');
              const text = Buffer.concat(chunks).toString('utf8');
              let body: unknown = undefined;
              try {
                body = text ? JSON.parse(text) : undefined;
              } catch {
                body = undefined;
              }
              settle(() => resolve({ status, body }));
            });
            res.on('error', () => fail('Embassy unreachable'));
          }
        );
        req.on('timeout', () => fail('Embassy timed out'));
        req.on('error', (error) => fail(error instanceof TransportFailure ? error.message : 'Embassy unreachable'));
        req.end(payload);
      }
    });
}

export const embassyGuestHttps: EmbassyGuestTransport = createEmbassyGuestHttps();

// ---------- wire schemas (only known fields are kept) ----------

const label = z.string().max(120);
const Author = z.object({
  kind: z.string().max(20).optional(),
  company: label,
  identity: label,
});
const Post = z.object({
  ackId: z.string().max(64),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: z.number().int().nonnegative(),
  text: z.string().max(EMBASSY_GUEST_TEXT_BYTES),
  trust: z.string().max(40).optional(),
  author: Author,
});
export type EmbassyGuestPost = z.infer<typeof Post>;
const Joined = z.object({
  sessionToken: z.string().regex(SECRET),
  hostCompany: label,
  room: z.object({ id: z.string().uuid(), name: label, closed: z.boolean().optional() }),
  guest: z.object({ company: label, identity: label }),
  expiresAt: z.number().int().positive(),
});
const Page = z.object({ posts: z.array(Post).max(PAGE) });
const Posted = z.object({ post: Post });

export const EmbassyGuestKeySchema = z.object({ key: z.string().max(EMBASSY_GUEST_KEY_MAX) }).strict();
export const EmbassyGuestJoinSchema = z
  .object({ key: z.string().max(EMBASSY_GUEST_KEY_MAX), confirmedOrigin: z.string().max(300) })
  .strict();
export const EmbassyGuestPostSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine((t) => Buffer.byteLength(t) <= EMBASSY_GUEST_TEXT_BYTES, 'Message is too long'),
    requestId: z.string().uuid(),
  })
  .strict();
export const EmbassyGuestEnabledSchema = z.object({ enabled: z.boolean() }).strict();

// ---------- state ----------

interface Connection {
  id: string;
  owner?: string;
  origin: string;
  roomId: string;
  roomName: string;
  hostCompany: string;
  guest: { company: string; identity: string };
  expiresAt: number;
  session?: string;
  enabled: boolean;
  status: EmbassyGuestStatus;
  createdAt: number;
  lastContactAt?: number;
  lastError?: string;
}
interface State {
  version: 1;
  connections: Connection[];
}
interface History {
  version: 1;
  cursor: number;
  posts: EmbassyGuestPost[];
}

export async function writePrivate(file: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

export interface EmbassyGuestDeps {
  /** State file (holds session secrets); history files go in `<file without .json>/`. */
  file: string;
  transport?: EmbassyGuestTransport;
  now?: () => number;
  /** Poll interval; tests shorten it to drive the real background poll. */
  pollMs?: number;
}

interface PollTicket {
  epoch: number;
  session: string;
  cursor: number;
  request: EmbassyGuestRequest;
}

export class EmbassyGuestClient {
  private state: State = { version: 1, connections: [] };
  private histories = new Map<string, History>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  /** Bumped on disable, enable, leave and stop. A response is committed only under the epoch it was requested in,
   * so a reply that was in flight when the channel was disabled is dropped, even if it lands after a re-enable. */
  private epochs = new Map<string, number>();
  private aborts = new Map<string, Set<AbortController>>();
  private polling = new Map<string, Promise<void>>();
  private joining = 0;
  private backoff = new Map<string, { until: number; delay: number }>();
  private readonly transport: EmbassyGuestTransport;
  private readonly dir: string;

  constructor(private readonly deps: EmbassyGuestDeps) {
    this.transport = deps.transport ?? embassyGuestHttps;
    this.dir = deps.file.replace(/\.json$/, '');
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  /** Serializes every state change, so a poll and a route never interleave writes. Network calls never run inside
   * it, so a Disable never waits behind a slow embassy. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }
  private historyFile(id: string): string {
    return join(this.dir, `${id}.json`);
  }
  private save(): Promise<void> {
    return writePrivate(this.deps.file, this.state);
  }

  async init(): Promise<void> {
    try {
      const state = JSON.parse(await fs.readFile(this.deps.file, 'utf8')) as State;
      if (state.version !== 1 || !Array.isArray(state.connections)) throw new Error('version');
      this.state = state;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Cannot load embassy guest state; refusing to reset it');
    }
    for (const c of this.state.connections) {
      try {
        const history = JSON.parse(await fs.readFile(this.historyFile(c.id), 'utf8')) as History;
        if (history.version !== 1 || !Array.isArray(history.posts) || !Number.isSafeInteger(history.cursor))
          throw new Error('version');
        this.histories.set(c.id, history);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('Cannot load embassy guest history; refusing to reset it');
        this.histories.set(c.id, { version: 1, cursor: 0, posts: [] });
      }
      // After a restart nothing is live until the embassy answers again.
      if (c.status === 'live' || c.status === 'unreachable') c.status = 'connecting';
    }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs ?? EMBASSY_GUEST_POLL_MS);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const c of this.state.connections) this.bump(c.id);
    await Promise.all([...this.polling.values()]);
    await this.chain;
  }

  private epoch(id: string): number {
    return this.epochs.get(id) ?? 0;
  }
  /** Invalidates and cancels everything in flight for one connection. */
  private bump(id: string): void {
    this.epochs.set(id, this.epoch(id) + 1);
    for (const controller of this.aborts.get(id) ?? []) controller.abort();
    this.aborts.delete(id);
  }
  /** One network call for one connection, cancelled by bump(). Never called inside run(). */
  private async send(id: string, request: EmbassyGuestRequest): Promise<EmbassyGuestResponse> {
    const controller = new AbortController();
    const set = this.aborts.get(id) ?? new Set<AbortController>();
    set.add(controller);
    this.aborts.set(id, set);
    try {
      return await this.transport({ ...request, signal: controller.signal });
    } finally {
      set.delete(controller);
    }
  }

  private view(c: Connection) {
    return {
      id: c.id,
      origin: c.origin,
      roomId: c.roomId,
      roomName: c.roomName,
      hostCompany: c.hostCompany,
      guest: c.guest,
      expiresAt: c.expiresAt,
      enabled: c.enabled,
      status: c.status,
      lastContactAt: c.lastContactAt,
      lastError: c.lastError,
      postCount: this.histories.get(c.id)?.posts.length ?? 0,
    };
  }
  private find(owner: string | undefined, id: string): Connection {
    const c = this.state.connections.find((x) => x.id === id && x.owner === owner);
    if (!c) throw new EmbassyGuestError('NOT_FOUND', 'Embassy room not found');
    return c;
  }

  list(owner: string | undefined) {
    return { connections: this.state.connections.filter((c) => c.owner === owner).map((c) => this.view(c)) };
  }
  preview(key: string) {
    return { origin: parseEmbassyGuestKey(key).origin };
  }

  async join(owner: string | undefined, key: string, confirmedOrigin: string) {
    const { origin, token } = parseEmbassyGuestKey(key);
    if (confirmedOrigin !== origin) throw new EmbassyGuestError('INVALID_INPUT', 'Confirm the embassy host first');
    await this.run(async () => {
      const active = this.state.connections.filter((c) => c.status !== 'left');
      if (active.length + this.joining >= EMBASSY_GUEST_MAX_CONNECTIONS)
        throw new EmbassyGuestError('CONFLICT', `At most ${EMBASSY_GUEST_MAX_CONNECTIONS} embassy rooms; leave one first`);
      this.joining++;
    });
    let res: EmbassyGuestResponse;
    try {
      res = await this.transport({ origin, method: 'POST', path: '/api/embassy/join', body: { token } });
    } catch {
      this.joining--;
      throw new EmbassyGuestError('UPSTREAM', 'Not confirmed: embassy unreachable; the key may or may not have been used');
    }
    return this.run(async () => {
      this.joining--;
      if (res.status === 401) throw new EmbassyGuestError('INVALID_INPUT', 'Invalid, used, expired or revoked key');
      if (res.status === 429) throw new EmbassyGuestError('UPSTREAM', 'Embassy is busy; try again in a minute');
      const joined = res.status === 200 ? Joined.safeParse(res.body) : undefined;
      if (!joined?.success) throw new EmbassyGuestError('UPSTREAM', `Embassy join failed (${res.status})`);
      const j = joined.data;
      const c: Connection = {
        id: randomUUID(),
        owner,
        origin,
        roomId: j.room.id.toLowerCase(),
        roomName: j.room.name,
        hostCompany: j.hostCompany,
        guest: { company: j.guest.company, identity: j.guest.identity },
        expiresAt: j.expiresAt,
        session: j.sessionToken,
        enabled: true,
        status: 'connecting',
        createdAt: this.now(),
      };
      const history: History = { version: 1, cursor: 0, posts: [] };
      await writePrivate(this.historyFile(c.id), history);
      this.histories.set(c.id, history);
      this.state.connections.push(c);
      await this.save();
      void this.pollSoon(c.id);
      return this.view(c);
    });
  }

  /** Two-scan pairing (contract r2 §4): stores a claimed session under the pairing's stable connectionId. An
   * idempotent upsert, so a repeated claim or a crash-and-retry never makes a second connection; the old session is
   * replaced and anything in flight for it is dropped. `roomId` is the pairing's own room (from QR1): a claim for
   * another room is refused, and a connection already bound to another origin or room is never rebound (CP-K3). */
  async adopt(owner: string | undefined, id: string, origin: string, roomId: string, claimed: unknown) {
    const parsed = Joined.safeParse(claimed);
    if (!parsed.success) throw new EmbassyGuestError('UPSTREAM', 'Embassy claim answer was malformed');
    const j = parsed.data;
    const room = roomId.toLowerCase();
    if (j.room.id.toLowerCase() !== room) throw new EmbassyGuestError('UPSTREAM', 'Embassy claim is for another room');
    return this.run(async () => {
      let c = this.state.connections.find((x) => x.id === id);
      if (c && c.owner !== owner) throw new EmbassyGuestError('CONFLICT', 'Embassy connection belongs to another owner');
      if (c?.roomId && (c.roomId !== room || c.origin !== origin))
        throw new EmbassyGuestError('CONFLICT', 'Embassy connection is bound to another room');
      // A retired binding never comes back: a late claim cannot reactivate a cancelled pairing's connection.
      if (c?.status === 'left') throw new EmbassyGuestError('CONFLICT', 'This embassy pairing was cancelled');
      if (!c) {
        const active = this.state.connections.filter((x) => x.status !== 'left');
        if (active.length + this.joining >= EMBASSY_GUEST_MAX_CONNECTIONS)
          throw new EmbassyGuestError('CONFLICT', `At most ${EMBASSY_GUEST_MAX_CONNECTIONS} embassy rooms; leave one first`);
        const history: History = { version: 1, cursor: 0, posts: [] };
        await writePrivate(this.historyFile(id), history);
        this.histories.set(id, history);
        c = {
          id,
          owner,
          origin,
          roomId: '',
          roomName: '',
          hostCompany: '',
          guest: { company: '', identity: '' },
          expiresAt: 0,
          enabled: true,
          status: 'connecting',
          createdAt: this.now(),
        };
        this.state.connections.push(c);
      }
      this.bump(id);
      Object.assign(c, {
        origin,
        roomId: j.room.id.toLowerCase(),
        roomName: j.room.name,
        hostCompany: j.hostCompany,
        guest: { company: j.guest.company, identity: j.guest.identity },
        expiresAt: j.expiresAt,
        session: j.sessionToken,
        enabled: true,
        status: 'connecting' as const,
        lastError: undefined,
      });
      this.backoff.delete(id);
      await this.save();
      void this.pollSoon(id);
      return this.view(c);
    });
  }

  /** The origin and room a pairing's connection is bound to, once a claim stored one. */
  binding(owner: string | undefined, id: string): { origin: string; roomId: string } | undefined {
    const c = this.state.connections.find((x) => x.id === id && x.owner === owner);
    return c?.roomId ? { origin: c.origin, roomId: c.roomId } : undefined;
  }

  /** Whether a pairing's connection holds a session that has not been refused yet (crash recovery, §4). */
  holds(owner: string | undefined, id: string): boolean {
    const c = this.state.connections.find((x) => x.id === id && x.owner === owner);
    // 'expired' is only ever set by a 401 or the access deadline, never by a timeout or 5xx, so a network failure
    // alone keeps a possibly valid session and never leads to a re-claim (Kit, r2 PASS note 3).
    return !!c?.session && c.status !== 'expired' && c.status !== 'left' && c.status !== 'refused' && c.expiresAt > this.now();
  }

  /** Ends a pairing's connection when the pairing is cancelled; a missing connection is already retired. */
  async retire(owner: string | undefined, id: string): Promise<void> {
    if (this.state.connections.some((x) => x.id === id && x.owner === owner)) await this.leave(owner, id);
  }

  posts(owner: string | undefined, id: string, after: number) {
    this.find(owner, id);
    const history = this.histories.get(id);
    const posts = (history?.posts ?? []).filter((p) => p.sequence > after).slice(0, 200);
    return { posts, next: posts.length ? posts[posts.length - 1].sequence : after };
  }

  async post(owner: string | undefined, id: string, input: { text: string; requestId: string }) {
    const ticket = await this.run(async () => {
      const c = this.find(owner, id);
      if (!c.enabled || !c.session) throw new EmbassyGuestError('CONFLICT', `Embassy room is ${c.status}`);
      if (c.expiresAt <= this.now()) {
        await this.mark(c, 'expired', 'Guest access expired; ask the host for a new key');
        throw new EmbassyGuestError('CONFLICT', 'Embassy room is expired');
      }
      return {
        epoch: this.epoch(id),
        request: {
          origin: c.origin,
          method: 'POST' as const,
          path: `/embassy/rooms/${c.roomId}/posts`,
          cookie: c.session,
          body: { text: input.text, requestId: input.requestId },
        },
      };
    });
    let res: EmbassyGuestResponse;
    try {
      res = await this.send(id, ticket.request);
    } catch {
      throw new EmbassyGuestError('UPSTREAM', 'Not confirmed: embassy unreachable or channel disabled. Retry sends the same message once.');
    }
    return this.run(async () => {
      const c = this.find(owner, id);
      const current = this.epoch(id) === ticket.epoch;
      if (res.status === 401) {
        if (current) await this.mark(c, 'expired', 'Guest access ended (expired or revoked by the host)');
        throw new EmbassyGuestError('CONFLICT', 'Guest access ended');
      }
      if (res.status === 429) throw new EmbassyGuestError('UPSTREAM', 'Posting too fast; wait a minute');
      const posted = res.status === 201 ? Posted.safeParse(res.body) : undefined;
      if (!posted?.success) throw new EmbassyGuestError('UPSTREAM', `Embassy refused the post (${res.status})`);
      if (current) void this.pollSoon(c.id);
      return { post: posted.data.post };
    });
  }

  setEnabled(owner: string | undefined, id: string, enabled: boolean) {
    return this.run(async () => {
      const c = this.find(owner, id);
      if (c.status === 'left') throw new EmbassyGuestError('CONFLICT', 'This embassy room was left; join again with a new key');
      this.bump(c.id);
      c.enabled = enabled;
      c.status = enabled ? (c.expiresAt <= this.now() ? 'expired' : 'connecting') : 'disabled';
      c.lastError = undefined;
      this.backoff.delete(c.id);
      await this.save();
      if (enabled) void this.pollSoon(c.id);
      return this.view(c);
    });
  }

  leave(owner: string | undefined, id: string) {
    return this.run(async () => {
      const c = this.find(owner, id);
      this.bump(c.id);
      c.session = undefined;
      c.enabled = false;
      c.status = 'left';
      await this.save();
      return this.view(c);
    });
  }

  private async mark(c: Connection, status: EmbassyGuestStatus, error?: string): Promise<void> {
    c.status = status;
    c.lastError = error;
    await this.save();
  }

  private pollSoon(id: string): Promise<void> {
    return this.pollConnection(id).catch(() => {});
  }

  /** One timer tick: every connection polls concurrently, at most one poll in flight per connection, so a slow or
   * held channel never stalls the others. */
  async tick(): Promise<void> {
    await Promise.all(this.state.connections.map((c) => this.pollSoon(c.id)));
  }

  private pollConnection(id: string): Promise<void> {
    const running = this.polling.get(id);
    if (running) return running;
    const task = (async () => {
      for (let page = 0; page < PAGES_PER_TICK; page++) {
        const ticket = await this.run(async () => this.pollTicket(id));
        if (!ticket) return;
        let res: EmbassyGuestResponse | undefined;
        try {
          res = await this.send(id, ticket.request);
        } catch {
          res = undefined;
        }
        const more = await this.run(async () => this.commitPage(id, ticket, res));
        if (!more) return;
      }
    })().finally(() => this.polling.delete(id));
    this.polling.set(id, task);
    return task;
  }

  private async pollTicket(id: string): Promise<PollTicket | undefined> {
    const c = this.state.connections.find((x) => x.id === id);
    if (!c || !c.enabled || !c.session) return undefined;
    if (c.status === 'expired' || c.status === 'refused' || c.status === 'storage-full') return undefined;
    const now = this.now();
    if (c.expiresAt <= now) {
      await this.mark(c, 'expired', 'Guest access expired; ask the host for a new key');
      return undefined;
    }
    const wait = this.backoff.get(c.id);
    if (wait && wait.until > now) return undefined;
    const cursor = this.histories.get(c.id)!.cursor;
    return {
      epoch: this.epoch(id),
      session: c.session,
      cursor,
      request: { origin: c.origin, method: 'GET', path: `/embassy/rooms/${c.roomId}/posts?after=${cursor}`, cookie: c.session },
    };
  }

  /** Commits one fetched page, or drops it if the channel was disabled, left or re-enabled meanwhile. Returns whether
   * another page should be fetched now. */
  private async commitPage(id: string, ticket: PollTicket, res: EmbassyGuestResponse | undefined): Promise<boolean> {
    const c = this.state.connections.find((x) => x.id === id);
    const history = this.histories.get(id);
    if (!c || !history || !c.enabled || c.session !== ticket.session) return false;
    if (this.epoch(id) !== ticket.epoch || history.cursor !== ticket.cursor) return false;
    if (!res) {
      await this.failed(c, 'Embassy unreachable');
      return false;
    }
    // A 401 means expired, revoked or closed. Stop at once: every refusal counts toward the embassy's lockout.
    if (res.status === 401) {
      await this.mark(c, 'expired', 'Guest access ended (expired or revoked by the host)');
      return false;
    }
    if (res.status === 429) {
      await this.failed(c, 'Embassy rate limit; backing off', 60_000);
      return false;
    }
    const parsed = res.status === 200 ? Page.safeParse(res.body) : undefined;
    if (!parsed?.success) {
      await this.failed(c, `Embassy answered ${res.status}`);
      return false;
    }
    const incoming = parsed.data.posts;
    let last = history.cursor;
    for (const p of incoming) {
      if (p.sequence <= last) {
        await this.mark(c, 'refused', 'Embassy sent posts out of order; import stopped (Enable retries)');
        return false;
      }
      last = p.sequence;
    }
    if (history.posts.length + incoming.length > EMBASSY_GUEST_MAX_POSTS) {
      await this.mark(c, 'storage-full', `Local copy is full (${EMBASSY_GUEST_MAX_POSTS} posts); import stopped`);
      return false;
    }
    if (incoming.length) {
      const next: History = { version: 1, cursor: last, posts: [...history.posts, ...incoming] };
      // Posts and cursor commit together; a crash before this write just refetches the same page.
      await writePrivate(this.historyFile(c.id), next);
      history.cursor = next.cursor;
      history.posts = next.posts;
    }
    this.backoff.delete(c.id);
    c.lastContactAt = this.now();
    if (c.status !== 'live' || c.lastError) {
      c.status = 'live';
      c.lastError = undefined;
      await this.save();
    }
    return incoming.length === PAGE;
  }

  private async failed(c: Connection, error: string, minDelay = 0): Promise<void> {
    const prior = this.backoff.get(c.id)?.delay ?? 0;
    const delay = Math.max(minDelay, Math.min(60_000, prior ? prior * 2 : EMBASSY_GUEST_POLL_MS));
    this.backoff.set(c.id, { until: this.now() + delay + Math.floor(Math.random() * 1000), delay });
    const since = c.lastContactAt ?? c.createdAt;
    const status = this.now() - since >= EMBASSY_GUEST_UNREACHABLE_MS ? 'unreachable' : c.status;
    if (status !== c.status || c.lastError !== error) await this.mark(c, status, error);
  }
}
