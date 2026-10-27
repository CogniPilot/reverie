/**
 * @fileoverview Scoped service authentication for dedicated service principals (RESUME_SERVICE, LEASE_SERVICE and any
 * other deployment-configured purpose).
 * Trusted bootstrap seam only: no keys, grants or configuration are read here. Every port defaults to unavailable,
 * so an unconfigured server authenticates no service. A grant is an explicit, owner-bound, purpose-specific record
 * from the same canonical store as the owner/employee binding; titles, maintenance grants, caller booleans and Board
 * choices are never grants. Each request carries a short-lived single-use HMAC assertion from the principal's
 * host-managed key, and the returned lease rechecks the whole chain on every current() call.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CompanyService } from './company-service.js';
import {
  DEFAULT_SERVICE_PURPOSES,
  ServiceGrantSchema,
  servicePurposeScope,
  type CompanyState,
  type ServiceGrant,
  type ServicePurposes,
} from './company-types.js';
import type { GoalAuthentication } from './goal-access.js';
import type { ResumeGrantLease } from './recovery-authority.js';

export type ServicePurpose = string;
const MAX_LIFETIME_MS = 10_000;
const canonicalId = /^[A-Za-z0-9_.:-]{1,100}$/;
const ownerIdPattern = /^(?:[A-Za-z0-9_.:-]{1,100})?$/;
const session = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const nonce = /^[0-9a-f]{32}$/;
const digest = /^[0-9a-f]{64}$/;

export interface ServiceIssuer {
  readonly epoch: string;
  readonly key: Uint8Array;
}
export interface ServiceNonceKey {
  readonly principal: string;
  readonly epoch: string;
  readonly nonce: string;
  readonly expiresAt: number;
}
export interface ServiceGrantPorts {
  /** Host-managed, purpose-specific key of a dedicated service principal. Undefined means revoked/unavailable. */
  issuer(principal: string): ServiceIssuer | undefined;
  /** Exact current grant record from the canonical store (see canonicalServiceGrantSource); parsed strictly here. */
  grant(grantId: string): unknown;
  /** true = revoked, false = known current; anything else is unknown and fails closed. */
  revoked(grantId: string): boolean | undefined;
  /** Current exact canonical binding of an active employee; undefined when missing, ambiguous, migrating or inactive. */
  binding(employeeId: string): ServiceEmployeeBinding | undefined;
  readonly nonces: {
    /** Durable, atomic, cross-process insert-if-absent; undefined on replay or capacity failure. */
    claim(key: ServiceNonceKey): Promise<object | undefined>;
    /** Synchronous recheck that this exact claim still owns the nonce. */
    assertCurrent(claim: object, key: ServiceNonceKey): void;
  };
  now?: () => number;
}

export interface ServiceEmployeeBinding {
  readonly owner?: string;
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

/** What an authenticated service may use. current(target) is the only authority test; it never throws. */
export interface ServiceGrantLease {
  readonly kind: ServicePurpose;
  readonly ownerId: string;
  readonly principal: string;
  readonly grantId: string;
  /** Opaque issuer epoch string; never an integer to be compared by size. */
  readonly epoch: string;
  /** 'sha256:' + digest of the exact canonical grant and its configured scope kind (OPS grantRef.policyGeneration). */
  readonly generation: string;
  /** Employee- or resource-scoped purposes. Always false for employees+resources purposes. */
  current(target: string): boolean;
  /** employees+resources purposes (OPS): this employee may act on this configured resource. False otherwise. */
  currentFor(employeeId: string, resourceId: string): boolean;
}

type Fields = [1, 'service-assertion', ServicePurpose, string, string, string, string, number, number, string];
const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\n') && !value.includes('\r') && pattern.test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const canonicalGrant = (grant: ServiceGrant): string =>
  JSON.stringify([
    grant.id,
    grant.purpose,
    grant.owner ?? null,
    grant.principal,
    grant.epoch,
    grant.employees.map((e) => [e.employeeId, e.sessionId, e.sessionGeneration]),
    grant.resources,
    grant.issuedAt,
    grant.expiresAt,
  ]);
/** RESUME_SERVICE: the target employee's CURRENT canonical binding must equal the granted one (owner, session,
 * generation). LEASE_SERVICE: the target is one of the granted configured resource names. */
function inScope(grant: ServiceGrant, target: string, ports: ServiceGrantPorts, purposes: ServicePurposes): boolean {
  const scope = servicePurposeScope(purposes, grant.purpose);
  if (scope === 'resources') return grant.resources.includes(target);
  if (scope !== 'employees') return false;
  return employeeCurrent(grant, target, ports);
}
function employeeCurrent(grant: ServiceGrant, target: string, ports: ServiceGrantPorts): boolean {
  const granted = grant.employees.filter((e) => e.employeeId === target);
  if (granted.length !== 1) return false;
  const current = ports.binding(target);
  return (
    !!current &&
    current.employeeId === target &&
    current.owner === grant.owner &&
    current.sessionId === granted[0]!.sessionId &&
    current.sessionGeneration === granted[0]!.sessionGeneration
  );
}

/** Assertion text: base64url(JSON fields) + '.' + hex HMAC-SHA256(key, domain + payload). For the issuing side and tests. */
export function signServiceAssertion(
  key: Uint8Array,
  fields: {
    purpose: ServicePurpose;
    principal: string;
    epoch: string;
    ownerId: string;
    grantId: string;
    issuedAt: number;
    expiresAt: number;
    nonce: string;
  }
): string {
  const payload = Buffer.from(
    JSON.stringify([
      1,
      'service-assertion',
      fields.purpose,
      fields.principal,
      fields.epoch,
      fields.ownerId,
      fields.grantId,
      fields.issuedAt,
      fields.expiresAt,
      fields.nonce,
    ])
  ).toString('base64url');
  return (
    payload +
    '.' +
    createHmac('sha256', key)
      .update('reverie-service-assertion-v1\n' + payload)
      .digest('hex')
  );
}

export class ServiceGrantAuthentication {
  constructor(
    private readonly ports?: ServiceGrantPorts,
    /** The same deployment-configured purpose registry the owner issues grants under. */
    private readonly purposes: ServicePurposes = DEFAULT_SERVICE_PURPOSES
  ) {}

