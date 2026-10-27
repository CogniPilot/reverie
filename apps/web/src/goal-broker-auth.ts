/**
 * @fileoverview Optional broker-authenticated Goal request boundary. Not registered
 * by WebServer and grants no Goal action itself. No keys/configuration are read.
 * All identity, durable nonce and private-custody ports default to unavailable.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const GOAL_ASSERTION_HEADER = 'x-reverie-goal-assertion';
const MAX_BODY = 64 * 1024;
const MAX_LIFETIME_MS = 10_000;
const id = /^[A-Za-z0-9_.:-]{1,64}$/;
const session = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const nonce = /^[0-9a-f]{32}$/;
const digest = /^[0-9a-f]{64}$/;
// r3's canonical identifier contract; issuer/epoch retain the separate id64 predicate.
const canonicalGoalIdSource = '[A-Za-z0-9_.:-]{1,100}';
const canonicalGoalId = new RegExp('^' + canonicalGoalIdSource + '$');
const getRoute = new RegExp(
  '^/api/(?:goals(?:/' +
    canonicalGoalIdSource +
    ')?|goal-metadata/' +
    canonicalGoalIdSource +
    '(?:\\?grantId=' +
    canonicalGoalIdSource +
    ')?)$'
);
const postRoute = new RegExp(
  '^/api/(?:goals(?:/' +
    canonicalGoalIdSource +
    '/(?:transitions|adopt|unblock-proofs))?|goal-grants(?:/' +
    canonicalGoalIdSource +
    '/revoke)?|goal-unblock-proofs/' +
    canonicalGoalIdSource +
    '/revoke)$'
);

export function isBrokerGoalRequest(method: string, target: string): boolean {
  // JS `$` permits a trailing newline; the alphabet guard makes the whole target exact.
  return (
    !target.includes('\n') &&
    !target.includes('\r') &&
    /^[A-Za-z0-9/_.:?-]+(?:=[A-Za-z0-9_.:-]+)?$/.test(target) &&
    ((method === 'GET' && getRoute.test(target)) || (method === 'POST' && postRoute.test(target)))
  );
}

export interface GoalBrokerBinding {
  readonly owner?: string;
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export interface GoalBrokerIssuer {
  readonly epoch: string;
  readonly key: Uint8Array;
}

export interface GoalNonceKey {
  readonly issuer: string;
  readonly epoch: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface GoalBrokerPorts {
  readonly canonicalFile: string;
  /** Host-managed, purpose-specific trust only. Undefined means revoked/unavailable. */
  issuer(id: string): GoalBrokerIssuer | undefined;
  /** Exact current active binding; undefined during migration, retirement or revocation. */
  binding(sessionId: string): GoalBrokerBinding | undefined;
  /** Canonical file, parent, lock, tmp and authority namespace outside worker-writable mounts. */
  assertPrivateCustody(file: string): void;
  readonly nonces: {
    /** Durable, atomic, cross-process insert-if-absent; never evict an unexpired claim.
     * A crash after acceptance burns the nonce. Uncertain requests require status reconciliation,
     * not retransmission. Returns an opaque private claim, or undefined on replay/capacity failure. */
    claim(key: GoalNonceKey): Promise<object | undefined>;
    /** Synchronous recheck that this exact claim still owns the nonce at commit time. */
    assertCurrent(claim: object, key: GoalNonceKey): void;
  };
  now?: () => number;
}

export type BrokerGoalPrincipal = Readonly<GoalBrokerBinding & { kind: 'employee' }>;
export class GoalBrokerAccessError extends Error {
  readonly status = 403;
  readonly code = 'GOAL_FORBIDDEN';
  constructor() {
    super('Authenticated Goal request unavailable or no longer current');
  }
}

