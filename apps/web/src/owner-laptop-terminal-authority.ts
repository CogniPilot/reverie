/** Private authority context only; no HTTP, issuance, broker or shell side effects. */
import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

export interface AuthorityRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
}
interface Identity { id: string; username: string; role: 'owner' | 'limited'; primary: boolean }
interface OfficeAuthority {
  session(token: string | undefined): { restricted: boolean; role?: 'owner' | 'limited' } | undefined;
  identity(token: string | undefined): Identity | undefined;
}
export interface LaptopObservation {
  employeeId: string;
  sessionId: string;
  sessionGeneration: number;
  containerId: string;
  imageId: string;
  policyDigest: string;
  running: boolean;
  onVacation: boolean;
  desiredRunning: boolean;
  humanTerminalEntitled: boolean;
}
export interface AuthorityDependencies<R extends AuthorityRequest> {
  /** Existing server-constructed ownerVerifier; never selected by a wire field. */
  verifiedOwner: (request: R) => boolean;
  officeAuth: OfficeAuthority;
  ingress?: {
    /** Exact external origin from trusted installation, never forwarded headers. */
    externalOrigin: string;
    /** Must establish actual transport/ingress binding, not merely echo Host. */
    assertRequestBinding(request: R): void;
  };
  observeLaptop?: (employeeId: string) => Promise<unknown>;
  protectedChannel?: { assertCurrent(): Promise<void> };
  /** Fixed server policy / test clock, never request fields. */
  now?: () => number;
  contextLifetimeMs?: number;
  maxScopes?: number;
}
export interface PrivateAuthorityContext {
  readonly ownerScopeDigest: string;
  readonly target: Readonly<LaptopObservation>;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  recheck(): Promise<void>;
  /** Prevent accidental HTTP JSON response of a private context. */
  toJSON(): never;
}
export class AuthorityRefusal extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'AuthorityRefusal'; this.code = code; }
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const TARGET_KEYS = ['employeeId', 'sessionId', 'sessionGeneration', 'containerId', 'imageId', 'policyDigest',
  'running', 'onVacation', 'desiredRunning', 'humanTerminalEntitled'] as const;
function requireThat(ok: unknown, code: string): asserts ok { if (!ok) throw new AuthorityRefusal(code); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function exactOrigin(value: unknown): string {
  requireThat(typeof value === 'string' && value.length <= 2048, 'ORIGIN');
  let url: URL;
  try { url = new URL(value); } catch { throw new AuthorityRefusal('ORIGIN'); }
  requireThat((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password &&
    value === url.origin, 'ORIGIN');
  return url.origin;
}
function snapshot(value: unknown, employeeId: string): Readonly<LaptopObservation> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'LAPTOP_SCHEMA');
  requireThat(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'LAPTOP_SCHEMA');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireThat(Reflect.ownKeys(descriptors).length === TARGET_KEYS.length &&
    TARGET_KEYS.every(k => descriptors[k] && 'value' in descriptors[k]), 'LAPTOP_SCHEMA');
  const v = value as Record<string, unknown>;
  requireThat(v.employeeId === employeeId && typeof v.sessionId === 'string' && UUID.test(v.sessionId), 'LAPTOP_ID');
  requireThat(typeof v.sessionGeneration === 'number' && Number.isSafeInteger(v.sessionGeneration) &&
    v.sessionGeneration > 0, 'LAPTOP_GENERATION');
  requireThat(typeof v.containerId === 'string' && HEX.test(v.containerId) &&
    typeof v.imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(v.imageId) &&
    typeof v.policyDigest === 'string' && HEX.test(v.policyDigest), 'LAPTOP_INCARNATION');
  for (const k of ['running', 'onVacation', 'desiredRunning', 'humanTerminalEntitled'])
    requireThat(typeof v[k] === 'boolean', 'LAPTOP_STATE_TYPE');
  requireThat(v.running && !v.onVacation && v.desiredRunning && v.humanTerminalEntitled, 'LAPTOP_UNAVAILABLE');
  const result = Object.fromEntries(TARGET_KEYS.map(k => [k, v[k]])) as unknown as LaptopObservation;
  return Object.freeze(result);
}
interface Scope { key: string; identity: string; digest: string; expires: number; revoked: boolean }

