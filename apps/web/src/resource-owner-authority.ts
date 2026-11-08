/** Current human-owner proof for the distinct private resource purpose.
 * No route, broker connection, installation or native grant is created here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { Socket } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { OwnerAuthService } from './owner-auth/service.js';
import { OWNER_COOKIE, SERVICE_HEADER, sameOrigin } from './owner-auth/policy.js';
import { ownerFor } from './web/route-helpers.js';

const PURPOSE = 'resource-replacement-v1';
const RAM_PURPOSE = 'resource-ram-pool-v2';
type ResourcePurpose = typeof PURPOSE | typeof RAM_PURPOSE;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const HEX = /^[a-f0-9]{64}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const MINT = Symbol('resource-owner-binding');
const bindings = new WeakMap<object, ResourceOwnerContext>();
export class ResourceOwnerAuthorizationError extends Error {}
function need(value: unknown): asserts value {
  if (!value)
    throw new ResourceOwnerAuthorizationError('Current resource owner authorization is unavailable or changed');
}

/** Produced by the protected host draft before the actual owner Apply. These
 * identifiers are binding references; they are never an authorization token. */
export interface ResourceApproval {
  readonly employeeId: string;
  readonly draftId: string;
  readonly operationId: string;
  readonly reservationId: string;
  readonly targetSid: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly previewDigest: string;
}
export interface RamResourceApproval extends ResourceApproval {
  readonly ramPolicyDigest: string;
}

interface ResourceContext<P extends ResourcePurpose = typeof PURPOSE> {
  readonly purpose: P;
  readonly owner: string | undefined;
  readonly ownerScopeDigest: string;
  readonly expiresAtEpochMs: number;
  assertCurrent(): void;
}
export interface ResourceOwnerContext extends ResourceContext {
  readonly stage: 'apply';
  readonly approval: Readonly<ResourceApproval>;
}
export interface ResourcePreviewContext extends ResourceContext {
  readonly stage: 'preview';
  readonly employeeId: string;
}
export interface RamResourceOwnerContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'apply';
  readonly approval: Readonly<RamResourceApproval>;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamResourcePreviewContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'preview';
  readonly employeeId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
/** Current canonical identity DATA, meaningful only with its actual retained
 * context, cookie/session and attested native channel. */
export interface ResourceOwnerPrincipal {
  readonly accountId: string;
  readonly personId: string;
  readonly sessionEpoch: number;
}
type PrincipalFor<P extends ResourcePurpose> = P extends typeof RAM_PURPOSE
  ? { readonly principal: Readonly<ResourceOwnerPrincipal> }
  : object;
export type AnyResourceContext =
  | ResourceOwnerContext
  | ResourcePreviewContext
  | RamResourceOwnerContext
  | RamResourcePreviewContext;

