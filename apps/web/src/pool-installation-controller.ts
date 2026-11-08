/** Thin authenticated API over one original native B conversation. Explicit
 * account enrollment is separate from OS nomination and native consent.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OwnerAuthService } from './owner-auth/service.js';
import { OWNER_COOKIE } from './owner-auth/policy.js';
import { ResourceOwnerAuthority, ResourceOwnerAuthorizationError } from './resource-owner-authority.js';
import { PoolInstallationNativeClient, type PoolInstallationView } from './pool-installation-native-client.js';

const ID = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const Consent = z
  .object({ consent: z.literal(true), offerNonce: ID, requestDigest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
type Entry = {
  client: PoolInstallationNativeClient;
  view: PoolInstallationView;
  attempted: boolean;
  state: 'viewed' | 'pending' | 'settled' | 'unknown';
  result?: unknown;
};
export class PoolInstallationController {
  readonly #authority: ResourceOwnerAuthority;
  readonly #views = new Map<string, Entry>();
  #opening = false;
  constructor(
    private readonly auth: OwnerAuthService,
    private readonly socket: string | undefined
  ) {
    this.#authority = new ResourceOwnerAuthority(auth);
  }
  async enroll(request: FastifyRequest) {
    this.#authority.requestOwner(request);
    z.object({ enroll: z.literal(true) }).strict().parse(request.body);
    return this.auth.enrollRegistrationIdentity(request.cookies?.[OWNER_COOKIE]);
  }
  async view(request: FastifyRequest): Promise<PoolInstallationView> {
    // Authentication precedes even checking configuration, and native client
    // independently checks the real cookie before opening its B connection.
    this.#authority.capturePoolInstallationViewer(request);
    if (
      request.body !== undefined &&
      (!request.body ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length)
    )
      throw new Error('Installation view takes no caller selection');
    if (!this.socket)
      throw new Error('Native worker installation is not configured; complete the supported OS bootstrap');
    for (const entry of this.#views.values()) {
      if (!entry.attempted && Date.now() < entry.view.expiresAtEpochMs) {
        entry.client.assertViewing(request);
        return entry.view;
      }
    }
    if (this.#opening || [...this.#views.values()].some((entry) => entry.attempted && entry.state !== 'settled'))
      throw new Error('An installation is in progress or retained; inspect its original outcome');
    for (const [id, entry] of this.#views) {
      if (!entry.attempted && Date.now() >= entry.view.expiresAtEpochMs) {
        entry.client.close();
        this.#views.delete(id);
      }
    }
    if (this.#views.size >= 16) throw new Error('Installation views are full; inspect existing setup');
    this.#opening = true;
    let client: PoolInstallationNativeClient | undefined;
    try {
      client = await PoolInstallationNativeClient.open(this.socket, this.#authority, request);
      const view = await client.view();
      this.#views.set(view.requestId, { client, view, attempted: false, state: 'viewed' });
      return view;
    } catch (error) {
      client?.close();
      throw error;
    } finally {
      this.#opening = false;
    }
  }
  async consent(request: FastifyRequest, id: string): Promise<unknown> {
    this.#authority.capturePoolInstallationViewer(request);
    ID.parse(id);
    const entry = this.#views.get(id);
    if (!entry) throw new Error('Original installation view unavailable; no consent was replayed');
    entry.client.assertSession(request);
    const body = Consent.parse(request.body);
    if (body.offerNonce !== entry.view.offerNonce || body.requestDigest !== entry.view.requestDigest || entry.attempted)
      throw new Error('Installation consent changed or was already attempted');
    entry.attempted = true;
    entry.state = 'pending'; // Before any dispatch.
    try {
      entry.result = await entry.client.consent(request);
      const result = entry.result as Record<string, unknown>;
      entry.state =
        result.phase === 'pool-configured' &&
        result.observed !== null &&
        typeof result.observed === 'object' &&
        !Array.isArray(result.observed)
          ? 'settled'
          : 'unknown';
      return this.result(request, id);
    } catch (error) {
      entry.state = 'unknown';
      throw error;
    }
  }
  result(request: FastifyRequest, id: string): unknown {
    this.#authority.capturePoolInstallationViewer(request);
    ID.parse(id);
    const entry = this.#views.get(id);
    if (!entry) throw new Error('Installation history is unavailable; absence is not a completed result');
    entry.client.assertSession(request);
    return {
      viewId: id,
      state: entry.state,
      blocksFurtherChanges: entry.state === 'pending' || entry.state === 'unknown',
      result: entry.result ?? null,
    };
  }
  close(): void {
    for (const entry of this.#views.values()) entry.client.close();
    this.#authority.close();
  }
}
export function registerPoolInstallationRoutes(app: FastifyInstance, controller: PoolInstallationController): void {
  const prefix = '/api/company/resources/fleet/installation';
  const status = (error: unknown) =>
    error instanceof ResourceOwnerAuthorizationError
      ? 403
      : error instanceof Error && 'status' in error && (error.status === 403 || error.status === 409)
        ? error.status
        : 503;
  app.post(prefix + '/enroll', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { success: true, data: await controller.enroll(request) };
    } catch (error) {
      return reply.code(status(error)).send({
        success: false,
        error: error instanceof Error ? error.message : 'Account enrollment unavailable',
      });
    }
  });
  app.post(prefix + '/view', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { success: true, data: await controller.view(request) };
    } catch (error) {
      return reply
        .code(status(error))
        .send({ success: false, error: error instanceof Error ? error.message : 'Native installation unavailable' });
    }
  });
  app.post<{ Params: { viewId: string } }>(prefix + '/:viewId/consent', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { success: true, data: await controller.consent(request, request.params.viewId) };
    } catch (error) {
      return reply
        .code(status(error))
        .send({
          success: false,
          error: error instanceof Error ? error.message : 'Original installation outcome retained',
        });
    }
  });
  app.post<{ Params: { viewId: string } }>(prefix + '/:viewId/result', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { success: true, data: controller.result(request, request.params.viewId) };
    } catch (error) {
      return reply
        .code(status(error))
        .send({ success: false, error: error instanceof Error ? error.message : 'Installation history unavailable' });
    }
  });
}
