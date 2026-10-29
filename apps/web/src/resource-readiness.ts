/** Current normal Session readiness on the attested owner-purpose channel.
 * This is never a kernel receipt, capacity credit or a serialized capability.
 */
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {Session} from './session.js';
import {CompanyService} from './company-service.js';
import {PlanMoveStore} from './plan-move-store.js';
import {composerReadyMark} from './cli-agent.js';
import {expertRuntimeRecipe} from './expert-runtime-recipe.js';
import {assertResourceOperation, type ResourceOwnerBinding} from './resource-owner-authority.js';
import type {SessionPort} from './web/ports/session-port.js';
import type {TerminalMultiplexer} from './mux-interface.js';
import type {PlanMoveRecord} from './plan-move.js';

export function resourceCanonicalDigest(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, ordered(entry)]));
    return item;
  };
  const raw = JSON.stringify(ordered(value)).replace(/[\u007f-\uffff]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return createHash('sha256').update(raw).digest('hex');
}
const registered = new WeakSet<object>();
function need(value: unknown): asserts value {
  if (!value) throw new Error('Current resource Session readiness is unavailable or changed');
}
function recipe(session: Session) {
  const value = structuredClone(expertRuntimeRecipe(session)); delete value.runtimeThreads;
  return JSON.parse(JSON.stringify(value));
}
function savedRecipe(value: unknown): unknown {
  need(value && typeof value === 'object' && !Array.isArray(value));
  const saved = structuredClone(value) as Record<string, unknown>; delete saved.runtimeThreads;
  return JSON.parse(JSON.stringify(saved));
}
export class ResourceSessionReadiness {
  readonly #binding: ResourceOwnerBinding;
  readonly #record: Readonly<PlanMoveRecord>;
  readonly #candidate: Session;
  readonly #sessions: SessionPort;
  readonly #company: CompanyService;
  readonly #store: PlanMoveStore;
  readonly #mux: TerminalMultiplexer;
  readonly #recipe: unknown;
  #ready?: Readonly<{pid: number; panePid: number; muxName: string; mode: string; at: number}>;
  constructor(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>, candidate: Session,
    sessions: SessionPort, company: CompanyService, store: PlanMoveStore, mux: TerminalMultiplexer) {
    assertResourceOperation(binding, record.owner, record);
    need(candidate instanceof Session && company instanceof CompanyService && store instanceof PlanMoveStore &&
      sessions.sessions.get(record.newSession!) === candidate && candidate.id === record.newSession &&
      candidate.owner === record.owner && record.purpose === 'runtime-refresh' && record.fromAccount === record.toAccount);
    this.#binding = binding; this.#record = structuredClone(record); this.#candidate = candidate;
    this.#sessions = sessions; this.#company = company; this.#store = store; this.#mux = mux;
    this.#recipe = recipe(candidate); registered.add(this); Object.freeze(this);
  }
  #alive(): void {
    need(registered.has(this)); assertResourceOperation(this.#binding, this.#record.owner, this.#record);
    const session = this.#candidate;
    const pane = this.#mux.getSession(session.id);
    need(this.#sessions.sessions.get(session.id) === session && session.owner === this.#record.owner &&
      Number.isSafeInteger(session.pid) && session.pid! > 0 && session.muxName && session.isRunning() && !session.paneDialog &&
      !this.#mux.isPaneDead(session.muxName) && pane && pane.sessionId === session.id && pane.muxName === session.muxName &&
      Number.isSafeInteger(pane.pid) && pane.pid > 1 &&
      isDeepStrictEqual(recipe(session), this.#recipe));
    const employees = this.#company.registeredEmployees().filter(row => row.id === this.#record.employeeId);
    need(employees.length === 1 && employees[0].owner === this.#record.owner &&
      employees[0].sessionId === session.id && employees[0].desiredRunning === true && !employees[0].onVacation &&
      !employees[0].bindingMigration && isDeepStrictEqual(savedRecipe(employees[0].runtimeRecipe), this.#recipe));
    assertResourceOperation(this.#binding, this.#record.owner, this.#record);
  }
  async waitUntilReady(): Promise<void> {
    need(!this.#ready); const until = Date.now() + 90_000;
    while (true) {
      this.#alive(); const mark = composerReadyMark(this.#candidate.mode); need(mark);
      const text = this.#mux.capturePaneText?.(this.#candidate.muxName!) ?? this.#candidate.getTerminalBuffer();
      if (!this.#candidate.isWorking && text.includes(mark)) {
        this.#alive();
        this.#ready = Object.freeze({pid: this.#candidate.pid!, panePid: this.#mux.getSession(this.#candidate.id)!.pid,
          muxName: this.#candidate.muxName!,
          mode: this.#candidate.mode, at: Date.now()}); return;
      }
      need(Date.now() < until); await delay(250);
    }
  }
  assertCurrent(): void {
    this.#alive(); const ready = this.#ready;
    need(ready && ready.pid === this.#candidate.pid && ready.muxName === this.#candidate.muxName &&
      ready.panePid === this.#mux.getSession(this.#candidate.id)?.pid &&
      ready.mode === this.#candidate.mode && Date.now() >= ready.at);
  }
  async proof(stage: 'verify' | 'finalize'): Promise<Readonly<Record<string, unknown>>> {
    this.assertCurrent(); const record = await this.#store.resourceRecord(this.#record.id);
    assertResourceOperation(this.#binding, record.owner, record);
    need(record.oldSession === this.#record.oldSession && record.newSession === this.#record.newSession &&
      record.fromAccount === this.#record.fromAccount && record.toAccount === this.#record.toAccount &&
      record.runtimeDigest === this.#record.runtimeDigest && record.sourceStopRequested === true &&
      record.sourceCleanupVerified === true &&
      (stage === 'verify' ? record.phase === 'checking' && record.resourcePhase === 'verifying' :
        record.phase === 'completed' && record.resourcePhase === 'verified'));
    this.assertCurrent();
    return Object.freeze({sessionId: this.#candidate.id, mode: this.#candidate.mode,
      pid: this.#candidate.pid, panePid: this.#ready!.panePid, muxName: this.#candidate.muxName,
      readyMarker: composerReadyMark(this.#candidate.mode),
      normalReadyObservedAt: this.#ready!.at,
      recipeDigest: resourceCanonicalDigest(recipe(this.#candidate)), recordDigest: resourceCanonicalDigest(record)});
  }
  toJSON(): never {throw new Error('Resource readiness producer is server-private');}
}