/** Process-local authority join. A serialized scope digest never recreates it. */
export class ResourceOwnerBinding {
  readonly #context: ResourceOwnerContext;
  constructor(token: symbol, context: ResourceOwnerContext) {
    need(token === MINT && context.purpose === PURPOSE);
    this.#context = context;
    bindings.set(this, context);
    Object.freeze(this);
  }
  get digest(): string {
    return this.#context.ownerScopeDigest;
  }
  assertCurrent(owner: string | undefined): void {
    need(bindings.get(this) === this.#context && owner === this.#context.owner);
    this.#context.assertCurrent();
  }
  assertOperation(
    owner: string | undefined,
    operation: {
      employeeId: string;
      resourceOwnerScope?: string;
      newSession?: string;
      resourceIntent?: Pick<
        ResourceApproval,
        'operationId' | 'reservationId' | 'profileVersion' | 'profileDigest' | 'previewDigest'
      >;
    }
  ): void {
    this.assertCurrent(owner);
    const approved = this.#context.approval,
      intent = operation.resourceIntent;
    need(
      operation.employeeId === approved.employeeId &&
        operation.resourceOwnerScope === this.digest &&
        intent &&
        intent.operationId === approved.operationId &&
        intent.reservationId === approved.reservationId &&
        intent.profileVersion === approved.profileVersion &&
        intent.profileDigest === approved.profileDigest &&
        intent.previewDigest === approved.previewDigest &&
        (operation.newSession === undefined || operation.newSession === approved.targetSid)
    );
  }
  toJSON(): never {
    throw new Error('Resource owner binding is server-private');
  }
}

export function assertResourceOwnerBinding(binding: ResourceOwnerBinding, owner: string | undefined): string {
  need(binding instanceof ResourceOwnerBinding && bindings.has(binding));
  ResourceOwnerBinding.prototype.assertCurrent.call(binding, owner);
  return binding.digest;
}

export function assertResourceOperation(
  binding: ResourceOwnerBinding,
  owner: string | undefined,
  operation: Parameters<ResourceOwnerBinding['assertOperation']>[1]
): string {
  assertResourceOwnerBinding(binding, owner);
  ResourceOwnerBinding.prototype.assertOperation.call(binding, owner, operation);
  return binding.digest;
}

export class ResourceOwnerAuthority {
  readonly #auth: OwnerAuthService;
  readonly #epoch = randomBytes(32).toString('hex');
  readonly #contexts = new WeakSet<object>();
  readonly #sessions = new WeakMap<object, { account: OwnerAuthService; token: string }>();
  readonly #channels = new Map<Socket, Map<string, { account: OwnerAuthService; count: number }>>();
  #closed = false;
  constructor(auth: OwnerAuthService) {
    need(auth instanceof OwnerAuthService);
    this.#auth = auth;
  }
  close(): void {
    this.#closed = true;
    for (const socket of this.#channels.keys()) socket.destroy();
    this.#channels.clear();
  }
  #identity(
    request: FastifyRequest,
    token: string,
    purpose: ResourcePurpose = PURPOSE
  ): { key: string; principal?: Readonly<ResourceOwnerPrincipal> } {
    need(
      !this.#closed &&
        request.method === 'POST' &&
        sameOrigin(request) &&
        request.cookies?.[OWNER_COOKIE] === token &&
        request.headers.authorization === undefined &&
        request.headers[SERVICE_HEADER] === undefined &&
        request.headers['x-reverie-parent-session'] === undefined &&
        !Object.keys(request.headers).some((name) => name.startsWith('x-reverie-goal-'))
    );
    // The root service retains shared-office role/id/primary distinctions;
    // a child account's local identity describes only its own credentials.
    const session = this.#auth.session(token),
      identity = this.#auth.identity(token);
    need(
      session &&
        !session.restricted &&
        (session.role === undefined || session.role === 'owner') &&
        identity?.role === 'owner'
    );
    const owner = ownerFor(request);
    need(owner === undefined || owner === identity.username);
    const human = [owner, identity.id, identity.username, identity.role, identity.primary];
    if (purpose === RAM_PURPOSE) {
      // New RAM authority additionally pins the canonical account birth and
      // current Office person. This read never enrolls a legacy account, and
      // deliberately has no ordinary-identity/cache fallback.
      const current = this.#auth.registrationIdentity(token);
      need(
        UUID.test(current.accountId) &&
          current.accountId !== NIL_UUID &&
          (current.personId === 'owner' || (UUID.test(current.personId) && current.personId !== NIL_UUID)) &&
          current.personId === identity.id &&
          Number.isSafeInteger(current.sessionEpoch) &&
          current.sessionEpoch >= 0
      );
      const principal = Object.freeze({
        accountId: current.accountId,
        personId: current.personId,
        sessionEpoch: current.sessionEpoch,
      });
      return {
        key: JSON.stringify([...human, principal.accountId, principal.personId, principal.sessionEpoch]),
        principal,
      };
    }
    return { key: JSON.stringify(human) };
  }
  capture(request: FastifyRequest, approved: ResourceApproval): ResourceOwnerContext {
    this.#approval(approved, false);
    return this.#capture(request, { stage: 'apply' as const, approval: Object.freeze({ ...approved }) }, PURPOSE);
  }
  captureRam(request: FastifyRequest, approved: RamResourceApproval): RamResourceOwnerContext {
    this.#approval(approved, true);
    return this.#capture(request, { stage: 'apply' as const, approval: Object.freeze({ ...approved }) }, RAM_PURPOSE);
  }
  #approval(approved: ResourceApproval, ram: boolean): void {
    const keys =
      'draftId,employeeId,operationId,previewDigest,profileDigest,profileVersion,' +
      (ram ? 'ramPolicyDigest,' : '') +
      'reservationId,targetSid';
    need(Object.keys(approved).sort().join(',') === keys);
    for (const key of ['draftId', 'employeeId', 'operationId', 'reservationId', 'targetSid'] as const)
      need(typeof approved[key] === 'string' && UUID.test(approved[key]));
    const version = approved.profileVersion;
    const validVersion = ram
      ? typeof version === 'string' && /^[1-9][0-9]{0,19}$/.test(version) && BigInt(version) <= 18446744073709551615n
      : /^[1-9][0-9]{0,15}$/.test(version) && Number.isSafeInteger(Number(version));
    need(
      new Set([approved.draftId, approved.operationId, approved.reservationId, approved.targetSid]).size === 4 &&
        HEX.test(approved.previewDigest) &&
        HEX.test(approved.profileDigest) &&
        validVersion
    );
    if (ram) need(HEX.test((approved as RamResourceApproval).ramPolicyDigest));
  }
  capturePreview(request: FastifyRequest, employeeId: string): ResourcePreviewContext {
    need(typeof employeeId === 'string' && UUID.test(employeeId));
    return this.#capture(request, { stage: 'preview' as const, employeeId }, PURPOSE);
  }
  captureRamPreview(request: FastifyRequest, employeeId: string): RamResourcePreviewContext {
    need(typeof employeeId === 'string' && UUID.test(employeeId));
    return this.#capture(request, { stage: 'preview' as const, employeeId }, RAM_PURPOSE);
  }
  requestOwner(request: FastifyRequest): string | undefined {
    const token = request.cookies?.[OWNER_COOKIE];
    need(typeof token === 'string' && token.length > 0 && token.length <= 4096);
    this.#identity(request, token);
    return ownerFor(request);
  }
  #capture<
    P extends ResourcePurpose,
    T extends { stage: 'apply'; approval: Readonly<ResourceApproval> } | { stage: 'preview'; employeeId: string },
  >(request: FastifyRequest, selected: T, purpose: P): Readonly<ResourceContext<P> & T> & PrincipalFor<P> {
    const token = request.cookies?.[OWNER_COOKIE];
    need(typeof token === 'string' && token.length > 0 && token.length <= 4096);
    const identity = this.#identity(request, token, purpose),
      owner = ownerFor(request);
    const issued = Date.now(),
      expires = issued + 300_000;
    need(Number.isSafeInteger(issued) && Number.isSafeInteger(expires));
    const assertCurrent = () => {
      need(
        this.#contexts.has(context) &&
          Date.now() >= issued &&
          Date.now() < expires &&
          this.#identity(request, token, purpose).key === identity.key
      );
    };
    const context = Object.freeze({
      purpose,
      owner,
      ownerScopeDigest: digest(this.#epoch + identity.key + randomBytes(32).toString('hex')),
      ...(identity.principal === undefined ? {} : { principal: identity.principal }),
      ...selected,
      expiresAtEpochMs: expires,
      assertCurrent,
      toJSON: () => {
        throw new Error('Resource owner context is server-private');
      },
      [inspect.custom]: () => '[Private resource owner context]',
    }) as Readonly<ResourceContext<P> & T> & PrincipalFor<P>;
    this.#contexts.add(context);
    this.#sessions.set(context, { account: this.#auth.forSession(token), token });
    assertCurrent();
    return context;
  }
  assertContext(context: AnyResourceContext): void {
    need(this.#contexts.has(context));
    context.assertCurrent();
  }
  assertSameSession(left: AnyResourceContext, right: AnyResourceContext): void {
    this.assertContext(left);
    this.assertContext(right);
    const a = this.#sessions.get(left),
      b = this.#sessions.get(right);
    need(
      a &&
        b &&
        a.account === b.account &&
        a.token === b.token &&
        left.owner === right.owner &&
        left.purpose === right.purpose
    );
  }
  bind(context: ResourceOwnerContext): ResourceOwnerBinding {
    this.assertContext(context);
    need(context.stage === 'apply' && context.purpose === PURPOSE);
    return new ResourceOwnerBinding(MINT, context);
  }
  track(context: AnyResourceContext, socket: Socket): () => void {
    this.assertContext(context);
    need(socket instanceof Socket && !socket.destroyed);
    const source = this.#sessions.get(context);
    need(source);
    const channels = this.#channels.get(socket) ?? new Map<string, { account: OwnerAuthService; count: number }>();
    const held = channels.get(source.token) ?? { account: source.account, count: 0 };
    need(held.account === source.account);
    if (held.count++ === 0) source.account.track(source.token, socket);
    channels.set(source.token, held);
    this.#channels.set(socket, channels);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.count === 0) {
        source.account.untrack(source.token, socket);
        channels.delete(source.token);
      }
      if (!channels.size) this.#channels.delete(socket);
    };
  }
}
