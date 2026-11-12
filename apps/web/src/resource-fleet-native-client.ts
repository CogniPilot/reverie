/** One authenticated Q conversation, retained across preview/apply/result HTTP calls. */
import { Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyRequest } from 'fastify';
import {
  NativeOwnerFrames,
  observeOwnerSocket,
  connectOwnerSocket,
  sendOwnerHello,
  writeOwnerFrame,
} from './native-owner-channel.js';
import {
  ResourceOwnerAuthority,
  type FleetViewerContext,
  type FleetPreviewContext,
  type FleetMigrationContext,
  type ResourceOwnerPrincipal,
} from './resource-owner-authority.js';
import { answerFleetChallenge, fleetPreviewRequest, fleetMigrationRequest } from './resource-fleet-consent.js';
import {
  NativeFleetPreviewData,
  NativeFleetMigrationData,
  NativeFleetMigrationFailureData,
  type NativeFleetPreview,
  type NativeFleetMigration,
  type NativeFleetMigrationFailure,
} from './resource-fleet-native-data.js';

/** Authenticated diagnostic DATA, never a terminal native outcome or replay permit. */
export class NativeFleetMigrationFailureError extends Error {
  readonly code: string;
  readonly outcome = 'unconfirmed' as const;
  constructor(readonly diagnostic: NativeFleetMigrationFailure) {
    super(`Native shared-pool migration is unconfirmed (${diagnostic.code}). Do not resend consent.`);
    this.name = 'NativeFleetMigrationFailureError';
    this.code = diagnostic.code;
  }
}

export interface FleetNativeOwnerBinding {
  readonly ownerScopeDigest: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
  readonly owner: string | undefined;
}

