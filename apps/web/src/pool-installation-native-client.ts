/** One original B connection from authenticated view to explicit consent.
 * All decoded values are DATA; only the native retained offer can install.
 */
import { Socket } from 'node:net';
import { lstat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
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

const UUID = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase() && v !== '00000000-0000-0000-0000-000000000000');
const Principal = z
  .object({
    accountId: UUID,
    personId: z.union([z.literal('owner'), UUID]),
    sessionEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();
const Policy = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-docker-worker-pool-v1'),
    deployment: z.string(),
    instanceRoot: z.string(),
    engineId: UUID,
    anchorImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    controllerImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    websiteContainer: z.string().regex(/^[a-f0-9]{64}$/),
    brokerUid: z.number().int().nonnegative(),
    brokerGid: z.number().int().nonnegative(),
    memoryMaxMiB: z.literal(49152),
    poolTasksMax: z.number().int().positive(),
    cpuWeight: z.number().int().min(1).max(10000),
    allowedCpus: z.array(z.number().int().nonnegative()).min(1).readonly(),
    employeeMemoryHighMiB: z.record(UUID, z.number().int().positive().max(49152)).readonly(),
  })
  .strict()
  .readonly();
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
  #buffer = Buffer.alloc(0);
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
    need(isAbsolute(path) && normalize(path) === path && !/[\0\r\n]/.test(path) && process.getuid);
    const before = await lstat(path, { bigint: true });
    need(before.isSocket() && before.uid === BigInt(process.getuid()) && (before.mode & 0o077n) === 0n);
    authority.assertContext(viewer);
    const socket = new Socket(),
      client = new PoolInstallationNativeClient(socket, authority, request, viewer);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Native pool connection expired'));
        }, 3000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.connect(path);
      });
      const after = await lstat(path, { bigint: true });
      need(
        before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.uid === after.uid
      );
      authority.assertContext(viewer);
      const raw = Buffer.from(JSON.stringify({ purpose: 'host-pool-registration-v1', version: 1 })),
        header = Buffer.alloc(5);
      header[0] = 'B'.charCodeAt(0);
      header.writeUInt32BE(raw.length, 1);
      socket.write(Buffer.concat([header, raw]));
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
    const raw = Buffer.from(JSON.stringify(value));
    need(raw.length > 0 && raw.length <= 8192);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(raw.length);
    this.#socket.write(Buffer.concat([header, raw]));
  }
  #sendView(): void {
    need(!this.#viewSent);
    this.#viewSent = true;
    this.#write({ kind: 'pool-installation-view', purpose: PURPOSE, version: 1, requestId: this.#viewer.requestId });
  }
  #data(data: Buffer): void {
    this.#current();
    this.#buffer = Buffer.concat([this.#buffer, data]);
    need(this.#buffer.length <= 16384);
    if (!this.#ready) {
      const end = this.#buffer.indexOf(10);
      if (end < 0) {
        need(this.#buffer.length <= 64);
        return;
      }
      need(this.#buffer.subarray(0, end + 1).toString() === 'POOL_REGISTRATION_CHANNEL_V1\n');
      this.#buffer = this.#buffer.subarray(end + 1);
      this.#ready = true;
      if (this.#pending && !this.#viewSent) this.#sendView();
    }
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readUInt32BE(0);
      need(size > 0 && size <= 8192);
      if (this.#buffer.length < size + 4) break;
      const raw = this.#buffer.subarray(4, size + 4);
      this.#buffer = this.#buffer.subarray(size + 4);
      need(++this.#frames <= 2048);
      this.#frame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    }
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
