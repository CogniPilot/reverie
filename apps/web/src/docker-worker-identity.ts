import type { FastifyInstance } from 'fastify';
import { isMultiUserMode } from './config/multiuser.js';
/** Docker callback identity only. Company permissions and native effect custody remain independent. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DOCKER_WORKER_IDENTITY_HEADER = 'x-reverie-worker-identity';
const PURPOSE = 'docker-worker-identity';
const DOMAIN = 'reverie-docker-worker-identity-v1\n';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CID = /^[0-9a-f]{64}$/;
const FORBIDDEN_HEADERS = ['authorization', 'x-reverie-service-token', 'x-reverie-recovery-assertion'];
const FORBIDDEN_COOKIES = ['reverie_owner', 'reverie_session'];

export interface DockerWorkerIdentityBinding {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly owner: string | undefined;
  readonly containerId: string;
  readonly credentialId: string;
}
export interface DockerWorkerIdentityRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly cookies?: Record<string, string | undefined>;
}
export interface DockerWorkerIdentityPorts {
  /** From the canonical selected Docker binding, never a request/body argument.
   * Return undefined for stopped, retired, migrated or otherwise ineligible callers. */
  binding(employeeId: string): DockerWorkerIdentityBinding | undefined;
  /** Actual fixed instance-key custody/epoch observation, supplied by its owner. */
  keyCurrent(): boolean;
}

const issuedIdentity = Symbol('issued Docker worker identity');
/** Only this module's real verifier can construct this process-local continuation. */
export class DockerWorkerRequestIdentity {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly owner: string | undefined;
  readonly containerId: string;
  readonly #check: () => boolean;
  constructor(origin: typeof issuedIdentity, binding: DockerWorkerIdentityBinding, check: () => boolean) {
    if (origin !== issuedIdentity) throw Error('Docker worker identity unavailable');
    this.employeeId = binding.employeeId;
    this.sessionId = binding.sessionId;
    this.sessionGeneration = binding.sessionGeneration;
    this.owner = binding.owner;
    this.containerId = binding.containerId;
    this.#check = check;
    Object.freeze(this);
  }
  current(): boolean {
    return this.#check();
  }
  require(): void {
    if (!this.current()) throw Error('Docker worker identity changed');
  }
}