export class OwnerLaptopTerminalAuthority<R extends AuthorityRequest> {
  readonly #deps: Readonly<AuthorityDependencies<R>>;
  readonly #scopes = new Map<string, Scope>();
  readonly #epoch = randomBytes(32).toString('hex');
  readonly #origin?: string;
  readonly #lifetime: number;
  readonly #capacity: number;
  #lastTime = -1;
  #closed = false;

  constructor(deps: AuthorityDependencies<R>) {
    // Snapshot fixed composition: subsequent mutation of the caller's port container has no effect.
    this.#deps = Object.freeze({
      verifiedOwner: deps.verifiedOwner,
      officeAuth: { session: deps.officeAuth.session.bind(deps.officeAuth), identity: deps.officeAuth.identity.bind(deps.officeAuth) },
      ingress: deps.ingress && Object.freeze({ externalOrigin: deps.ingress.externalOrigin,
        assertRequestBinding: deps.ingress.assertRequestBinding.bind(deps.ingress) }),
      observeLaptop: deps.observeLaptop,
      protectedChannel: deps.protectedChannel && Object.freeze({ assertCurrent: deps.protectedChannel.assertCurrent.bind(deps.protectedChannel) }),
      now: deps.now ?? Date.now,
    });
    this.#origin = deps.ingress ? exactOrigin(deps.ingress.externalOrigin) : undefined;
    this.#lifetime = deps.contextLifetimeMs ?? 60_000;
    this.#capacity = deps.maxScopes ?? 256;
    requireThat(Number.isSafeInteger(this.#lifetime) && this.#lifetime >= 1 && this.#lifetime <= 3_600_000, 'CONTEXT_LIFETIME');
    requireThat(Number.isSafeInteger(this.#capacity) && this.#capacity >= 1 && this.#capacity <= 256, 'SCOPE_CAPACITY');
  }
  #now(): number {
    requireThat(!this.#closed, 'AUTHORITY_CLOSED');
    const now = this.#deps.now!();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastTime) {
      this.shutdown(); throw new AuthorityRefusal('CLOCK_REGRESSION_OR_TYPE');
    }
    this.#lastTime = now; return now;
  }
  /** Called from backend shutdown. A new instance has a new scope epoch. */
  shutdown(): void { this.#closed = true; for (const s of this.#scopes.values()) s.revoked = true; this.#scopes.clear(); }
  /** Fixed server logout hook; never a browser-supplied token-revocation endpoint. */
  revokeSession(token: string): void {
    const s = this.#scopes.get(digest(token));
    if (s) { s.revoked = true; this.#scopes.delete(s.key); }
  }
  #request(request: R, token: string): void {
    requireThat(this.#deps.ingress && this.#origin, 'TRUSTED_INGRESS_UNAVAILABLE');
    requireThat(exactOrigin(request.headers.origin) === this.#origin &&
      request.headers.host === new URL(this.#origin).host, 'ORIGIN_BINDING');
    // No inference from arbitrary X-Forwarded-* headers. The fixed ingress port must attest transport.
    requireThat(request.headers['x-reverie-parent-session'] === undefined &&
      request.headers['x-reverie-service-token'] === undefined, 'CALLER_KIND');
    requireThat(request.cookies?.reverie_owner === token, 'OWNER_SESSION_DRIFT');
  }
  #owner(request: R, token: string): string {
    try {
      this.#request(request, token);
      requireThat(this.#deps.ingress!.assertRequestBinding(request) === undefined, 'INGRESS_PORT_CONTRACT');
      requireThat(request.cookies?.reverie_owner === token && this.#deps.verifiedOwner(request) === true, 'VERIFIED_OWNER');
      const session = this.#deps.officeAuth.session(token);
      const identity = this.#deps.officeAuth.identity(token);
      requireThat(session && session.restricted === false && session.role === 'owner' && identity &&
        identity.role === 'owner' && text(identity.id) && (identity.id === 'owner' || UUID.test(identity.id)) &&
        text(identity.username) && typeof identity.primary === 'boolean', 'CURRENT_OWNER');
      this.#request(request, token);
      return JSON.stringify([identity.id, identity.username, identity.role, identity.primary]);
    } catch (error) { this.revokeSession(token); throw error; }
  }
  #guard(request: R, token: string, scope: Scope): void {
    const now = this.#now();
    requireThat(!scope.revoked && this.#scopes.get(scope.key) === scope && now < scope.expires, 'OWNER_SCOPE_REVOKED_OR_EXPIRED');
    const identity = this.#owner(request, token);
    if (identity !== scope.identity) { this.revokeSession(token); throw new AuthorityRefusal('OWNER_DRIFT'); }
    const finalTime = this.#now();
    requireThat(!scope.revoked && this.#scopes.get(scope.key) === scope && finalTime < scope.expires, 'OWNER_SCOPE_REVOKED_OR_EXPIRED');
  }
  async #channel(): Promise<void> {
    requireThat(this.#deps.protectedChannel, 'PROTECTED_CHANNEL_UNAVAILABLE');
    requireThat(await this.#deps.protectedChannel.assertCurrent() === undefined, 'CHANNEL_PORT_CONTRACT');
  }
  async capture(request: R, employeeId: string): Promise<PrivateAuthorityContext> {
    requireThat(typeof employeeId === 'string' && UUID.test(employeeId), 'EMPLOYEE_ID');
    const now = this.#now();
    const token = request.cookies?.reverie_owner;
    requireThat(typeof token === 'string' && token.length > 0 && token.length <= 4096, 'OWNER_SESSION');
    const key = digest(token), identity = this.#owner(request, token);
    requireThat(this.#deps.observeLaptop, 'LAPTOP_OBSERVER_UNAVAILABLE');
    requireThat(this.#deps.protectedChannel, 'PROTECTED_CHANNEL_UNAVAILABLE');
    for (const [k, s] of this.#scopes) if (s.expires <= now) { s.revoked = true; this.#scopes.delete(k); }
    let scope = this.#scopes.get(key);
    if (scope && scope.identity !== identity) { this.revokeSession(token); throw new AuthorityRefusal('OWNER_DRIFT'); }
    if (!scope) {
      requireThat(this.#scopes.size < this.#capacity, 'SCOPE_CAPACITY');
      requireThat(Number.isSafeInteger(now + this.#lifetime), 'CONTEXT_EXPIRY');
      scope = { key, identity, digest: digest(this.#epoch + randomBytes(32).toString('hex')),
        expires: now + this.#lifetime, revoked: false };
      this.#scopes.set(key, scope);
    }
    const selected = scope;
    const checkedObservation = async (): Promise<Readonly<LaptopObservation>> => {
      this.#guard(request, token, selected);
      await this.#channel(); this.#guard(request, token, selected);
      const value = snapshot(await this.#deps.observeLaptop!(employeeId), employeeId);
      this.#guard(request, token, selected);
      return value;
    };
    let target: Readonly<LaptopObservation>;
    try {
      target = await checkedObservation();
      // Bracket the asynchronous channel check with matching native identity observations.
      const second = await checkedObservation();
      requireThat(JSON.stringify(target) === JSON.stringify(second), 'LAPTOP_DRIFT');
      this.#guard(request, token, selected);
    } catch (error) { this.revokeSession(token); throw error; }
    const context: PrivateAuthorityContext = {
      ownerScopeDigest: selected.digest, target, issuedAtEpochMs: now, expiresAtEpochMs: selected.expires,
      recheck: async () => {
        try {
          const current = await checkedObservation();
          requireThat(JSON.stringify(target) === JSON.stringify(current), 'LAPTOP_DRIFT');
          this.#guard(request, token, selected);
        } catch (error) { this.revokeSession(token); throw error; }
      },
      toJSON: () => { throw new AuthorityRefusal('SERVER_PRIVATE_CONTEXT'); },
    };
    Object.defineProperty(context, inspect.custom, { value: () => '[Private laptop terminal authority context]' });
    return Object.freeze(context);
  }
}
