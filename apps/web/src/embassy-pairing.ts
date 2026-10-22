import fs from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  embassyGuestHttps,
  EmbassyGuestError,
  writePrivate,
  type EmbassyGuestClient,
  type EmbassyGuestResponse,
  type EmbassyGuestTransport,
} from './embassy-guest-client.js';
import { EmbassyPairError, encodePairRequest, formatPairCode, normalizePairCode, parsePairInvite } from './embassy-pair-key.js';

/**
 * Two-scan pairing, guest side (pairing contract r2 §4). The owner scans the host's QR1; this backend sends a pair
 * request with only the hash of a private claim secret, shows the request QR and code for the host to approve, then
 * claims the session and hands it to the embassy guest client under a stable connectionId.
 *
 * - PC-K1: the record, with the QR1 token, is on disk in state `creating` before any network call. The token is
 *   removed in the same write that stores the requestId. A restore re-sends the identical request, which the embassy
 *   answers with the same request and code; nothing ever builds a replacement request. Only a definite "no request"
 *   (401 INVALID_INVITE or 409 GUEST_LABEL on pair-request) or a room-checked request answer drops the token. Any
 *   other outcome keeps it (CP-K2), so cancel can still find and end a request whose ACK was lost.
 * - CP-K1: cancel retires locally at once (state `cancelling`, the connection retired, no session ever stored) and
 *   becomes `cancelled` only when the embassy confirmed that no live request remains. `cancelling` is durable and is
 *   driven again on every read and tick, across restarts.
 * - CP-K3: every claim answer must name the record's own room before anything is stored or polled.
 * - PC-K3: one lock per handle serializes create, poll, claim, cancel and reconnect. Cancel bumps the generation
 *   before it waits for the lock. Every operation (create, read, tick, reconnect) takes its fence, the generation, when
 *   it is asked for, before it queues for the lock, and carries that one fence through every network and disk wait up
 *   to the claim, the adoption and the connected save. An operation asked for before a cancel therefore never starts a
 *   claim, adopts or says connected once that cancel began; a claim already in flight has its session discarded unsaved.
 * - A connected pairing never claims again on a poll. Only the owner's explicit reconnect does, and only when the
 *   stored session was refused or is missing; a timeout or 5xx alone never rotates a possibly valid session.
 *
 * No view carries the token, the claim secret, the claim hash or a session token.
 */

export const EMBASSY_PAIRING_TICK_MS = 3000;
export const EMBASSY_PAIRING_MAX_RECORDS = 1000;
/** QR1 lives at most 60 minutes, so a request that never reached the embassy cannot succeed after this. */
export const EMBASSY_PAIRING_CREATE_WINDOW_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE = /^[0-9a-f]{32}$/;

export type EmbassyPairingState =
  | 'creating'
  | 'pending'
  | 'approved'
  | 'connected'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'cancelling'
  | 'cancelled'
  | 'failed';
const TERMINAL = new Set<EmbassyPairingState>(['rejected', 'expired', 'revoked', 'cancelled', 'failed']);
/** Locally retired: the console holds no session and will never store one again for this handle. */
const RETIRED = new Set<EmbassyPairingState>(['cancelling', 'cancelled']);

interface PairRecord {
  v: 1;
  handle: string;
  owner?: string;
  clientRequestId: string;
  generation: number;
  origin: string;
  roomId: string;
  /** Present only while it is the one thing that can recover the request (state `creating`). */
  token?: string;
  claimSecret: string;
  claimHash: string;
  company: string;
  identity: string;
  connectionId: string;
  state: EmbassyPairingState;
  requestId?: string;
  code?: string;
  roomName?: string;
  hostCompany?: string;
  expiresAt?: number;
  error?: string;
  /** Set on cancel (state `cancelling`) until the embassy confirmed that no live request remains. */
  cancelPending?: boolean;
  createdAt: number;
}

export const EmbassyPairingCreateSchema = z
  .object({
    qr: z.string().max(512),
    company: z.string().max(120).optional(),
    identity: z.string().max(80).optional(),
    clientRequestId: z.string().uuid(),
  })
  .strict();

