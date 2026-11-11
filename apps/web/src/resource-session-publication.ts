/** Normal Session/CompanyService metadata join for the private resource actor.
 * No host request, owner grant, source stop or CLI start is implemented here.
 * A failed publication remains visible for protected operation reconciliation;
 * this adapter deliberately never runs generic spawn cleanup or rollback.
 */
import { isDeepStrictEqual, inspect } from 'node:util';
import { Session } from './session.js';
import { CompanyService } from './company-service.js';
import { expertRuntimeRecipe, resourceSessionSourceFacts as sourceFacts } from './expert-runtime-recipe.js';
import { EmployeeSchema } from './company-types.js';
import type { TerminalMultiplexer } from './mux-interface.js';
import type { SessionPort } from './web/ports/session-port.js';
import type { PlanMoveRecord } from './plan-move.js';
import {
  ResourceOwnerAuthority,
  assertResourceOperation,
  type ResourceOwnerBinding,
  assertRamResourceOperation,
  type RamResourceOwnerBinding,
  type RamResourceApproval,
  type RamResourcePreviewContext,
  type RamResourceSessionIntent,
  type ResourcePreviewContext,
} from './resource-owner-authority.js';
import { resourceWorkerLaunch, ramResourceWorkerLaunch, type ResourceWorkerLaunch } from './resource-worker-launch.js';
import { RamResourceSessionReadiness } from './resource-readiness.js';
import { RamResourceSessionLaunchTask } from './resource-ram-session.js';
import { accountReplacementProfile } from './utils/account-replacement-profile.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const registered = new WeakSet<object>();
function need(value: unknown): asserts value {
  if (!value) throw new Error('Approved resource Session metadata is unavailable or changed');
}
function employee(company: CompanyService, id: string) {
  const found = company.registeredEmployees().filter((row) => row.id === id);
  need(found.length === 1);
  return EmployeeSchema.parse(JSON.parse(JSON.stringify(found[0])));
}
type Scope =
  | { purpose: 'legacy'; binding: ResourceOwnerBinding; record: Readonly<PlanMoveRecord> }
  | { purpose: 'ram'; binding: RamResourceOwnerBinding; record: RamResourceSessionIntent };
function operation(scope: Scope) {
  if (scope.purpose === 'legacy') {
    const record = scope.record;
    assertResourceOperation(scope.binding, record.owner, record);
    need(record.purpose === 'runtime-refresh' && record.fromAccount === record.toAccount);
    return {
      employeeId: record.employeeId,
      oldSession: record.oldSession,
      target: record.newSession,
      owner: record.owner,
    };
  }
  const record = scope.record;
  assertRamResourceOperation(scope.binding, record.owner, record);
  return {
    employeeId: record.approval.employeeId,
    oldSession: record.sourceSid,
    target: record.approval.targetSid,
    owner: record.owner,
  };
}

/** A registered, non-authorizing pre-approval snapshot. Retains configuration
 * only in private memory; no raw environment or credentials are serialized.
 */
class SessionPublication {
  readonly #authority: ResourceOwnerAuthority;
  readonly #preview: ResourcePreviewContext | RamResourcePreviewContext;
  readonly #purpose: Scope['purpose'];
  readonly #company: CompanyService;
  readonly #sessions: SessionPort;
  readonly #mux: TerminalMultiplexer;
  readonly #source: Session;
  readonly #target: string;
  readonly #before: ReturnType<typeof employee>;
  readonly #facts: ReturnType<typeof sourceFacts>;
  readonly #saved: ReturnType<Session['toState']>;
  readonly #targetRecipe: ReturnType<typeof expertRuntimeRecipe>;
  #attempted = false;
  #published?: { session: Session; launch: ResourceWorkerLaunch };