  /** context: an object whose own `assertion` property is the assertion text. Null on any doubt; never echoes input. */
  async authenticate(context: unknown, purpose: ServicePurpose): Promise<ServiceGrantLease | null> {
    try {
      const p = this.ports;
      if (!p || !servicePurposeScope(this.purposes, purpose) || !context || typeof context !== 'object') return null;
      const descriptor = Object.getOwnPropertyDescriptor(context, 'assertion');
      const assertion: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      if (typeof assertion !== 'string' || assertion.length > 2048) return null;
      const parts = assertion.split('.');
      if (parts.length !== 2 || !exact(/^[A-Za-z0-9_-]+$/, parts[0]) || !exact(digest, parts[1])) return null;
      const bytes = Buffer.from(parts[0]!, 'base64url');
      if (bytes.toString('base64url') !== parts[0]) return null;
      const f: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !Array.isArray(f) ||
        f.length !== 10 ||
        f[0] !== 1 ||
        f[1] !== 'service-assertion' ||
        f[2] !== purpose ||
        !exact(canonicalId, f[3]) ||
        !exact(canonicalId, f[4]) ||
        !exact(ownerIdPattern, f[5]) || // '' = a single-owner deployment whose records carry no owner
        !exact(canonicalId, f[6]) ||
        !integer(f[7]) ||
        !integer(f[8]) ||
        f[8] <= f[7] ||
        f[8] - f[7] > MAX_LIFETIME_MS ||
        !exact(nonce, f[9])
      )
        return null;
      const fields = f as Fields;
      const issuer = p.issuer(fields[3]);
      if (!issuer || issuer.epoch !== fields[4] || issuer.key.byteLength < 32) return null;
      const expected = createHmac('sha256', issuer.key)
        .update('reverie-service-assertion-v1\n' + parts[0])
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(parts[1]!, 'hex'))) return null;
      const parsed = ServiceGrantSchema.safeParse(p.grant(fields[6]));
      if (!parsed.success) return null;
      const grant = parsed.data;
      const grantDigest = sha256(canonicalGrant(grant));
      const keyDigest = sha256(issuer.key);
      const nonceKey: ServiceNonceKey = Object.freeze({
        principal: fields[3],
        epoch: fields[4],
        nonce: fields[9],
        expiresAt: fields[8],
      });
      // Everything except the target is checked before the nonce is spent.
      const authority = (): boolean => {
        const now = (p.now ?? Date.now)();
        if (!integer(now) || fields[7] > now || fields[8] <= now) return false;
        const currentIssuer = p.issuer(fields[3]);
        if (
          !currentIssuer ||
          currentIssuer.epoch !== fields[4] ||
          currentIssuer.key.byteLength < 32 ||
          sha256(currentIssuer.key) !== keyDigest
        )
          return false;
        const fresh = ServiceGrantSchema.safeParse(p.grant(fields[6]));
        if (!fresh.success || sha256(canonicalGrant(fresh.data)) !== grantDigest) return false;
        if (p.revoked(fields[6]) !== false) return false;
        return (
          grant.id === fields[6] &&
          grant.purpose === purpose &&
          grant.principal === fields[3] &&
          grant.epoch === fields[4] &&
          (grant.owner ?? '') === fields[5] &&
          grant.issuedAt <= now &&
          now < grant.expiresAt
        );
      };
      if (!authority()) return null;
      const claim = await p.nonces.claim(nonceKey);
      if (!claim) return null;
      const fenced = (scoped: () => boolean): boolean => {
        try {
          if (!authority() || !scoped()) return false;
          p.nonces.assertCurrent(claim, nonceKey);
          // Ports may block; their success is not evidence that issuer, grant, revocation, expiry or binding survived.
          return authority() && scoped();
        } catch {
          return false;
        }
      };
      const scopeKind = servicePurposeScope(this.purposes, grant.purpose);
      const current = (target: string): boolean =>
        exact(canonicalId, target) && fenced(() => inScope(grant, target, p, this.purposes));
      const currentFor = (employeeId: string, resourceId: string): boolean =>
        exact(canonicalId, employeeId) &&
        exact(canonicalId, resourceId) &&
        scopeKind === 'employees+resources' &&
        fenced(() => grant.resources.includes(resourceId) && employeeCurrent(grant, employeeId, p));
      return Object.freeze({
        kind: purpose,
        ownerId: grant.owner ?? '',
        principal: grant.principal,
        grantId: grant.id,
        epoch: grant.epoch,
        generation: 'sha256:' + sha256(canonicalGrant(grant) + '\n' + scopeKind),
        current,
        currentFor,
      });
    } catch {
      return null;
    }
  }

  /** Exact RecoveryAuthoritySources.authenticate adapter: only a RESUME_SERVICE grant can yield a lease. */
  readonly authenticateResume = async (context: unknown): Promise<ResumeGrantLease | null> => {
    if (servicePurposeScope(this.purposes, 'RESUME_SERVICE') !== 'employees') return null;
    const lease = await this.authenticate(context, 'RESUME_SERVICE');
    return lease && lease.kind === 'RESUME_SERVICE'
      ? Object.freeze({ kind: 'RESUME_SERVICE' as const, ownerId: lease.ownerId, current: lease.current })
      : null;
  };

  /** Lease-service principal (prune/janitor): only a LEASE_SERVICE grant; current(resource) for each effect batch. */
  readonly authenticateLeaseService = async (context: unknown): Promise<ServiceGrantLease | null> =>
    servicePurposeScope(this.purposes, 'LEASE_SERVICE') === 'resources'
      ? this.authenticate(context, 'LEASE_SERVICE')
      : null;
}