function validBinding(value: DockerWorkerIdentityBinding): boolean {
  return (
    typeof value.employeeId === 'string' &&
    UUID.test(value.employeeId) &&
    typeof value.sessionId === 'string' &&
    UUID.test(value.sessionId) &&
    typeof value.credentialId === 'string' &&
    UUID.test(value.credentialId) &&
    typeof value.containerId === 'string' &&
    CID.test(value.containerId) &&
    Number.isSafeInteger(value.sessionGeneration) &&
    value.sessionGeneration >= 1 &&
    (value.owner === undefined ||
      (typeof value.owner === 'string' &&
        value.owner.length > 0 &&
        value.owner.length <= 100 &&
        !Array.from(value.owner).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
  );
}
function fields(instanceId: string, value: DockerWorkerIdentityBinding): readonly unknown[] {
  return [
    1,
    PURPOSE,
    instanceId,
    value.employeeId,
    value.sessionId,
    value.sessionGeneration,
    value.owner ?? null,
    value.containerId,
    value.credentialId,
  ];
}
function sameBinding(left: DockerWorkerIdentityBinding, right: DockerWorkerIdentityBinding): boolean {
  return validBinding(right) && JSON.stringify(fields('', left)) === JSON.stringify(fields('', right));
}
function header(request: DockerWorkerIdentityRequest, name: string): string | undefined {
  const keys = Object.keys(request.headers).filter((key) => key.toLowerCase() === name);
  if (keys.length !== 1) return undefined;
  const value = request.headers[keys[0]!];
  return typeof value === 'string' ? value : undefined;
}
function unmixed(request: DockerWorkerIdentityRequest): boolean {
  return (
    !Object.keys(request.headers).some((key) => FORBIDDEN_HEADERS.includes(key.toLowerCase())) &&
    !FORBIDDEN_COOKIES.some((key) => request.cookies?.[key] !== undefined)
  );
}

/** The application supplies an actually provisioned private instance key. There
 * is no request/env key selector, native signer, permission grant or engine port.
 * Tokens may be delivered only through the owning private worker-home adapter. */
export class DockerWorkerIdentityAuthentication {
  readonly #key: Buffer;
  #closed = false;
  constructor(
    readonly instanceId: string,
    key: Uint8Array,
    private readonly ports: DockerWorkerIdentityPorts
  ) {
    if (!UUID.test(instanceId) || key.length !== 32) throw Error('Docker worker authentication unavailable');
    this.#key = Buffer.from(key);
  }

  /** Internal provisioning under an already captured real action. A token has no
   * usable identity until the canonical live binding selects this credentialId. */
  issue(binding: DockerWorkerIdentityBinding, stillCurrent: () => boolean): string {
    const current = () => !this.#closed && this.ports.keyCurrent() && stillCurrent();
    if (!validBinding(binding) || !current()) throw Error('Docker worker provisioning refused');
    const encoded = Buffer.from(JSON.stringify(fields(this.instanceId, binding))).toString('base64url');
    const signature = this.sign(encoded).toString('hex');
    if (!current()) throw Error('Docker worker provisioning changed');
    return encoded + '.' + signature;
  }

  /** Possession authenticates this one current worker, never an employee grant. */
  capture(request: DockerWorkerIdentityRequest): DockerWorkerRequestIdentity | undefined {
    try {
      const token = header(request, DOCKER_WORKER_IDENTITY_HEADER);
      if (this.#closed || !token || token.length > 2048 || !unmixed(request) || !this.ports.keyCurrent())
        return undefined;
      const binding = this.decode(token);
      if (!binding) return undefined;
      const parent = header(request, 'x-reverie-parent-session');
      const parentKeys = Object.keys(request.headers).filter((key) => key.toLowerCase() === 'x-reverie-parent-session');
      if (parentKeys.length > 1 || (parentKeys.length === 1 && parent !== binding.sessionId)) return undefined;
      let revoked = false;
      const check = () => {
        if (revoked) return false;
        try {
          const selected = this.ports.binding(binding.employeeId);
          if (
            this.#closed ||
            !this.ports.keyCurrent() ||
            !selected ||
            !sameBinding(binding, selected) ||
            !unmixed(request) ||
            header(request, DOCKER_WORKER_IDENTITY_HEADER) !== token ||
            header(request, 'x-reverie-parent-session') !== parent ||
            Object.keys(request.headers).filter((key) => key.toLowerCase() === 'x-reverie-parent-session').length !==
              parentKeys.length
          ) {
            revoked = true;
          }
        } catch {
          revoked = true;
        }
        return !revoked;
      };
      return check() ? new DockerWorkerRequestIdentity(issuedIdentity, binding, check) : undefined;
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.#closed = true;
    this.#key.fill(0);
  }

  private sign(encoded: string): Buffer {
    return createHmac('sha256', this.#key)
      .update(DOMAIN + encoded)
      .digest();
  }
  private decode(token: string): DockerWorkerIdentityBinding | undefined {
    const [encoded, signature, extra] = token.split('.');
    if (
      extra !== undefined ||
      !encoded ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      !signature ||
      !/^[0-9a-f]{64}$/.test(signature)
    )
      return undefined;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded || !timingSafeEqual(this.sign(encoded), Buffer.from(signature, 'hex')))
      return undefined;
    const raw = bytes.toString('utf8'),
      value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length !== 9 ||
      value[0] !== 1 ||
      value[1] !== PURPOSE ||
      value[2] !== this.instanceId ||
      JSON.stringify(value) !== raw ||
      !Buffer.from(raw).equals(bytes)
    )
      return undefined;
    const binding: DockerWorkerIdentityBinding = {
      employeeId: value[3],
      sessionId: value[4],
      sessionGeneration: value[5],
      owner: value[6] === null ? undefined : value[6],
      containerId: value[7],
      credentialId: value[8],
    };
    return validBinding(binding) ? Object.freeze(binding) : undefined;
  }
}

const verifiedRequests = new WeakMap<object, DockerWorkerRequestIdentity>();
const presentedRequests = new WeakSet<object>();
/** A presented-but-invalidated credential must never fall back to a human/parent hint. */
export function dockerWorkerIdentityPresented(request: DockerWorkerIdentityRequest): boolean {
  return (
    presentedRequests.has(request) ||
    Object.keys(request.headers).some((key) => key.toLowerCase() === DOCKER_WORKER_IDENTITY_HEADER)
  );
}
/** Only the actual registration hook records request authority. */
export function dockerWorkerIdentityOf(request: DockerWorkerIdentityRequest): DockerWorkerRequestIdentity | undefined {
  const identity = verifiedRequests.get(request);
  return identity !== undefined && !isMultiUserMode() && identity.owner === undefined && identity.current()
    ? identity
    : undefined;
}
/** Initial maintained adapter is boxed single-user only. Multi-user account
 * disable/current-role proofs require their own supported adapter, never a synthetic admin. */
export function registerDockerWorkerIdentity(
  app: FastifyInstance,
  authentication: DockerWorkerIdentityAuthentication,
  basePath = ''
): void {
  app.addHook('onRequest', (request, reply, done) => {
    if (!dockerWorkerIdentityPresented(request)) {
      done();
      return;
    }
    presentedRequests.add(request);
    const identity = !isMultiUserMode() ? authentication.capture(request) : undefined;
    if (!identity || identity.owner !== undefined) {
      reply.code(403).send('Docker worker identity refused');
      return;
    }
    verifiedRequests.set(request, identity);
    done();
  });
  app.addHook('preHandler', (request, reply, done) => {
    if (!dockerWorkerIdentityPresented(request)) {
      done();
      return;
    }
    const identity = dockerWorkerIdentityOf(request);
    const route = request.routeOptions.url;
    const path = basePath && route?.startsWith(basePath + '/') ? route.slice(basePath.length) : route;
    const callback = request.method === 'POST' && ['/api/hook-event', '/api/status-telemetry'].includes(path ?? '');
    const body = request.body;
    if (
      !identity ||
      (callback &&
        (!body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          (body as { sessionId?: unknown }).sessionId !== identity.sessionId))
    ) {
      reply.code(403).send('Docker worker callback scope refused');
      return;
    }
    done();
  });
}