function need(value: unknown): asserts value {
  if (!value) throw new Error('Original native fleet outcome unavailable; do not replay migration');
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export class FleetNativeClient {
  readonly #decoder = new NativeOwnerFrames('fleet-maintenance');
  readonly #untrack: () => void;
  readonly #expiry: ReturnType<typeof setTimeout>;
  readonly #nonces = new Set<string>();
  #previewContext?: FleetPreviewContext;
  #migration?: FleetMigrationContext;
  #preview?: NativeFleetPreview;
  #pending?: Pending;
  #ready = false;
  #sent = false;
  #closed = false;
  #frames = 0;
  #step: 'preview' | 'viewed' | 'migration' | 'finished' = 'preview';
  private constructor(
    private readonly socket: Socket,
    private readonly authority: ResourceOwnerAuthority,
    private readonly request: FastifyRequest,
    private readonly viewer: FleetViewerContext
  ) {
    this.#untrack = authority.track(viewer, socket);
    this.#expiry = setTimeout(() => this.close(), viewer.expiresAtEpochMs - Date.now());
    socket.on('data', (data) => {
      try {
        this.#current();
        this.#decoder.accept(
          data,
          () => {
            this.#ready = true;
            this.#sendPreview();
          },
          (value) => this.#frame(value)
        );
      } catch (error) {
        this.close(error instanceof Error ? error : new Error('Invalid native fleet frame'));
      }
    });
    socket.on('error', (error) => this.close(error));
    socket.on('close', () => this.close());
  }
  static async open(
    path: string,
    authority: ResourceOwnerAuthority,
    request: FastifyRequest
  ): Promise<FleetNativeClient> {
    const viewer = authority.captureFleetViewer(request);
    const before = await observeOwnerSocket(path);
    authority.assertContext(viewer);
    const socket = new Socket(),
      client = new FleetNativeClient(socket, authority, request, viewer);
    try {
      await connectOwnerSocket(socket, path, before);
      authority.assertContext(viewer);
      sendOwnerHello(socket, 'fleet-maintenance');
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  preview(): Promise<NativeFleetPreview> {
    need(this.#step === 'preview' && !this.#pending && !this.#sent);
    const pending = this.#wait(15_000).then((value) => NativeFleetPreviewData.parse(value));
    try {
      this.#sendPreview();
    } catch (error) {
      this.close(error instanceof Error ? error : new Error('Native fleet preview unavailable'));
    }
    return pending;
  }
  migrate(request: FastifyRequest): Promise<NativeFleetMigration> {
    need(this.#step === 'viewed' && this.#previewContext && !this.#pending);
    this.assertSession(request);
    const migration = this.authority.captureFleetMigration(request, this.#previewContext);
    this.#migration = migration;
    this.#step = 'migration';
    const pending = this.#wait(migration.expiresAtEpochMs - Date.now()).then((value) =>
      NativeFleetMigrationData.parse(value)
    );
    try {
      this.#write(fleetMigrationRequest(this.authority, migration));
    } catch (error) {
      this.close(error instanceof Error ? error : new Error('Migration dispatch is unconfirmed'));
    }
    return pending;
  }
  assertSession(request: FastifyRequest): void {
    this.authority.assertFleetSession(request, this.viewer);
  }
  assertViewing(request: FastifyRequest): void {
    this.assertSession(request);
    this.#current();
    need(this.#step === 'viewed' && this.#previewContext);
    this.authority.assertContext(this.#previewContext);
  }
  assertOwnerCurrent(): void {
    this.authority.assertContext(this.#migration ?? this.viewer);
  }
  /** Copies binding DATA only; no retained context, socket or authority escapes. */
  ownerBinding(): Readonly<FleetNativeOwnerBinding> {
    return Object.freeze({
      ownerScopeDigest: this.viewer.ownerScopeDigest,
      principal: Object.freeze({ ...this.viewer.principal }),
      owner: this.viewer.owner,
    });
  }
  close(error = new Error('Original fleet outcome is unconfirmed; do not resend consent')): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#expiry);
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#untrack();
    this.socket.destroy();
  }
  #current(): void {
    need(!this.#closed && !this.socket.destroyed);
    this.assertOwnerCurrent();
  }
  #wait(maximum: number): Promise<unknown> {
    this.#current();
    need(!this.#pending && maximum > 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), Math.min(maximum, this.viewer.expiresAtEpochMs - Date.now()));
      this.#pending = { resolve, reject, timer };
    });
  }
  #write(value: unknown): void {
    this.#current();
    need(++this.#frames <= 2048);
    writeOwnerFrame(this.socket, value);
  }
  #sendPreview(): void {
    if (!this.#ready || !this.#pending || this.#sent) return;
    this.#sent = true;
    this.#write(fleetPreviewRequest(this.authority, this.viewer));
  }
  #frame(value: unknown): void {
    need(++this.#frames <= 2048 && value && typeof value === 'object' && !Array.isArray(value));
    const frame = value as Record<string, unknown>;
    if (frame.kind === 'fleet-migration-failure') {
      const failure = NativeFleetMigrationFailureData.parse(value);
      need(this.#step === 'migration' && this.#migration && this.#pending);
      need(
        failure.requestId === this.#migration.requestId && isDeepStrictEqual(failure.approval, this.#migration.approval)
      );
      this.#current();
      this.#step = 'finished';
      this.close(new NativeFleetMigrationFailureError(failure));
      return;
    }
    if (frame.kind === 'fleet-preview-owner-check' || frame.kind === 'fleet-maintenance-owner-check') {
      need(typeof frame.nonce === 'string' && !this.#nonces.has(frame.nonce));
      this.#nonces.add(frame.nonce);
      const context = frame.kind === 'fleet-preview-owner-check' ? this.viewer : this.#migration;
      need(context && (frame.kind !== 'fleet-maintenance-owner-check' || this.#step === 'migration'));
      this.#write(answerFleetChallenge(this.authority, context, value));
      return;
    }
    if (this.#step === 'preview') {
      const preview = NativeFleetPreviewData.parse(value);
      need(this.#sent && this.#pending && preview.requestId === this.viewer.requestId);
      if (preview.status !== 'awaiting-maintenance-consent') {
        this.close(new Error('Host target verification is required; no migration is available'));
        return;
      }
      this.#previewContext = this.authority.captureFleetPreview(
        this.request,
        this.viewer,
        preview.approval,
        preview.expiresAtEpochMs
      );
      this.#preview = preview;
      this.#step = 'viewed';
      this.#resolve(preview);
      return;
    }
    const result = NativeFleetMigrationData.parse(value);
    need(this.#step === 'migration' && this.#migration && this.#preview && this.#pending);
    need(
      result.requestId === this.#migration.requestId &&
        isDeepStrictEqual(result.approval, this.#migration.approval) &&
        isDeepStrictEqual(result.policy, this.#preview.policy)
    );
    need(
      new Set(result.restore.map((row) => row.employeeId)).size === result.restore.length &&
        new Set(result.restore.map((row) => row.sessionId)).size === result.restore.length
    );
    this.#current();
    this.#step = 'finished';
    this.#resolve(result);
  }
  #resolve(value: unknown): void {
    const pending = this.#pending;
    need(pending);
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }
}
