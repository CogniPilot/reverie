/** Normal Session/CompanyService metadata join for the private resource actor.
 * No host request, owner grant, source stop or CLI start is implemented here.
 * A failed publication remains visible for protected operation reconciliation;
 * this adapter deliberately never runs generic spawn cleanup or rollback.
 */
import {isDeepStrictEqual, inspect} from 'node:util';
import {Session} from './session.js';
import {CompanyService} from './company-service.js';
import {expertRuntimeRecipe} from './expert-runtime-recipe.js';
import {EmployeeSchema} from './company-types.js';
import type {TerminalMultiplexer} from './mux-interface.js';
import type {SessionPort} from './web/ports/session-port.js';
import type {PlanMoveRecord} from './plan-move.js';
import {ResourceOwnerAuthority, assertResourceOperation, type ResourceOwnerBinding,
  type ResourcePreviewContext} from './resource-owner-authority.js';
import {resourceWorkerLaunch, type ResourceWorkerLaunch} from './resource-worker-launch.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const registered = new WeakSet<object>();
function need(value: unknown): asserts value {
  if (!value) throw new Error('Approved resource Session metadata is unavailable or changed');
}
function employee(company: CompanyService, id: string) {
  const found = company.registeredEmployees().filter(row => row.id === id);
  need(found.length === 1);
  return EmployeeSchema.parse(JSON.parse(JSON.stringify(found[0])));
}
function sourceFacts(source: Session) {
  return {
    recipe: JSON.parse(JSON.stringify(expertRuntimeRecipe(source))) as ReturnType<typeof expertRuntimeRecipe>,
    owner: source.owner, pid: source.pid, muxName: source.muxName,
    claudeMode: source.claudeMode, allowedTools: source.allowedTools,
    niceConfig: source.niceConfig, env: source.getEnvOverridesForPersist() ?? {},
  };
}

/** A registered, non-authorizing pre-approval snapshot. Retains configuration
 * only in private memory; no raw environment or credentials are serialized.
 */
export class ResourceSessionPublication {
  readonly #preview: ResourcePreviewContext;
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
  #published?: {session: Session; launch: ResourceWorkerLaunch};

  constructor(authority: ResourceOwnerAuthority, preview: ResourcePreviewContext,
    company: CompanyService, sessions: SessionPort, mux: TerminalMultiplexer, targetSid: string) {
    need(authority instanceof ResourceOwnerAuthority && company instanceof CompanyService);
    authority.assertContext(preview);
    need(preview.stage === 'preview' && UUID.test(targetSid));
    const before = employee(company, preview.employeeId), source = sessions.sessions.get(before.sessionId);
    need(source instanceof Session && source.owner === preview.owner && !source.remote && !source.docker &&
      !source.getCustomModelForPersist() && ['claude', 'codex'].includes(source.mode) &&
      before.desiredRunning && !before.onVacation && targetSid !== source.id && !sessions.sessions.has(targetSid));
    this.#preview = preview; this.#company = company;
    this.#sessions = sessions; this.#mux = mux; this.#source = source; this.#target = targetSid;
    this.#before = before; this.#facts = structuredClone(sourceFacts(source));
    this.#saved = structuredClone(source.toState());
    need(isDeepStrictEqual(this.#facts.recipe, before.runtimeRecipe));
    // Normal runtime-refresh starts a fresh provider conversation and delivers
    // the explicit handoff. Preserve settings; never resume the old consumer.
    delete this.#saved.resumeSessionId;
    delete this.#saved.runtimeThreads;
    delete this.#saved.claudeSessionChain;
    delete this.#saved.claudeSessionIdPending;
    if (this.#saved.mode === 'codex' && this.#saved.codexConfig) delete this.#saved.codexConfig.resumeSessionId;
    this.#targetRecipe = structuredClone(this.#facts.recipe);
    this.#targetRecipe.runtimeThreads = {};
    if (this.#targetRecipe.mode === 'codex' && this.#targetRecipe.configs.codexConfig)
      delete this.#targetRecipe.configs.codexConfig.resumeSessionId;
    registered.add(this); Object.freeze(this);
  }
  #current(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>, published = false): void {
    need(registered.has(this));
    assertResourceOperation(binding, record.owner, record);
    need(record.employeeId === this.#before.id && record.oldSession === this.#source.id &&
      record.newSession === this.#target && record.owner === this.#preview.owner &&
      record.purpose === 'runtime-refresh' && record.fromAccount === record.toAccount &&
      this.#sessions.sessions.get(this.#source.id) === this.#source &&
      isDeepStrictEqual(sourceFacts(this.#source), this.#facts) && !this.#source.isWorking);
    const current = employee(this.#company, record.employeeId);
    const expected = structuredClone(this.#before);
    if (published) {expected.sessionId = this.#target; expected.sessionGeneration += 1;
      expected.runtimeRecipe = structuredClone(this.#targetRecipe);}
    need(isDeepStrictEqual(current, expected));
    if (published) {
      const candidate = this.#published?.session;
      need(candidate && this.#sessions.sessions.get(this.#target) === candidate && !candidate.pid &&
        !candidate.muxName && isDeepStrictEqual(sourceFacts(candidate).recipe, this.#targetRecipe));
    } else need(!this.#sessions.sessions.has(this.#target));
  }
  /** Call only after the actual private host has durably entered PREPARING.
   * That host observes this normal publication independently before config CAS.
   * UUIDs and this return value never supply a native preparation permit.
   */
  async publish(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>, launchReference: string):
    Promise<Readonly<{session: Session; launch: ResourceWorkerLaunch}>> {
    need(!this.#attempted); this.#attempted = true;
    this.#current(binding, record);
    const launch = resourceWorkerLaunch(binding, record, launchReference);
    const session = new Session({...this.#saved, id: this.#target, owner: this.#preview.owner,
      mux: this.#mux, useMux: true, workerResourceLaunch: launch,
      envOverrides: structuredClone(this.#facts.env), claudeMode: this.#facts.claudeMode,
      allowedTools: this.#facts.allowedTools, niceConfig: structuredClone(this.#facts.niceConfig)});
    need(!session.pid && !session.muxName && isDeepStrictEqual(sourceFacts(session).recipe, this.#targetRecipe));
    this.#current(binding, record);
    await this.#sessions.addSession(session);
    need(this.#sessions.sessions.get(this.#target) === session);
    assertResourceOperation(binding, record.owner, record);
    need(this.#sessions.sessions.get(this.#source.id) === this.#source &&
      isDeepStrictEqual(sourceFacts(this.#source), this.#facts) &&
      isDeepStrictEqual(employee(this.#company, record.employeeId), this.#before));
    this.#sessions.persistSessionStateNow(session);
    await this.#sessions.setupSessionListeners(session);
    assertResourceOperation(binding, record.owner, record);
    need(this.#sessions.sessions.get(this.#target) === session && !session.pid && !session.muxName &&
      isDeepStrictEqual(sourceFacts(session).recipe, this.#targetRecipe));
    await this.#company.rebind(record.employeeId, record.owner, this.#target, 'owner', undefined,
      {employee: this.#before, targetRecipe: this.#targetRecipe});
    this.#published = {session, launch};
    this.#current(binding, record, true);
    return Object.freeze({session, launch});
  }
  assertPublished(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>): void {
    need(this.#attempted && this.#published); this.#current(binding, record, true);
  }
  toJSON(): never {throw new Error('Resource Session publication is server-private');}
  [inspect.custom](): string {return '[Private resource Session metadata publication]';}
}