type Fields = [1, 'goal-request', string, string, string, number, string, string, string, number, number, string];
interface Verified {
  principal: BrokerGoalPrincipal;
  fields: Fields;
  keyDigest: string;
  claim: object;
  nonceKey: GoalNonceKey;
}
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\n') && !value.includes('\r') && pattern.test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Structurally supplies GoalAuthentication's employee branch without importing/mutating the pending core. */
export class GoalBrokerAuthentication {
  private readonly verified = new WeakMap<object, Verified>();
  constructor(private readonly ports?: GoalBrokerPorts) {}

  private authorityCurrent(record: Verified): void {
    const p = this.ports;
    if (!p || !p.canonicalFile) throw new GoalBrokerAccessError();
    const f = record.fields;
    const now = (p.now ?? Date.now)();
    if (!integer(now) || f[9] > now || f[10] <= now) throw new GoalBrokerAccessError();
    const issuer = p.issuer(f[2]);
    if (!issuer || issuer.epoch !== f[3] || issuer.key.byteLength < 32 || sha256(issuer.key) !== record.keyDigest)
      throw new GoalBrokerAccessError();
    const binding = p.binding(f[4]);
    if (
      !binding ||
      binding.sessionId !== f[4] ||
      binding.sessionGeneration !== f[5] ||
      binding.employeeId !== record.principal.employeeId ||
      binding.owner !== record.principal.owner
    )
      throw new GoalBrokerAccessError();
    p.assertPrivateCustody(p.canonicalFile);
    // Trusted synchronous ports may themselves block. Do not carry an earlier
    // clock observation across their work into the final effect fence.
    const finalNow = (p.now ?? Date.now)();
    if (!integer(finalNow) || finalNow < now || f[9] > finalNow || f[10] <= finalNow) throw new GoalBrokerAccessError();
  }

  private current(record: Verified): void {
    this.authorityCurrent(record);
    const p = this.ports;
    if (!p) throw new GoalBrokerAccessError();
    p.nonces.assertCurrent(record.claim, record.nonceKey);
    // Durable nonce checking can lock/read/fsync synchronously. Its success is
    // not evidence that issuer, key, binding, expiry or custody survived that I/O.
    // Explicit auth successor: repeat authority checks AFTER the blocking port.
    this.authorityCurrent(record);
  }