export interface CanonicalServiceGrantOptions {
  /** The SAME CompanyService used by WebServer, never a second store. */
  readonly company: Pick<CompanyService, 'store'>;
  /** Existing mandatory custody port. */
  readonly custody: Pick<GoalAuthentication, 'assertPrivateCustody'>;
}
/** grant/revoked/binding ports read from the same canonical CompanyStore, with custody checked around every fresh read.
 * It authenticates nobody: issuer keys and the durable nonce store remain host bootstrap ports. */
export function canonicalServiceGrantSource(
  options: CanonicalServiceGrantOptions
): Pick<ServiceGrantPorts, 'grant' | 'revoked' | 'binding'> {
  const snapshot = (): CompanyState => {
    const settle = (value: unknown) => {
      if (value !== undefined) throw new Error('custody port must be synchronous');
    };
    settle(options.custody.assertPrivateCustody(options.company.store.file));
    const state = options.company.store.snapshot();
    settle(options.custody.assertPrivateCustody(options.company.store.file));
    return state;
  };
  const one = <T>(items: T[]): T | undefined => (items.length === 1 ? items[0] : undefined);
  return {
    grant: (grantId) => one(snapshot().serviceGrants.filter((g) => g.id === grantId)),
    revoked: (grantId) => {
      const state = snapshot();
      const grant = one(state.serviceGrants.filter((g) => g.id === grantId));
      if (!grant) return undefined;
      return state.serviceGrantRevocations.some((r) => r.grantId === grantId && r.owner === grant.owner);
    },
    binding: (employeeId) => {
      const state = snapshot();
      const employee = one(state.employees.filter((e) => e.id === employeeId));
      if (
        !employee ||
        employee.bindingMigration ||
        employee.onVacation ||
        employee.desiredRunning === false ||
        !exact(session, employee.sessionId) ||
        !Number.isSafeInteger(employee.sessionGeneration) ||
        employee.sessionGeneration < 1 ||
        state.employees.filter((e) => e.sessionId === employee.sessionId).length !== 1
      )
        return undefined;
      return Object.freeze({
        owner: employee.owner,
        employeeId: employee.id,
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
      });
    },
  };
}
