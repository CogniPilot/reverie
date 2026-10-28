/** Concrete normal Session + protected broker resource replacement adapter.
 * No provider callback, old claim handle, wire receipt or owner-shaped input
 * can supply one of the executing keys retained by this instance.
 */
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {CompanyService} from './company-service.js';
import {PlanMoveStore} from './plan-move-store.js';
import type {PlanMoveInput, PlanMoveRecord} from './plan-move.js';
import type {PlanMoveResourceRuntime} from './plan-move-runtime.js';
import type {planMoveLaunch} from './plan-move-launch.js';
import type {SessionPort} from './web/ports/session-port.js';
import type {TerminalMultiplexer} from './mux-interface.js';
import {ResourceNativeClient, ResourceSessionLaunchTask} from './resource-native-client.js';
import {ResourceSessionReadiness} from './resource-readiness.js';
import {ResourceSessionPublication} from './resource-session-publication.js';
import {assertResourceOperation, type ResourceApproval, type ResourceOwnerBinding} from './resource-owner-authority.js';

const UUID = z.string().uuid().refine(value => value.toLowerCase() === value);
const HEX = z.string().regex(/^[a-f0-9]{64}$/);
const Claimed = z.object({reference: UUID, sessionId: UUID, state: z.literal('PREPARING'),
  publicationIntentDigest: HEX}).strict();
function need(value: unknown): asserts value {
  if (!value) throw new Error('Protected resource replacement is unavailable or changed');
}
type Executing = {reference: string; record: Readonly<PlanMoveRecord>;
  published: Awaited<ReturnType<ResourceSessionPublication['publish']>>;
  readiness: ResourceSessionReadiness; prepared: boolean; stopped: boolean; started: boolean; verified: boolean;
  attempted: Set<string>};