  async verify(
    context: object,
    request: { method: string; target: string; body: Buffer; assertion: unknown }
  ): Promise<void> {
    if (this.verified.has(context)) throw new GoalBrokerAccessError();
    try {
      const p = this.ports;
      const { method, target, body, assertion } = request;
      if (
        !p ||
        !p.canonicalFile ||
        !isBrokerGoalRequest(method, target) ||
        body.length > MAX_BODY ||
        (method === 'GET' && body.length) ||
        typeof assertion !== 'string' ||
        assertion.length > 2048
      )
        throw new GoalBrokerAccessError();
      const parts = assertion.split('.');
      if (parts.length !== 2 || !exact(/^[A-Za-z0-9_-]+$/, parts[0]) || !exact(digest, parts[1]))
        throw new GoalBrokerAccessError();
      const bytes = Buffer.from(parts[0], 'base64url');
      if (bytes.toString('base64url') !== parts[0]) throw new GoalBrokerAccessError();
      const f: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !Array.isArray(f) ||
        f.length !== 12 ||
        f[0] !== 1 ||
        f[1] !== 'goal-request' ||
        !exact(id, f[2]) ||
        !exact(id, f[3]) ||
        !exact(session, f[4]) ||
        !integer(f[5]) ||
        f[5] < 1 ||
        f[6] !== method ||
        f[7] !== target ||
        !exact(digest, f[8]) ||
        f[8] !== sha256(body) ||
        !integer(f[9]) ||
        !integer(f[10]) ||
        f[10] <= f[9] ||
        f[10] - f[9] > MAX_LIFETIME_MS ||
        !exact(nonce, f[11])
      )
        throw new GoalBrokerAccessError();
      const fields = f as Fields;
      const issuer = p.issuer(fields[2]);
      if (!issuer || issuer.epoch !== fields[3] || issuer.key.byteLength < 32) throw new GoalBrokerAccessError();
      const expected = createHmac('sha256', issuer.key)
        .update('reverie-goal-request-v1\n' + parts[0])
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(parts[1], 'hex'))) throw new GoalBrokerAccessError();
      const now = (p.now ?? Date.now)();
      if (!integer(now) || fields[9] > now || fields[10] <= now) throw new GoalBrokerAccessError();
      const binding = p.binding(fields[4]);
      if (
        !binding ||
        !exact(canonicalGoalId, binding.employeeId) ||
        binding.sessionId !== fields[4] ||
        binding.sessionGeneration !== fields[5]
      )
        throw new GoalBrokerAccessError();
      p.assertPrivateCustody(p.canonicalFile);
      const principal = Object.freeze({
        kind: 'employee' as const,
        owner: binding.owner,
        employeeId: binding.employeeId,
        sessionId: binding.sessionId,
        sessionGeneration: binding.sessionGeneration,
      });
      const keyDigest = sha256(issuer.key);
      const nonceKey = Object.freeze({ issuer: fields[2], epoch: fields[3], nonce: fields[11], expiresAt: fields[10] });
      const claim = await p.nonces.claim(nonceKey);
      if (!claim) throw new GoalBrokerAccessError();
      const record: Verified = {
        principal,
        fields,
        keyDigest,
        claim,
        nonceKey,
      };
      this.current(record); // Claim awaits cannot carry stale authority into the handler.
      this.verified.set(context, record);
    } catch {
      throw new GoalBrokerAccessError(); // Never echo assertion, secret, body or port error.
    }
  }

  async authenticate(context: unknown): Promise<BrokerGoalPrincipal | undefined> {
    if (!context || typeof context !== 'object') return undefined;
    const record = this.verified.get(context);
    if (!record) return undefined;
    this.assertCurrent(record.principal, context);
    return record.principal;
  }

  assertCurrent(principal: BrokerGoalPrincipal, context: unknown): void {
    try {
      const record = context && typeof context === 'object' ? this.verified.get(context) : undefined;
      if (!record || record.principal !== principal) throw new GoalBrokerAccessError();
      this.current(record);
    } catch {
      throw new GoalBrokerAccessError();
    }
  }

  assertPrivateCustody(file: string): void {
    try {
      if (!this.ports || file !== this.ports.canonicalFile) throw new GoalBrokerAccessError();
      this.ports.assertPrivateCustody(file);
    } catch {
      throw new GoalBrokerAccessError();
    }
  }
}

/** Optional Fastify boundary, deliberately NOT wired into WebServer yet. No auth/policy bypass.
 * Captures the exact bounded bytes before JSON parsing; semantically equivalent JSON is not identical. */
export function registerGoalBrokerBoundary(app: FastifyInstance, auth = new GoalBrokerAuthentication()): void {
  const bodies = new WeakMap<FastifyRequest, Buffer>();
  app.addHook('preParsing', async (req, reply, payload) => {
    if (req.headers[GOAL_ASSERTION_HEADER] === undefined) return payload;
    if (!isBrokerGoalRequest(req.method, req.raw.url ?? '')) {
      await reply.code(403).send({ success: false, errorCode: 'GOAL_FORBIDDEN', error: 'Goal request refused' });
      return payload;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY) {
        await reply.code(413).send({ success: false, errorCode: 'GOAL_FORBIDDEN', error: 'Goal request refused' });
        return Readable.from([]);
      }
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    bodies.set(req, body);
    return Readable.from(body.length ? [body] : []);
  });
  app.addHook('preValidation', async (req, reply) => {
    if (req.headers[GOAL_ASSERTION_HEADER] === undefined) return;
    try {
      const body = bodies.get(req);
      if (!body) throw new GoalBrokerAccessError();
      await auth.verify(req, {
        method: req.method,
        target: req.raw.url ?? '',
        body,
        assertion: req.headers[GOAL_ASSERTION_HEADER],
      });
    } catch {
      await reply.code(403).send({ success: false, errorCode: 'GOAL_FORBIDDEN', error: 'Goal request refused' });
    }
  });
}