const Requested = z.object({
  requestId: z.string().regex(UUID),
  code: z.string().max(16),
  state: z.enum(['pending', 'approved', 'claimed', 'rejected', 'expired', 'revoked']),
  roomId: z.string().max(128),
  roomName: z.string().max(120),
  hostCompany: z.string().max(120),
  expiresAt: z.number().int(),
});
/** pair-cancel's only success shape (r13 cancelPairing): the request's terminal state. */
const Cancelled = z.object({ state: z.enum(['revoked', 'rejected', 'expired']) });
/** The part of a claim answer checked against the record before the guest client sees it. */
const ClaimRoom = z.object({ room: z.object({ id: z.string() }) });
const Status = z.object({
  state: z.enum(['pending', 'approved', 'claimed', 'rejected', 'expired', 'revoked']),
  expiresAt: z.number().int(),
  claimExpiresAt: z.number().int().nullable(),
});
const ERROR_STATE: Record<string, EmbassyPairingState> = {
  PAIR_REJECTED: 'rejected',
  PAIR_EXPIRED: 'expired',
  PAIR_REVOKED: 'revoked',
};

export interface EmbassyPairingDeps {
  /** `<console data>/embassy-pairings`: one 0600 record per handle in a 0700 directory. */
  dir: string;
  guest: EmbassyGuestClient;
  transport?: EmbassyGuestTransport;
  now?: () => number;
  tickMs?: number;
  /** Labels used when the owner leaves company or identity empty. */
  defaults?: () => { company: string; identity: string };
}