  constructor(
    authority: ResourceOwnerAuthority,
    preview: ResourcePreviewContext | RamResourcePreviewContext,
    company: CompanyService,
    sessions: SessionPort,
    mux: TerminalMultiplexer,
    targetSid: string,
    purpose: Scope['purpose']
  ) {
    need(authority instanceof ResourceOwnerAuthority && company instanceof CompanyService);
    authority.assertContext(preview);
    need(
      preview.stage === 'preview' &&
        UUID.test(targetSid) &&
        preview.purpose === (purpose === 'legacy' ? 'resource-replacement-v1' : 'resource-ram-pool-v2')
    );
    const before = employee(company, preview.employeeId),
      source = sessions.sessions.get(before.sessionId);
    const profile = accountReplacementProfile(source?.mode);
    if (purpose === 'ram')
      need(
        Number.isSafeInteger(before.sessionGeneration) &&
          before.sessionGeneration >= 0 &&
          before.sessionGeneration < Number.MAX_SAFE_INTEGER
      );
    need(
      source instanceof Session &&
        before.owner === preview.owner &&
        !before.bindingMigration &&
        source.owner === preview.owner &&
        !source.remote &&
        !source.docker &&
        !source.getCustomModelForPersist() &&
        profile &&
        before.desiredRunning &&
        !before.onVacation &&
        targetSid !== source.id &&
        !sessions.sessions.has(targetSid)
    );
    this.#authority = authority;
    this.#purpose = purpose;
    this.#preview = preview;
    this.#company = company;
    this.#sessions = sessions;
    this.#mux = mux;
    this.#source = source;
    this.#target = targetSid;
    this.#before = before;
    this.#facts = structuredClone(sourceFacts(source));
    this.#saved = profile.freshState(source.toState());
    need(isDeepStrictEqual(this.#facts.recipe, before.runtimeRecipe));
    // Normal runtime-refresh starts a fresh provider conversation and delivers
    // the explicit handoff. Preserve settings; never resume the old consumer.
    this.#targetRecipe = profile.freshRecipe(this.#facts.recipe);
    registered.add(this);
    Object.freeze(this);
  }
  #current(scope: Scope, published = false): void {
    need(registered.has(this) && scope.purpose === this.#purpose);
    const record = operation(scope);
    if (scope.purpose === 'ram') {
      need(this.#preview.purpose === 'resource-ram-pool-v2');
      scope.binding.assertPreview(this.#authority, this.#preview);
      need(scope.record.sourceGeneration === this.#before.sessionGeneration);
    }
    need(
      record.employeeId === this.#before.id &&
        record.oldSession === this.#source.id &&
        record.target === this.#target &&
        record.owner === this.#preview.owner &&
        this.#sessions.sessions.get(this.#source.id) === this.#source &&
        isDeepStrictEqual(sourceFacts(this.#source), this.#facts) &&
        !this.#source.isWorking
    );
    const current = employee(this.#company, record.employeeId);
    const expected = structuredClone(this.#before);
    if (published) {
      expected.sessionId = this.#target;
      expected.sessionGeneration += 1;
      expected.runtimeRecipe = structuredClone(this.#targetRecipe);
    }
    need(isDeepStrictEqual(current, expected));
    if (published) {
      const candidate = this.#published?.session;
      need(
        candidate &&
          this.#sessions.sessions.get(this.#target) === candidate &&
          !candidate.pid &&
          !candidate.muxName &&
          isDeepStrictEqual(sourceFacts(candidate).recipe, this.#targetRecipe)
      );
    } else need(!this.#sessions.sessions.has(this.#target));
  }
  /** Call only after the actual private host has durably entered PREPARING.
   * That host observes this normal publication independently before config CAS.
   * UUIDs and this return value never supply a native preparation permit.
   */
  async publish(
    scope: Scope,
    launchReference: string
  ): Promise<Readonly<{ session: Session; launch: ResourceWorkerLaunch }>> {
    need(!this.#attempted);
    this.#attempted = true;
    this.#current(scope);
    const launch =
      scope.purpose === 'legacy'
        ? resourceWorkerLaunch(scope.binding, scope.record, launchReference)
        : ramResourceWorkerLaunch(scope.binding, scope.record, launchReference);
    const session = new Session({
      ...this.#saved,
      id: this.#target,
      owner: this.#preview.owner,
      mux: this.#mux,
      useMux: true,
      workerResourceLaunch: launch,
      envOverrides: structuredClone(this.#facts.env),
      claudeMode: this.#facts.claudeMode,
      allowedTools: this.#facts.allowedTools,
      niceConfig: structuredClone(this.#facts.niceConfig),
    });
    need(!session.pid && !session.muxName && isDeepStrictEqual(sourceFacts(session).recipe, this.#targetRecipe));
    this.#current(scope);
    await this.#sessions.addSession(session);
    need(this.#sessions.sessions.get(this.#target) === session);
    const record = operation(scope);
    need(
      this.#sessions.sessions.get(this.#source.id) === this.#source &&
        isDeepStrictEqual(sourceFacts(this.#source), this.#facts) &&
        isDeepStrictEqual(employee(this.#company, record.employeeId), this.#before)
    );
    this.#sessions.persistSessionStateNow(session);
    await this.#sessions.setupSessionListeners(session);
    operation(scope);
    need(
      this.#sessions.sessions.get(this.#target) === session &&
        !session.pid &&
        !session.muxName &&
        isDeepStrictEqual(sourceFacts(session).recipe, this.#targetRecipe)
    );
    await this.#company.rebind(record.employeeId, record.owner, this.#target, 'owner', undefined, {
      employee: this.#before,
      targetRecipe: this.#targetRecipe,
      resourceOperation: { ...scope, source: this.#source, sourceFacts: this.#facts },
    });
    this.#published = { session, launch };
    this.#current(scope, true);
    return Object.freeze({ session, launch });
  }
  assertPublished(scope: Scope): void {
    need(this.#attempted && this.#published);
    this.#current(scope, true);
  }
  ramIntent(binding: RamResourceOwnerBinding, approval: Readonly<RamResourceApproval>): RamResourceSessionIntent {
    need(this.#purpose === 'ram' && this.#preview.purpose === 'resource-ram-pool-v2');
    binding.assertPreview(this.#authority, this.#preview);
    const record = Object.freeze({
      purpose: 'resource-ram-pool-v2' as const,
      owner: this.#preview.owner,
      ownerScopeDigest: binding.digest,
      sourceSid: this.#source.id,
      sourceGeneration: this.#before.sessionGeneration,
      approval: Object.freeze({ ...approval }),
    });
    this.#current({ purpose: 'ram', binding, record });
    return record;
  }
  toJSON(): never {
    throw new Error('Resource Session publication is server-private');
  }
  [inspect.custom](): string {
    return '[Private resource Session metadata publication]';
  }
}

/** Existing v1 publication ABI; RAM contexts are never relabeled as v1. */
export class ResourceSessionPublication {
  readonly #publication: SessionPublication;
  constructor(
    authority: ResourceOwnerAuthority,
    preview: ResourcePreviewContext,
    company: CompanyService,
    sessions: SessionPort,
    mux: TerminalMultiplexer,
    targetSid: string
  ) {
    this.#publication = new SessionPublication(authority, preview, company, sessions, mux, targetSid, 'legacy');
    Object.freeze(this);
  }
  publish(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>, reference: string) {
    return this.#publication.publish({ purpose: 'legacy', binding, record }, reference);
  }
  assertPublished(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>): void {
    this.#publication.assertPublished({ purpose: 'legacy', binding, record });
  }
  toJSON(): never {
    throw new Error('Resource Session publication is server-private');
  }
  [inspect.custom](): string {
    return '[Private resource Session metadata publication]';
  }
}

/** Parsed native reply DATA, not an authorization or publication capability. */
export interface RamNativePublicationData {
  readonly reference: string;
  readonly sessionId: string;
  readonly state: 'PREPARING';
  readonly publicationIntentDigest: string;
}
const RAM_PUBLISHED = Symbol('ram-published-session');
export class PublishedRamResourceSession {
  readonly #publication: SessionPublication;
  readonly #scope: Extract<Scope, { purpose: 'ram' }>;
  readonly #session: Session;
  readonly #launch: ResourceWorkerLaunch;
  readonly #readiness: RamResourceSessionReadiness;
  readonly #reference: string;
  #taskIssued = false;
  constructor(
    token: symbol,
    publication: SessionPublication,
    scope: Extract<Scope, { purpose: 'ram' }>,
    session: Session,
    launch: ResourceWorkerLaunch,
    reference: string,
    sessions: SessionPort,
    company: CompanyService,
    mux: TerminalMultiplexer
  ) {
    need(token === RAM_PUBLISHED);
    publication.assertPublished(scope);
    this.#publication = publication;
    this.#scope = scope;
    this.#session = session;
    this.#launch = launch;
    this.#reference = reference;
    this.#readiness = new RamResourceSessionReadiness(scope.binding, scope.record, session, sessions, company, mux);
    Object.freeze(this);
  }
  assertPublished(binding: RamResourceOwnerBinding): void {
    need(binding === this.#scope.binding);
    this.#publication.assertPublished(this.#scope);
  }
  prepareLaunch(): RamResourceSessionLaunchTask {
    this.assertPublished(this.#scope.binding);
    need(!this.#taskIssued);
    this.#taskIssued = true;
    return new RamResourceSessionLaunchTask(
      this,
      this.#session,
      this.#launch,
      this.#scope.binding,
      this.#scope.record,
      this.#reference,
      this.#readiness
    );
  }
  assertLaunchInputs(
    binding: RamResourceOwnerBinding,
    intent: RamResourceSessionIntent,
    session: Session,
    launch: ResourceWorkerLaunch,
    reference: string
  ): void {
    need(
      this.#taskIssued &&
        binding === this.#scope.binding &&
        intent === this.#scope.record &&
        session === this.#session &&
        launch === this.#launch &&
        reference === this.#reference
    );
    this.assertPublished(binding);
  }
  readiness(): RamResourceSessionReadiness {
    assertRamResourceOperation(this.#scope.binding, this.#scope.record.owner, this.#scope.record);
    return this.#readiness;
  }
  toJSON(): never {
    throw new Error('RAM resource Session publication is server-private');
  }
}

/** Captures the real Company EID→SID/generation and Session before approval.
 * OFF/vacation or missing normal Session has no launch/publication outcome. */
export class RamResourceSessionPublication {
  readonly #publication: SessionPublication;
  readonly #sessions: SessionPort;
  readonly #company: CompanyService;
  readonly #mux: TerminalMultiplexer;
  #published?: PublishedRamResourceSession;
  constructor(
    authority: ResourceOwnerAuthority,
    preview: RamResourcePreviewContext,
    company: CompanyService,
    sessions: SessionPort,
    mux: TerminalMultiplexer,
    targetSid: string
  ) {
    this.#publication = new SessionPublication(authority, preview, company, sessions, mux, targetSid, 'ram');
    this.#sessions = sessions;
    this.#company = company;
    this.#mux = mux;
    Object.freeze(this);
  }
  async publish(
    binding: RamResourceOwnerBinding,
    approval: Readonly<RamResourceApproval>,
    claimed: RamNativePublicationData
  ): Promise<PublishedRamResourceSession> {
    const record = this.#publication.ramIntent(binding, approval);
    need(
      claimed.state === 'PREPARING' &&
        claimed.sessionId === approval.targetSid &&
        UUID.test(claimed.reference) &&
        /^[a-f0-9]{64}$/.test(claimed.publicationIntentDigest)
    );
    const scope = { purpose: 'ram' as const, binding, record };
    const { session, launch } = await this.#publication.publish(scope, claimed.reference);
    this.#published = new PublishedRamResourceSession(
      RAM_PUBLISHED,
      this.#publication,
      scope,
      session,
      launch,
      claimed.reference,
      this.#sessions,
      this.#company,
      this.#mux
    );
    return this.#published;
  }
  assertPublished(binding: RamResourceOwnerBinding, published: PublishedRamResourceSession): void {
    need(published === this.#published);
    published.assertPublished(binding);
  }
  toJSON(): never {
    throw new Error('RAM resource Session publication is server-private');
  }
}
