/** Fixed owner-purpose controller. Default broker absence/refusal is 503;
 * no generic provider, native action, profile rewrite or legacy fallback.
 */
import {randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {z} from 'zod';
import {OwnerAuthService} from './owner-auth/service.js';
import {CompanyService} from './company-service.js';
import {PlanService} from './plan-accounts.js';
import {ChatroomService} from './chatroom-service.js';
import {PlanMoves, PlanMoveError, type PlanMoveSnapshot} from './plan-move.js';
import {PlanMoveStore} from './plan-move-store.js';
import {planMoveExecutor} from './plan-move-runtime.js';
import type {SessionPort} from './web/ports/session-port.js';
import type {TerminalMultiplexer} from './mux-interface.js';
import {ResourceOwnerAuthority, ResourceOwnerAuthorizationError, type ResourceApproval, type ResourcePreviewContext} from './resource-owner-authority.js';
import {ResourceSessionPublication} from './resource-session-publication.js';
import {ResourceNativeClient} from './resource-native-client.js';
import {ResourceReplacementRuntime} from './resource-replacement-runtime.js';

const UUID = z.string().uuid().refine(value => value === value.toLowerCase());
const Memory = z.number().int().min(512).max(1048576);
const Resources = z.object({budgetMode: z.literal('admission'), memoryMiB: Memory,
  pidsLimit: z.number().int().min(64).max(4096), cpus: z.number().finite().min(0).max(64),
  poolMemoryMiB: z.number().int().min(512).max(1048576),
  poolTasksMax: z.number().int().min(128).max(32768)}).strict();
const Draft = z.object({draftId: UUID, operationId: UUID, reservationId: UUID, targetSid: UUID,
  profileVersion: z.string().regex(/^[1-9][0-9]{0,15}$/), profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/), resources: Resources,
  sourceMemoryMiB: Memory, capacityHeld: z.literal(false), nativeEffects: z.literal(false)}).strict();
type Preview = {context: ResourcePreviewContext; approval: Readonly<ResourceApproval>;
  publication: ResourceSessionPublication; snapshot: PlanMoveSnapshot; attempted: boolean};