const errorCode = (res: EmbassyGuestResponse): string | undefined => {
  const code = (res.body as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : undefined;
};
/** pair-request answers that prove the embassy holds no live request for this claim binding (r13 requestPairing):
 * INVALID_INVITE (unknown, revoked, expired unused, or used by another claimant; a revoked invite has revoked its
 * request) and GUEST_LABEL (refused before the invite is consumed). Nothing else is proof. */
const noRequest = (res: EmbassyGuestResponse): string | undefined => {
  const code = errorCode(res);
  if (res.status === 401 && code === 'INVALID_INVITE') return code;
  if (res.status === 409 && code === 'GUEST_LABEL') return code;
  return undefined;
};

export class EmbassyPairing {
  private records = new Map<string, PairRecord>();
  private locks = new Map<string, Promise<unknown>>();
  private admission: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly transport: EmbassyGuestTransport;

  constructor(private readonly deps: EmbassyPairingDeps) {
    this.transport = deps.transport ?? embassyGuestHttps;
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private file(handle: string): string {
    return join(this.deps.dir, `${handle}.json`);
  }
  private save(record: PairRecord): Promise<void> {
    return writePrivate(this.file(record.handle), record);
  }

  /** All work on one handle runs here, one at a time; the record is read fresh from the map after acquiring. */
  private withLock<T>(handle: string, fn: (record: PairRecord) => Promise<T>): Promise<T> {
    const prior = this.locks.get(handle) ?? Promise.resolve();
    const result = prior.then(() => {
      const record = this.records.get(handle);
      if (!record) throw new EmbassyGuestError('NOT_FOUND', 'Pairing not found');
      return fn(record);
    });
    const tail = result.catch(() => {});
    this.locks.set(handle, tail);
    void tail.then(() => {
      if (this.locks.get(handle) === tail) this.locks.delete(handle);
    });
    return result;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.deps.dir, 0o700);
    for (const name of await fs.readdir(this.deps.dir)) {
      const handle = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !HANDLE.test(handle)) continue;
      let record: PairRecord;
      try {
        record = JSON.parse(await fs.readFile(this.file(handle), 'utf8')) as PairRecord;
      } catch {
        throw new Error('Cannot load an embassy pairing record; refusing to reset it');
      }
      if (record.v !== 1 || record.handle !== handle) throw new Error('Embassy pairing record has an unknown version');
      // An r4 record said `cancelled` while its cancel was unconfirmed; that is `cancelling` now.
      if (record.state === 'cancelled' && record.cancelPending) record.state = 'cancelling';
      this.records.set(handle, record);
    }
    // Debt can be durable before guest retirement when the process stops between the two writes.
    // Retire locally before any guest poll or liaison callback can run; remote confirmation stays pending.
    for (const record of this.records.values()) {
      if (RETIRED.has(record.state)) await this.deps.guest.retire(record.owner, record.connectionId);
    }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? EMBASSY_PAIRING_TICK_MS);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.locks.values()]);
  }

  /** The answer to an operation asked for at generation `gen`. A cancel that began since is queued right behind it on
   * the lock (it bumped the generation, so the record was cancellable), so the answer is `cancelling`, never a
   * connection or request QR the cancel is about to end. */
  private answer(r: PairRecord, gen: number) {
    return r.generation !== gen ? this.view({ ...r, state: 'cancelling' }) : this.view(r);
  }

  private view(r: PairRecord) {
    return {
      handle: r.handle,
      state: r.state,
      origin: r.origin,
      room: { id: r.roomId, name: r.roomName ?? '' },
      hostCompany: r.hostCompany ?? '',
      guest: { company: r.company, identity: r.identity },
      ...(r.requestId && r.code && (r.state === 'pending' || r.state === 'approved')
        ? { requestQr: encodePairRequest(r.origin, r.requestId, r.code), code: formatPairCode(r.code) }
        : {}),
      expiresAt: r.expiresAt ?? null,
      ...(r.state === 'connected' ? { connectionId: r.connectionId } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }
  private find(owner: string | undefined, handle: string): PairRecord {
    const record = HANDLE.test(handle) ? this.records.get(handle) : undefined;
    if (!record || record.owner !== owner) throw new EmbassyGuestError('NOT_FOUND', 'Pairing not found');
    return record;
  }

  list(owner: string | undefined) {
    return {
      pairings: [...this.records.values()]
        .filter((r) => r.owner === owner)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => this.view(r)),
    };
  }

  /** Admission is serialized before a handle exists, so two racing sends of one clientRequestId share one handle
   * (Inspector, r2 PASS note 2). The record is durable, token included, before the first network call. */
  async create(owner: string | undefined, input: z.infer<typeof EmbassyPairingCreateSchema>) {
    const record = await this.admit(owner, input);
    const gen = record.generation;
    return this.withLock(record.handle, async (r) => {
      if (r.state === 'creating') await this.sendRequest(r, gen);
      return this.answer(r, gen);
    });
  }

  private admit(owner: string | undefined, input: z.infer<typeof EmbassyPairingCreateSchema>): Promise<PairRecord> {
    const work = this.admission.then(async () => {
      for (const r of this.records.values())
        if (r.owner === owner && r.clientRequestId === input.clientRequestId) return r;
      const { origin, roomId, token } = parsePairInvite(input.qr);
      if (this.records.size >= EMBASSY_PAIRING_MAX_RECORDS)
        throw new EmbassyPairError(409, 'INVITE_LIMIT', 'Too many pairings are recorded on this console');
      const defaults = this.deps.defaults?.() ?? { company: 'Reverie', identity: `Guest ${randomBytes(2).toString('hex')}` };
      const claimSecret = randomBytes(32).toString('base64url');
      const record: PairRecord = {
        v: 1,
        handle: randomBytes(16).toString('hex'),
        owner,
        clientRequestId: input.clientRequestId,
        generation: 1,
        origin,
        roomId,
        token,
        claimSecret,
        claimHash: createHash('sha256').update(claimSecret).digest('base64url'),
        company: input.company?.trim() || defaults.company,
        identity: input.identity?.trim() || defaults.identity,
        connectionId: randomUUID(),
        state: 'creating',
        createdAt: this.now(),
      };
      await this.save(record);
      this.records.set(record.handle, record);
      return record;
    });
    this.admission = work.catch(() => {});
    return work;
  }

  private async post(r: PairRecord, path: string, body: unknown): Promise<EmbassyGuestResponse | undefined> {
    try {
      return await this.transport({ origin: r.origin, method: 'POST', path, body });
    } catch {
      return undefined;
    }
  }

  /** `definite`: the embassy proved there is no request (noRequest), so the token goes. Otherwise the token stays:
   * it is the one thing that can still find, and cancel, a request whose ACK was lost (CP-K2). */
  /** The operation fence: a cancel began after this operation was asked for (generation `gen`). */
  private fenced(r: PairRecord, gen: number): boolean {
    return r.generation !== gen || RETIRED.has(r.state);
  }

  private async fail(r: PairRecord, code: string, definite = false): Promise<void> {
    r.state = 'failed';
    r.error = code;
    if (definite) delete r.token;
    await this.save(r);
  }

  /** Not confirmed either way: keep the token and retry, until QR1 cannot be alive any more. */
  private async unconfirmed(r: PairRecord): Promise<void> {
    if (this.now() - r.createdAt >= EMBASSY_PAIRING_CREATE_WINDOW_MS) return this.fail(r, 'EMBASSY_UNREACHABLE');
    if (r.error !== 'EMBASSY_UNREACHABLE') {
      r.error = 'EMBASSY_UNREACHABLE';
      await this.save(r);
    }
  }

  /** The identical pair-request; the embassy answers a repeat with the same request (lost-ACK recovery). */
  private requestAgain(r: PairRecord): Promise<EmbassyGuestResponse | undefined> {
    return this.post(r, '/api/embassy/pair-request', {
      token: r.token,
      roomId: r.roomId,
      claimHash: r.claimHash,
      company: r.company,
      identity: r.identity,
    });
  }

  /** Sends (or, on restore, re-sends) the identical pair-request. Under the handle lock. */
  private async sendRequest(r: PairRecord, gen: number): Promise<void> {
    if (!r.token) return this.fail(r, 'INVALID_INVITE', true);
    const res = await this.requestAgain(r);
    if (!res || res.status === 429 || res.status >= 500) return this.unconfirmed(r);
    if (res.status === 200 || res.status === 201) {
      const answer = Requested.safeParse(res.body);
      if (!answer.success) return this.unconfirmed(r); // malformed success proves nothing
      const a = answer.data;
      // A request for another room is not ours to commit; the token stays for cancel (CP-K2).
      if (a.roomId.toLowerCase() !== r.roomId.toLowerCase()) return this.fail(r, 'PAIR_ROOM_MISMATCH');
      let code: string;
      try {
        code = normalizePairCode(a.code);
      } catch {
        return this.unconfirmed(r);
      }
      // One write commits the request and drops the token. A recovered request keeps its real state (Inspector, r2 note 1).
      r.requestId = a.requestId;
      r.code = code;
      r.roomName = a.roomName;
      r.hostCompany = a.hostCompany;
      r.expiresAt = a.expiresAt;
      r.state = a.state === 'claimed' ? 'approved' : a.state;
      r.error = undefined;
      delete r.token;
      await this.save(r);
      // The committed request stays recorded for the cancel; a cancel begun since this operation was asked for stops
      // it here, before any claim (VERIFIER-PAIR-CANCEL-BARRIER).
      if (this.fenced(r, gen)) return;
      if (a.state === 'approved' || a.state === 'claimed') await this.afterStatus(r, a.state, gen);
      return;
    }
    const none = noRequest(res);
    if (none) return this.fail(r, none, true);
    // Any other answer (an uncorrelated 401, 408, 4xx) proves nothing about the request: fail, token kept (CP-K2).
    return this.fail(r, errorCode(res) ?? `HTTP_${res.status}`);
  }

  /** pending/approved: one pair-status call, then act on it. Under the handle lock. */
  private async poll(r: PairRecord, gen: number): Promise<void> {
    if (r.state === 'creating') return this.sendRequest(r, gen);
    if (r.state === 'cancelling') return this.sendCancel(r);
    if (r.state !== 'pending' && r.state !== 'approved') return;
    const res = await this.post(r, '/api/embassy/pair-status', { requestId: r.requestId, claimSecret: r.claimSecret });
    if (this.fenced(r, gen)) return; // a cancel began while the status was in flight: it, not this answer, decides
    if (!res || res.status === 429 || res.status >= 500) return; // try again next tick
    if (res.status === 404 && errorCode(res) === 'PAIR_NOT_FOUND') return this.fail(r, 'PAIR_NOT_FOUND');
    const status = res.status === 200 ? Status.safeParse(res.body) : undefined;
    if (!status?.success) return;
    const s = status.data;
    if (s.state === 'pending') {
      if (r.expiresAt !== s.expiresAt) {
        r.expiresAt = s.expiresAt;
        await this.save(r);
      }
      return;
    }
    if (s.state === 'rejected' || s.state === 'expired' || s.state === 'revoked') return this.terminal(r, s.state);
    await this.afterStatus(r, s.state, gen);
  }

  private async terminal(r: PairRecord, state: EmbassyPairingState): Promise<void> {
    r.state = state;
    await this.save(r);
    await this.deps.guest.retire(r.owner, r.connectionId).catch(() => {});
  }

  /** The embassy says approved or claimed. A claimed request whose session the store already holds (a crash after
   * the upsert, before this record said connected) is connected with no re-claim; otherwise claim once. */
  private async afterStatus(r: PairRecord, state: 'approved' | 'claimed', gen: number): Promise<void> {
    if (this.fenced(r, gen)) return;
    if (state === 'claimed' && this.deps.guest.holds(r.owner, r.connectionId)) {
      if (!this.boundHere(r)) {
        // Never activate a connection bound to another room or origin (CP-K3).
        await this.deps.guest.retire(r.owner, r.connectionId).catch(() => {});
        return this.fail(r, 'PAIR_ROOM_MISMATCH');
      }
      r.state = 'connected';
      r.error = undefined;
      await this.save(r);
      return;
    }
    if (r.state !== 'approved') {
      r.state = 'approved';
      await this.save(r);
      if (this.fenced(r, gen)) return; // a cancel began during the approval save: no claim
    }
    await this.claim(r, gen);
  }

  /** The pairing's connection, if the guest store has one, is bound to this record's origin and room. */
  private boundHere(r: PairRecord): boolean {
    const bound = this.deps.guest.binding(r.owner, r.connectionId);
    return !bound || (bound.origin === r.origin && bound.roomId === r.roomId.toLowerCase());
  }

  /** pair-claim, then the generation fence, then the room check, then the idempotent upsert, then connected. */
  private async claim(r: PairRecord, gen: number): Promise<void> {
    const fenced = () => this.fenced(r, gen);
    if (fenced()) return;
    const res = await this.post(r, '/api/embassy/pair-claim', { requestId: r.requestId, claimSecret: r.claimSecret });
    if (fenced()) {
      // Cancelled while the claim was in flight: the session is never stored, and the embassy hears the cancel.
      if (res?.status === 200) await this.sendCancel(r);
      return;
    }
    if (!res || res.status >= 500) return; // not confirmed: no state change, the next tick asks again
    if (res.status === 200) {
      // CP-K3: the answer must name this record's room (from QR1) before anything is stored or polled. A mismatch
      // keeps requestId, so cancel can still end the request; the session it carried is never stored.
      const room = ClaimRoom.safeParse(res.body);
      if (!room.success) return; // malformed answer: retry next tick (the next claim ends this session)
      if (room.data.room.id.toLowerCase() !== r.roomId.toLowerCase() || !this.boundHere(r))
        return this.fail(r, 'PAIR_ROOM_MISMATCH');
      try {
        await this.deps.guest.adopt(r.owner, r.connectionId, r.origin, r.roomId, res.body);
      } catch (error) {
        if (error instanceof EmbassyGuestError && error.code === 'CONFLICT') return this.fail(r, 'CONNECTION_LIMIT');
        return; // malformed answer: retry next tick (the next claim ends this session)
      }
      if (fenced()) {
        await this.deps.guest.retire(r.owner, r.connectionId).catch(() => {});
        return;
      }
      const expiresAt = (res.body as { expiresAt?: unknown }).expiresAt;
      r.state = 'connected';
      r.error = undefined;
      if (typeof expiresAt === 'number') r.expiresAt = expiresAt;
      await this.save(r);
      return;
    }
    const code = errorCode(res);
    if (res.status === 409 && code === 'PAIR_PENDING') {
      r.state = 'pending';
      return this.save(r);
    }
    if (code && ERROR_STATE[code]) return this.terminal(r, ERROR_STATE[code]);
    if (res.status === 429 && code === 'CLAIM_LIMIT') return this.fail(r, 'CLAIM_LIMIT');
    if (res.status === 429) return;
    return this.fail(r, code ?? `HTTP_${res.status}`);
  }

  /** The browser's poll: one status call while pending or approved; connected reads never claim. */
  get(owner: string | undefined, handle: string) {
    const record = this.find(owner, handle);
    const gen = record.generation;
    return this.withLock(record.handle, async (r) => {
      await this.poll(r, gen);
      return this.answer(r, gen);
    });
  }

  /** The owner's explicit reconnect for a connected pairing whose local session was refused or lost. */
  reconnect(owner: string | undefined, handle: string) {
    const record = this.find(owner, handle);
    const gen = record.generation;
    return this.withLock(record.handle, async (r) => {
      if (r.state !== 'connected' || this.fenced(r, gen)) return this.answer(r, gen);
      if (this.deps.guest.holds(r.owner, r.connectionId)) return this.answer(r, gen);
      const res = await this.post(r, '/api/embassy/pair-status', { requestId: r.requestId, claimSecret: r.claimSecret });
      if (this.fenced(r, gen)) return this.answer(r, gen); // a cancel began meanwhile: no new claim
      if (!res || res.status >= 500 || res.status === 429)
        throw new EmbassyPairError(502, 'EMBASSY_UNREACHABLE', 'The embassy did not answer; try again');
      if (res.status === 404 && errorCode(res) === 'PAIR_NOT_FOUND') {
        await this.fail(r, 'PAIR_NOT_FOUND');
        return this.answer(r, gen);
      }
      const status = res.status === 200 ? Status.safeParse(res.body) : undefined;
      // Any other answer proves nothing: the pairing stays connected and the owner may try again.
      if (!status?.success) throw new EmbassyPairError(502, 'EMBASSY_UNREACHABLE', 'The embassy did not answer; try again');
      const s = status.data;
      if (s.state === 'claimed' && s.expiresAt > this.now()) await this.claim(r, gen);
      else if (s.state === 'rejected' || s.state === 'expired' || s.state === 'revoked') await this.terminal(r, s.state);
      else if (s.state === 'claimed') await this.terminal(r, 'expired');
      return this.answer(r, gen);
    });
  }

  /** Cancel: the generation is bumped at once, before the lock, so a claim in flight is fenced. Then, under the lock,
   * the record is `cancelling` (kept, not deleted; durable before any call), the connection is retired, and the
   * embassy is told. The answer is `cancelled` only once the embassy confirmed; otherwise `cancelling`, which every
   * read and tick drives again (CP-K1). */
  cancel(owner: string | undefined, handle: string) {
    const record = this.find(owner, handle);
    // An embassy-terminal pairing keeps its honest state; a failed one may still hold a live request to end.
    const cancellable = (r: PairRecord) => r.state === 'cancelling' || r.state === 'failed' || !TERMINAL.has(r.state);
    if (cancellable(record) && record.state !== 'cancelling') record.generation++;
    return this.withLock(record.handle, async (r) => {
      if (cancellable(r)) {
        if (r.state !== 'cancelling') {
          r.state = 'cancelling';
          r.cancelPending = true;
          await this.save(r);
        }
        await this.deps.guest.retire(r.owner, r.connectionId);
        await this.sendCancel(r);
      }
      return this.view(r);
    });
  }

  private async cancelled(r: PairRecord): Promise<void> {
    r.state = 'cancelled';
    r.cancelPending = false;
    await this.save(r);
  }

  /** Drives a `cancelling` record to `cancelled`. A request that never got its requestId is recovered first with the
   * identical request (the embassy answers with the same one), so a lost ACK cannot leave a live request behind.
   * Confirmation is only: pair-cancel 200 with a terminal state; pair-cancel 404 PAIR_NOT_FOUND (no request with this
   * id and claim secret); or noRequest on the recovery. Anything else (no answer, 408, 429, 5xx, malformed or
   * other-room success, other codes) keeps the token, requestId and debt for the next read or tick (CP-K2). */
  private async sendCancel(r: PairRecord): Promise<void> {
    if (!r.cancelPending) return;
    if (!r.requestId && r.token) {
      const res = await this.requestAgain(r);
      if (!res) return;
      if (res.status === 200 || res.status === 201) {
        const answer = Requested.safeParse(res.body);
        if (!answer.success || answer.data.roomId.toLowerCase() !== r.roomId.toLowerCase()) return;
        r.requestId = answer.data.requestId;
        delete r.token;
        await this.save(r);
      } else if (noRequest(res)) {
        delete r.token;
        return this.cancelled(r);
      } else return;
    }
    // No requestId and no token: a definite refusal left no request, so there is nothing remote to end.
    if (!r.requestId) return this.cancelled(r);
    const res = await this.post(r, '/api/embassy/pair-cancel', { requestId: r.requestId, claimSecret: r.claimSecret });
    if (!res) return;
    if (res.status === 200 && Cancelled.safeParse(res.body).success) return this.cancelled(r);
    if (res.status === 404 && errorCode(res) === 'PAIR_NOT_FOUND') return this.cancelled(r);
  }

  /** Background drive for pairings the browser is not watching: creating, pending, approved and unacknowledged
   * cancels. A handle already busy is skipped this round. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = [...this.records.values()].filter(
        (r) => r.state === 'creating' || r.state === 'pending' || r.state === 'approved' || r.cancelPending
      );
      await Promise.all(
        due.map((r) => {
          const gen = r.generation;
          return this.locks.has(r.handle) ? undefined : this.withLock(r.handle, (fresh) => this.poll(fresh, gen)).catch(() => {});
        })
      );
    } finally {
      this.ticking = false;
    }
  }
}
