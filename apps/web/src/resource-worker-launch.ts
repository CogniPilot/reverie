/** Server-private normal-Session launch join; never a native execution permit. */
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import type {PlanMoveRecord} from './plan-move.js';
import {assertResourceOperation, type ResourceOwnerBinding} from './resource-owner-authority.js';

const MINT = Symbol('resource-worker-launch');
const registry = new WeakSet<object>();
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function need(value: unknown): asserts value {
  if (!value) throw new Error('Private resource worker launch is unavailable or changed');
}
export class ResourceWorkerLaunch {
  readonly #owner: string | undefined;
  readonly #binding: ResourceOwnerBinding;
  readonly #record: Readonly<PlanMoveRecord>;
  readonly #reference: string;
  #armed = false;
  #command?: Readonly<{sessionId: string; cwd: string; command: string; digest: string}>;
  constructor(token: symbol, binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>, reference: string) {
    need(token === MINT && record.newSession && UUID.test(reference));
    assertResourceOperation(binding, record.owner, record);
    need(![record.newSession, record.resourceIntent?.operationId, record.resourceIntent?.reservationId].includes(reference));
    this.#owner = record.owner; this.#binding = binding;
    this.#record = Object.freeze({...record, resourceIntent: Object.freeze({...record.resourceIntent!})});
    this.#reference = reference; registry.add(this); Object.freeze(this);
  }
  arm(reference: string): void {
    assertResourceOperation(this.#binding, this.#owner, this.#record);
    need(registry.has(this) && reference === this.#reference && !this.#armed && this.#command === undefined);
    this.#armed = true;
  }
  bindCommand(command: string, cwd: string, sessionId: string, attachOnly: boolean): string {
    assertResourceOperation(this.#binding, this.#owner, this.#record);
    need(registry.has(this) && this.#armed && !attachOnly && sessionId === this.#record.newSession && this.#command === undefined &&
      command.length > 0 && command.length <= 128*1024 && !command.includes('\0') &&
      cwd.startsWith('/') && !cwd.includes('\0'));
    const digest = createHash('sha256').update(JSON.stringify([sessionId, cwd, command])).digest('hex');
    this.#command = Object.freeze({sessionId, cwd, command, digest});
    return this.#reference;
  }
  assertCommand(digest: string, sessionId: string, cwd: string): void {
    assertResourceOperation(this.#binding, this.#owner, this.#record);
    need(registry.has(this) && this.#command && this.#command.digest === digest &&
      this.#command.sessionId === sessionId && this.#command.cwd === cwd);
  }
  [inspect.custom](): string { return '[Private resource normal-Session launch join]'; }
  toJSON(): never { throw new Error('Resource launch join is server-private'); }
}

export function resourceWorkerLaunch(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>,
  reference: string): ResourceWorkerLaunch {
  return new ResourceWorkerLaunch(MINT, binding, record, reference);
}

export function bindResourceWorkerCommand(join: ResourceWorkerLaunch, command: string, cwd: string,
  sessionId: string, attachOnly: boolean): string {
  need(join instanceof ResourceWorkerLaunch && registry.has(join));
  return ResourceWorkerLaunch.prototype.bindCommand.call(join, command, cwd, sessionId, attachOnly);
}