function need(value: unknown): asserts value {
  if (!value) throw new PlanMoveError('Protected resource replacement is unavailable or changed', 503);
}
export class ResourceReplacementController {
  readonly #authority: ResourceOwnerAuthority;
  readonly #app: FastifyInstance;
  readonly #company: CompanyService;
  readonly #plans: PlanService;
  readonly #chat: ChatroomService;
  readonly #moves: PlanMoves;
  readonly #store: PlanMoveStore;
  readonly #sessions: SessionPort;
  readonly #mux: TerminalMultiplexer;
  readonly #socket: string | undefined;
  readonly #previews = new Map<string, Preview>();
  readonly #operations = new Map<string, {owner: string | undefined; runtime: ResourceReplacementRuntime}>();
  constructor(app: FastifyInstance, auth: OwnerAuthService, company: CompanyService, plans: PlanService,
    chat: ChatroomService, moves: PlanMoves, store: PlanMoveStore, sessions: SessionPort,
    mux: TerminalMultiplexer, socket: string | undefined) {
    need(auth instanceof OwnerAuthService && company instanceof CompanyService && plans instanceof PlanService &&
      chat instanceof ChatroomService && moves instanceof PlanMoves && store instanceof PlanMoveStore);
    this.#app = app; this.#authority = new ResourceOwnerAuthority(auth); this.#company = company;
    this.#plans = plans; this.#chat = chat; this.#moves = moves; this.#store = store; this.#sessions = sessions;
    this.#mux = mux; this.#socket = socket; Object.freeze(this);
  }
  #runtime(request: FastifyRequest, context: ResourcePreviewContext | Parameters<ResourceOwnerAuthority['bind']>[0]) {
    return {company: this.#company, plans: this.#plans, chat: this.#chat, sessions: this.#sessions.sessions,
      mux: this.#mux, cleanup: this.#sessions.cleanupSession.bind(this.#sessions),
      authorized: () => {try {this.#authority.assertContext(context); return true;} catch {return false;}},
      request: async (method: 'GET' | 'POST', url: string, payload?: unknown): Promise<unknown> => {
        this.#authority.assertContext(context);
        // The resource candidate is created privately. Only normal read-only
        // session readiness fallback may use this existing server boundary.
        need(method === 'GET' && payload === undefined && /^\/api\/sessions\/[^/]+\/wait-output\?/.test(url));
        const response = await this.#app.inject({method, url, headers: {cookie: request.headers.cookie ?? '',
          host: request.headers.host ?? '', origin: String(request.headers.origin ?? '')}});
        this.#authority.assertContext(context); need(response.statusCode === 200); return response.json();
      }};
  }
  async preview(request: FastifyRequest, employeeId: string, memoryMiB: number): Promise<Readonly<Record<string, unknown>>> {
    UUID.parse(employeeId); Memory.parse(memoryMiB); const context = this.#authority.capturePreview(request, employeeId);
    need(this.#socket && this.#previews.size < 256);
    const executor = planMoveExecutor(this.#runtime(request, context), context.owner);
    const before = await executor.snapshot(employeeId, context.owner, 'runtime-refresh');
    need(!before.working && before.runtimeDigest && ['claude','codex'].includes(before.mode ?? ''));
    const native = await ResourceNativeClient.open(this.#socket, this.#authority, context);
    try {
      const draft = Draft.parse(await native.request('draft', {employeeId, memoryMiB, idempotencyKey: randomUUID()}));
      need(draft.resources.memoryMiB === memoryMiB && draft.resources.memoryMiB <= draft.resources.poolMemoryMiB);
      const after = await executor.snapshot(employeeId, context.owner, 'runtime-refresh');
      need(JSON.stringify(before) === JSON.stringify(after));
      const approval = Object.freeze({employeeId, draftId: draft.draftId, operationId: draft.operationId,
        reservationId: draft.reservationId, targetSid: draft.targetSid, profileVersion: draft.profileVersion,
        profileDigest: draft.profileDigest, previewDigest: draft.previewDigest});
      const publication = new ResourceSessionPublication(this.#authority, context, this.#company,
        this.#sessions, this.#mux, draft.targetSid);
      this.#previews.set(draft.draftId, {context, approval, publication, snapshot: after, attempted: false});
      return Object.freeze({...draft, employeeId, sourceSid: after.sessionId, account: after.account,
        sourceMode: after.mode, expiresAtEpochMs: context.expiresAtEpochMs});
    } finally {native.close();}
  }
  async apply(request: FastifyRequest, previewId: string, handoff: string): Promise<unknown> {
    UUID.parse(previewId); need(typeof handoff === 'string' && handoff.trim().length > 0 && handoff.length <= 12000 &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(handoff));
    const preview = this.#previews.get(previewId); need(preview && !preview.attempted && this.#socket);
    const context = this.#authority.capture(request, preview.approval);
    this.#authority.assertSameSession(preview.context, context);
    preview.attempted = true; // No silent replay after connection/claim uncertainty.
    const native = await ResourceNativeClient.open(this.#socket, this.#authority, context);
    try {
      const binding = this.#authority.bind(context);
      const resources = new ResourceReplacementRuntime(binding, preview.approval, native,
        preview.publication, this.#sessions, this.#company, this.#store, this.#mux);
      const executor = planMoveExecutor({...this.#runtime(request, context), resourceReplacement: resources}, context.owner);
      const snapshot = await executor.snapshot(preview.approval.employeeId, context.owner, 'runtime-refresh');
      need(JSON.stringify(snapshot) === JSON.stringify(preview.snapshot));
      this.#operations.set(preview.approval.operationId, {owner: context.owner, runtime: resources});
      return await this.#moves.begin({id: preview.approval.operationId, employeeId: preview.approval.employeeId,
        sessionId: snapshot.sessionId, fromAccount: snapshot.account, toAccount: snapshot.account,
        forceBusy: false, handoff: handoff.trim(), purpose: 'runtime-refresh', runtimeDigest: snapshot.runtimeDigest,
        resourceOwnerScope: binding.digest, resourceIntent: {operationId: preview.approval.operationId,
          reservationId: preview.approval.reservationId, profileVersion: preview.approval.profileVersion,
          profileDigest: preview.approval.profileDigest, previewDigest: preview.approval.previewDigest}},
        context.owner, executor, binding);
    } catch (error) {native.close(); throw error;}
  }
  async result(request: FastifyRequest, operationId: string): Promise<unknown> {
    UUID.parse(operationId);
    // Fresh real owner context, not the expired execution proof or its digest.
    const owner = this.#authority.requestOwner(request);
    const current = this.#operations.get(operationId);
    let record = await this.#moves.get(operationId, owner);
    need(record?.resourceIntent);
    need(this.#authority.requestOwner(request) === owner && record.owner === owner);
    if (['completed','failed','recovery-required'].includes(record.phase)) current?.runtime.close();
    if (record.phase === 'recovery-required') {
      need(this.#socket);
      const context = this.#authority.capturePreview(request, record.employeeId);
      const native = await ResourceNativeClient.open(this.#socket, this.#authority, context);
      try {
        const proof = await native.historicalCompletion(record);
        record = await this.#moves.reconcileResourceCompletion(operationId, proof, owner);
      } catch {
        // A nonterminal/unknown native result remains visible as recovery;
        // there is no retry of Apply, old handle or terminal journal write.
        need(this.#authority.requestOwner(request) === owner);
        record = await this.#moves.get(operationId, owner);
        need(record?.resourceIntent);
      } finally {native.close();}
    }
    return record;
  }
  close(): void {
    this.#authority.close(); for (const entry of this.#operations.values()) entry.runtime.close();
  }
}

export function registerResourceReplacementRoutes(app: FastifyInstance, controller: ResourceReplacementController): void {
  need(controller instanceof ResourceReplacementController);
  const execute = async (reply: {code(n: number): {send(value: unknown): unknown}}, action: () => Promise<unknown>) => {
    try {return {success: true, data: await action()};}
    catch (error) {return reply.code(error instanceof ResourceOwnerAuthorizationError ? 403 : error instanceof PlanMoveError ? error.status : 503)
      .send({success: false, errorCode: 'RESOURCE_REPLACEMENT_UNCONFIRMED_INSPECT_BEFORE_RETRY'});}
  };
  app.post('/api/company/resources/preview', async (request, reply) => {
    reply.header('Cache-Control','no-store');
    const body = z.object({employeeId: UUID, memoryMiB: Memory}).strict().parse(request.body);
    return execute(reply, () => controller.preview(request, body.employeeId, body.memoryMiB));
  });
  app.post('/api/company/resources/apply', async (request, reply) => {
    reply.header('Cache-Control','no-store');
    const body = z.object({previewId: UUID, handoff: z.string().trim().min(1).max(12000)}).strict().parse(request.body);
    return execute(reply, () => controller.apply(request, body.previewId, body.handoff));
  });
  app.post('/api/company/resources/result', async (request, reply) => {
    reply.header('Cache-Control','no-store');
    const body = z.object({operationId: UUID}).strict().parse(request.body);
    return execute(reply, () => controller.result(request, body.operationId));
  });
}
