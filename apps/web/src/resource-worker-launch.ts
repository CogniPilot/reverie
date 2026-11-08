/** Server-private normal-Session launch join; never a native execution permit. */
import { createHash } from 'node:crypto';
import { inspect, isDeepStrictEqual } from 'node:util';
import type { PlanMoveRecord } from './plan-move.js';
import {
  assertResourceOperation,
  assertRamResourceOperation,
  type ResourceOwnerBinding,
  type RamResourceOwnerBinding,
  type RamResourceSessionIntent,
} from './resource-owner-authority.js';

const MINT = Symbol('resource-worker-launch');
const registry = new WeakSet<object>();
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function need(value: unknown): asserts value {
  if (!value) throw new Error('Private resource worker launch is unavailable or changed');
}
type Scope =
  | { purpose: 'legacy'; binding: ResourceOwnerBinding; record: Readonly<PlanMoveRecord> }
  | { purpose: 'ram'; binding: RamResourceOwnerBinding; record: RamResourceSessionIntent };
function current(scope: Scope): void {
  if (scope.purpose === 'legacy') assertResourceOperation(scope.binding, scope.record.owner, scope.record);
  else assertRamResourceOperation(scope.binding, scope.record.owner, scope.record);
}
function target(scope: Scope): string | undefined {
  return scope.purpose === 'legacy' ? scope.record.newSession : scope.record.approval.targetSid;
}
export class ResourceWorkerLaunch {
  readonly #scope: Scope;
  readonly #reference: string;
  #armed = false;
  #command?: Readonly<{ sessionId: string; cwd: string; command: string; digest: string }>;
  constructor(token: symbol, scope: Scope, reference: string) {
    need(token === MINT && target(scope) && UUID.test(reference));
    current(scope);
    if (scope.purpose === 'ram') need(Object.isFrozen(scope.record) && Object.isFrozen(scope.record.approval));
    const identifiers =
      scope.purpose === 'legacy'
        ? [
            scope.record.newSession,
            scope.record.resourceIntent?.operationId,
            scope.record.resourceIntent?.reservationId,
          ]
        : [
            scope.record.sourceSid,
            scope.record.approval.employeeId,
            scope.record.approval.draftId,
            scope.record.approval.operationId,
            scope.record.approval.reservationId,
            scope.record.approval.targetSid,
          ];
    need(!identifiers.includes(reference));
    this.#scope =
      scope.purpose === 'legacy'
        ? Object.freeze({
            ...scope,
            record: Object.freeze({
              ...scope.record,
              resourceIntent: Object.freeze({ ...scope.record.resourceIntent! }),
            }),
          })
        : Object.freeze({ ...scope });
    this.#reference = reference;
    registry.add(this);
    Object.freeze(this);
  }
  arm(reference: string): void {
    current(this.#scope);
    need(registry.has(this) && reference === this.#reference && !this.#armed && this.#command === undefined);
    this.#armed = true;
  }
  bindCommand(command: string, cwd: string, sessionId: string, attachOnly: boolean): string {
    current(this.#scope);
    need(
      registry.has(this) &&
        this.#armed &&
        !attachOnly &&
        sessionId === target(this.#scope) &&
        this.#command === undefined &&
        command.length > 0 &&
        command.length <= 128 * 1024 &&
        !command.includes('\0') &&
        cwd.startsWith('/') &&
        !cwd.includes('\0')
    );
    const digest = createHash('sha256')
      .update(JSON.stringify([sessionId, cwd, command]))
      .digest('hex');
    this.#command = Object.freeze({ sessionId, cwd, command, digest });
    return this.#reference;
  }
  assertCommand(digest: string, sessionId: string, cwd: string): void {
    current(this.#scope);
    need(
      registry.has(this) &&
        this.#command &&
        this.#command.digest === digest &&
        this.#command.sessionId === sessionId &&
        this.#command.cwd === cwd
    );
  }
  assertRamOperation(binding: RamResourceOwnerBinding, intent: RamResourceSessionIntent): void {
    need(
      registry.has(this) &&
        this.#scope.purpose === 'ram' &&
        this.#scope.binding === binding &&
        this.#scope.record === intent
    );
    current(this.#scope);
  }
  assertLegacyOperation(binding: ResourceOwnerBinding, record: Readonly<PlanMoveRecord>): void {
    need(registry.has(this) && this.#scope.purpose === 'legacy' && this.#scope.binding === binding);
    for (const field of [
      'id',
      'owner',
      'employeeId',
      'oldSession',
      'newSession',
      'fromAccount',
      'toAccount',
      'purpose',
      'runtimeDigest',
      'resourceIntent',
      'resourceOwnerScope',
    ] as const)
      need(isDeepStrictEqual(record[field], this.#scope.record[field]));
    current(this.#scope);
  }
  [inspect.custom](): string {
    return '[Private resource normal-Session launch join]';
  }
  toJSON(): never {
    throw new Error('Resource launch join is server-private');
  }
}

export function resourceWorkerLaunch(
  binding: ResourceOwnerBinding,
  record: Readonly<PlanMoveRecord>,
  reference: string
): ResourceWorkerLaunch {
  return new ResourceWorkerLaunch(MINT, { purpose: 'legacy', binding, record }, reference);
}

/** Same private normal Session command join, with the distinct RAM approval. */
export function ramResourceWorkerLaunch(
  binding: RamResourceOwnerBinding,
  intent: RamResourceSessionIntent,
  reference: string
): ResourceWorkerLaunch {
  return new ResourceWorkerLaunch(MINT, { purpose: 'ram', binding, record: intent }, reference);
}

export function bindResourceWorkerCommand(
  join: ResourceWorkerLaunch,
  command: string,
  cwd: string,
  sessionId: string,
  attachOnly: boolean
): string {
  need(join instanceof ResourceWorkerLaunch && registry.has(join));
  return ResourceWorkerLaunch.prototype.bindCommand.call(join, command, cwd, sessionId, attachOnly);
}
