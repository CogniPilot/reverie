/** One original B connection from authenticated view to explicit consent.
 * All decoded values are DATA; only the native retained offer can install.
 */
import { Socket } from 'node:net';
import {
  NativeOwnerFrames,
  observeOwnerSocket,
  connectOwnerSocket,
  sendOwnerHello,
  writeOwnerFrame,
} from './native-owner-channel.js';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ResourceOwnerAuthority,
  POOL_INSTALLATION_CONSENT_PURPOSE as PURPOSE,
  type PoolInstallationViewerContext,
  type PoolInstallationOfferContext,
  type PoolInstallationConsentContext,
} from './resource-owner-authority.js';
import {
  answerPoolInstallationChallenge,
  answerPoolInstallationViewChallenge,
  poolInstallationConsentRequest,
} from './pool-installation-consent.js';

import {
  NativeOwnerId as UUID,
  NativeOwnerPrincipal as Principal,
  NativePoolPolicy as Policy,
} from './native-owner-data.js';
const Offer = z
  .object({
    kind: z.enum(['pool-installation-offer', 'pool-installation-viewed']),
    purpose: z.literal(PURPOSE),
    version: z.literal(1),
    requestId: UUID,
    offerNonce: UUID,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    principal: Principal,
    policy: Policy,
    expiresAtEpochMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type PoolInstallationView = z.infer<typeof Offer>;
function need(value: unknown): asserts value {
  if (!value) throw new Error('Native pool installation is unavailable or changed; inspect its retained outcome');
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export class PoolInstallationNativeClient {
  readonly #socket: Socket;
  readonly #authority: ResourceOwnerAuthority;
  readonly #request: FastifyRequest;
  readonly #viewer: PoolInstallationViewerContext;
  readonly #untrack: () => void;
  #view?: PoolInstallationOfferContext;
  #consent?: PoolInstallationConsentContext;
  #offer?: PoolInstallationView;
  readonly #decoder = new NativeOwnerFrames('pool-registration');
  #ready = false;
  #closed = false;
  #viewSent = false;
  #step: 'view' | 'viewed' | 'consent' | 'finished' = 'view';
  #pending?: Pending;
  #frames = 0;
  readonly #nonces = new Set<string>();
  private constructor(
    socket: Socket,
    authority: ResourceOwnerAuthority,
    request: FastifyRequest,
    viewer: PoolInstallationViewerContext
  ) {
    this.#socket = socket;
    this.#authority = authority;
    this.#request = request;
    this.#viewer = viewer;
    this.#untrack = authority.track(viewer, socket);
    socket.on('data', (data) => {
      try {
        this.#data(data);
      } catch (error) {
        this.close(error instanceof Error ? error : new Error('Invalid native installation frame'));
      }
    });
    socket.on('error', (error) => this.close(error));
    socket.on('close', () => this.close());
  }
  static async open(
    path: string,
    authority: ResourceOwnerAuthority,
    request: FastifyRequest
  ): Promise<PoolInstallationNativeClient> {
    // Actual cookie/current principal is checked BEFORE a B connection can be opened.
    const viewer = authority.capturePoolInstallationViewer(request);
    const before = await observeOwnerSocket(path);
    authority.assertContext(viewer);
    const socket = new Socket(),
      client = new PoolInstallationNativeClient(socket, authority, request, viewer);
    try {
      await connectOwnerSocket(socket, path, before);
      authority.assertContext(viewer);
      sendOwnerHello(socket, 'pool-registration');
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  view(): Promise<PoolInstallationView> {
    need(this.#step === 'view' && !this.#pending && !this.#viewSent);
    const promise = this.#wait(15000).then((value) => Offer.parse(value));
    try {
      if (this.#ready) this.#sendView();
    } catch (error) {
      this.close(error instanceof Error ? error : new Error('Native view unavailable'));
    }
    return promise;
  }
  consent(request: FastifyRequest): Promise<unknown> {
    need(this.#step === 'viewed' && this.#view && !this.#pending);
    const consent = this.#authority.capturePoolInstallationConsent(request, this.#view);
    this.#authority.assertSameSession(this.#view, consent);
    this.#consent = consent;
    this.#step = 'consent';
    const promise = this.#wait(consent.expiresAtEpochMs - Date.now());
    try {
      this.#write(poolInstallationConsentRequest(this.#authority, consent));
    } catch (error) {
      this.close(error instanceof Error ? error : new Error('Native consent unavailable'));
    }
    return promise;
  }
  assertSession(request: FastifyRequest): void {
    this.#authority.assertPoolInstallationSession(request, this.#viewer);
  }
  assertViewing(request: FastifyRequest): void {
    this.assertSession(request);
    this.#current();
    need(this.#step === 'viewed');
  }
  close(error = new Error('Native pool outcome is unavailable; do not replay the consent')): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#untrack();
    this.#socket.destroy();
  }
  #current(): void {
    need(!this.#closed && !this.#socket.destroyed);
    this.#authority.assertContext(this.#consent ?? this.#view ?? this.#viewer);
  }
  #wait(maximum: number): Promise<unknown> {
    this.#current();
    need(!this.#pending && maximum > 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), Math.min(maximum, this.#viewer.expiresAtEpochMs - Date.now()));
      this.#pending = { resolve, reject, timer };
    });
  }
  #write(value: unknown): void {
    this.#current();
    need(++this.#frames <= 2048);
    writeOwnerFrame(this.#socket, value);
  }
  #sendView(): void {
    need(!this.#viewSent);
    this.#viewSent = true;
    this.#write({ kind: 'pool-installation-view', purpose: PURPOSE, version: 1, requestId: this.#viewer.requestId });
  }
  #data(data: Buffer): void {
    this.#current();
    this.#decoder.accept(
      data,
      () => {
        this.#ready = true;
        if (this.#pending && !this.#viewSent) this.#sendView();
      },
      (value) => {
        need(++this.#frames <= 2048);
        this.#frame(value);
      }
    );
  }
  #frame(value: unknown): void {
    need(value && typeof value === 'object' && !Array.isArray(value));
    const frame = value as Record<string, unknown>;
    if (frame.kind === 'pool-installation-offer') {
      need(this.#step === 'view' && !this.#offer && this.#pending);
      const offer = Offer.parse(value);
      need(offer.requestId === this.#viewer.requestId && offer.expiresAtEpochMs > Date.now());
      this.#view = this.#authority.capturePoolInstallationOffer(
        this.#request,
        { offerNonce: offer.offerNonce, requestDigest: offer.requestDigest, principal: offer.principal },
        this.#viewer,
        offer.expiresAtEpochMs
      );
      this.#offer = Object.freeze(offer);
      return;
    }
    if (frame.kind === 'pool-installation-view-check' || frame.kind === 'pool-installation-owner-check') {
      need(typeof frame.nonce === 'string' && !this.#nonces.has(frame.nonce));
      this.#nonces.add(frame.nonce);
      if (frame.kind === 'pool-installation-view-check') {
        need(this.#step === 'view' && this.#view);
        this.#write(answerPoolInstallationViewChallenge(this.#authority, this.#view, value));
      } else {
        need(this.#step === 'consent' && this.#consent);
        this.#write(answerPoolInstallationChallenge(this.#authority, this.#consent, value));
      }
      return;
    }
    if (frame.kind === 'pool-installation-viewed') {
      need(this.#step === 'view' && this.#offer && this.#view && this.#pending);
      const viewed = Offer.parse(value);
      need(JSON.stringify({ ...viewed, kind: 'pool-installation-offer' }) === JSON.stringify(this.#offer));
      this.#step = 'viewed';
      const pending = this.#pending;
      this.#pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(viewed);
      return;
    }
    need(frame.kind === 'pool-installation-result' && this.#step === 'consent' && this.#pending && this.#consent);
    need(
      Object.keys(frame).sort().join(',') === 'kind,observed,phase,purpose,requestId,version' &&
        frame.purpose === PURPOSE &&
        frame.version === 1 &&
        frame.requestId === this.#consent.requestId &&
        typeof frame.phase === 'string'
    );
    this.#current();
    this.#step = 'finished';
    const pending = this.#pending;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }
}