function stable(record: Readonly<PlanMoveRecord>) {
  return {id: record.id, employeeId: record.employeeId, oldSession: record.oldSession, newSession: record.newSession,
    owner: record.owner, fromAccount: record.fromAccount, toAccount: record.toAccount, purpose: record.purpose,
    runtimeDigest: record.runtimeDigest, resourceIntent: record.resourceIntent, resourceOwnerScope: record.resourceOwnerScope};
}
export class ResourceReplacementRuntime implements PlanMoveResourceRuntime {
  readonly ownerAuthority: ResourceOwnerBinding;
  readonly #approval: Readonly<ResourceApproval>;
  readonly #native: ResourceNativeClient;
  readonly #publication: ResourceSessionPublication;
  readonly #sessions: SessionPort;
  readonly #company: CompanyService;
  readonly #store: PlanMoveStore;
  readonly #mux: TerminalMultiplexer;
  readonly #keys = new WeakMap<object, Executing>();
  #claimed = false;
  constructor(binding: ResourceOwnerBinding, approval: Readonly<ResourceApproval>, native: ResourceNativeClient,
    publication: ResourceSessionPublication, sessions: SessionPort, company: CompanyService,
    store: PlanMoveStore, mux: TerminalMultiplexer) {
    need(native instanceof ResourceNativeClient && publication instanceof ResourceSessionPublication &&
      company instanceof CompanyService && store instanceof PlanMoveStore);
    this.ownerAuthority = binding; this.#approval = Object.freeze({...approval}); this.#native = native;
    this.#publication = publication; this.#sessions = sessions; this.#company = company; this.#store = store;
    this.#mux = mux; Object.freeze(this);
  }
  async #current(key: object, record: Readonly<PlanMoveRecord>, verb: string, phase: string, resourcePhase: string): Promise<Executing> {
    const state = this.#keys.get(key); need(state && !state.attempted.has(verb));
    assertResourceOperation(this.ownerAuthority, record.owner, record);
    need(isDeepStrictEqual(stable(record), stable(state.record)));
    const actual = await this.#store.resourceRecord(record.id);
    assertResourceOperation(this.ownerAuthority, actual.owner, actual);
    need(isDeepStrictEqual(stable(actual), stable(state.record)) && actual.phase === phase && actual.resourcePhase === resourcePhase);
    state.attempted.add(verb); return state;
  }
  async reserve(input: Readonly<PlanMoveInput>, owner: string | undefined,
    _launch: Readonly<ReturnType<typeof planMoveLaunch>>): Promise<{sessionId: string; launchKey: object}> {
    need(!this.#claimed); this.#claimed = true;
    assertResourceOperation(this.ownerAuthority, owner, input);
    need(input.id === this.#approval.operationId && input.purpose === 'runtime-refresh' &&
      input.fromAccount === input.toAccount && !input.forceBusy && input.handoff.trim());
    const claimed = Claimed.parse(await this.#native.request('claim', {approval: this.#approval}));
    need(claimed.sessionId === this.#approval.targetSid);
    const source = this.#sessions.sessions.get(input.sessionId); need(source && source.owner === owner);
    const record: Readonly<PlanMoveRecord> = Object.freeze({id: input.id, owner, employeeId: input.employeeId,
      name: source.name, oldSession: input.sessionId, newSession: claimed.sessionId,
      fromAccount: input.fromAccount, toAccount: input.toAccount, phase: 'creating', at: Date.now(),
      purpose: 'runtime-refresh', runtimeDigest: input.runtimeDigest,
      resourceIntent: Object.freeze({...input.resourceIntent!}), resourceOwnerScope: input.resourceOwnerScope});
    const published = await this.#publication.publish(this.ownerAuthority, record, claimed.reference);
    const acknowledgement = await this.#native.request('publication', {reference: claimed.reference});
    z.object({state: z.literal('PUBLISHED_METADATA_ONLY'), verified: z.literal(false), retryAllowed: z.literal(false)})
      .strict().parse(acknowledgement);
    this.#publication.assertPublished(this.ownerAuthority, record);
    const readiness = new ResourceSessionReadiness(this.ownerAuthority, record, published.session,
      this.#sessions, this.#company, this.#store, this.#mux);
    const key = Object.freeze({}); this.#keys.set(key, {reference: claimed.reference, record, published, readiness,
      prepared: false, stopped: false, started: false, verified: false, attempted: new Set()});
    return {sessionId: claimed.sessionId, launchKey: key};
  }
  async prepare(key: object, record: Readonly<PlanMoveRecord>): Promise<void> {
    const state = await this.#current(key, record, 'prepare', 'creating', 'preparing');
    this.#publication.assertPublished(this.ownerAuthority, record);
    const value = await this.#native.request('prepare', {reference: state.reference});
    const receipt = z.object({state: z.literal('PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED'),
      operationId: z.literal(this.#approval.operationId), reservationId: z.literal(this.#approval.reservationId),
      profileDigest: z.literal(this.#approval.profileDigest)}).passthrough().parse(value);
    need(receipt.profileDigest === record.resourceIntent!.profileDigest);
    this.#publication.assertPublished(this.ownerAuthority, record); state.prepared = true;
  }
  async stopSource(key: object, record: Readonly<PlanMoveRecord>): Promise<void> {
    const state = this.#keys.get(key); need(state && state.prepared);
    // The executor intentionally passes its retained preparation record. The
    // real store, independently checked by the host too, authorizes this stop.
    const actual = await this.#store.resourceRecord(record.id);
    need(actual.sourceStopRequested === true && actual.sourceCleanupVerified !== true);
    await this.#current(key, actual, 'stop', 'stopping', 'prepared');
    const result = await this.#native.request('source-stop', {reference: state.reference});
    z.object({state: z.literal('SOURCE_RELEASED_TARGET_NOT_CREATED'), operationId: z.literal(this.#approval.operationId),
      capacityRetained: z.literal(true), retryAllowed: z.literal(false), verified: z.literal(false)}).strict().parse(result);
    assertResourceOperation(this.ownerAuthority, actual.owner, actual); state.stopped = true;
  }
  async start(key: object, record: Readonly<PlanMoveRecord>): Promise<void> {
    const state = this.#keys.get(key); need(state && state.prepared && state.stopped);
    const actual = await this.#store.resourceRecord(record.id);
    need(actual.sourceCleanupVerified === true); await this.#current(key, actual, 'start', 'starting', 'prepared');
    const task = new ResourceSessionLaunchTask(state.published.session, state.published.launch,
      this.ownerAuthority, state.record, state.reference, state.readiness);
    const result = await this.#native.request('start', {reference: state.reference}, task);
    z.object({state: z.literal('STARTED_READINESS_NOT_VERIFIED'), operationId: z.literal(this.#approval.operationId),
      reservationId: z.literal(this.#approval.reservationId), capacityRetained: z.literal(true)}).passthrough().parse(result);
    state.readiness.assertCurrent(); state.started = true;
  }
  async verify(key: object, record: Readonly<PlanMoveRecord>): Promise<() => unknown> {
    const state = await this.#current(key, record, 'verify', 'checking', 'verifying'); need(state.started);
    const result = await this.#native.request('verify', {reference: state.reference}, undefined, state.readiness);
    z.object({state: z.literal('VERIFY_RECORDED_CAPACITY_RETAINED'), operationId: z.literal(this.#approval.operationId),
      reservationId: z.literal(this.#approval.reservationId), capacityRetained: z.literal(true)}).passthrough().parse(result);
    state.readiness.assertCurrent(); state.verified = true;
    return () => {need(state.verified); assertResourceOperation(this.ownerAuthority, record.owner, record);
      state.readiness.assertCurrent();};
  }
  async finalize(key: object, record: Readonly<PlanMoveRecord>): Promise<void> {
    const state = await this.#current(key, record, 'finalize', 'completed', 'verified'); need(state.verified);
    const result = await this.#native.request('finalize', {reference: state.reference}, undefined, state.readiness);
    z.object({state: z.literal('COMPLETED_NATIVE_SETTLED'), operationId: z.literal(this.#approval.operationId),
      capacityRetained: z.literal(false), retryAllowed: z.literal(false)}).passthrough().parse(result);
  }
  close(): void {this.#native.close();} // No rollback, native stop or implicit release.
}
