/** Pure server-owned text formatting. No authorization, persistence or submission. */
import { createHash } from 'node:crypto';

export interface FixedResumeBinding {
  readonly employeeId: string;
  readonly goalId: string;
  readonly goalGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly transitionSequence: number;
}

export interface FixedResumeMessage {
  readonly schemaVersion: 1;
  readonly purpose: 'FIXED_GOAL_RESUME';
  readonly templateVersion: 1;
  readonly binding: Readonly<FixedResumeBinding>;
  readonly text: string;
  readonly sha256: string;
  readonly automaticAction: 'NONE';
}

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const SESSION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KEYS = ['employeeId', 'goalId', 'goalGeneration', 'sessionId', 'sessionGeneration', 'transitionSequence'];
const MAX_BYTES = 1024;

export class FixedResumeMessageError extends Error {
  readonly code = 'RESUME_MESSAGE_INVALID';
  constructor() {
    super('RESUME_MESSAGE_INVALID');
    this.name = 'FixedResumeMessageError';
  }
}

/** Structure is checked, never authenticated. A returned message grants no send authority. */
export function buildFixedResumeMessage(input: unknown): Readonly<FixedResumeMessage> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FixedResumeMessageError();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new FixedResumeMessageError();
    const names = Reflect.ownKeys(input);
    if (names.length !== KEYS.length || names.some((key) => typeof key !== 'string' || !KEYS.includes(key)))
      throw new FixedResumeMessageError();
    // Do not invoke a supplied accessor while constructing the fixed payload.
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (KEYS.some((key) => !Object.hasOwn(descriptors[key]!, 'value'))) throw new FixedResumeMessageError();
    const value = (key: keyof FixedResumeBinding): unknown => descriptors[key]!.value;
    const identifier = (key: keyof FixedResumeBinding, pattern: RegExp): string => {
      const item = value(key);
      if (typeof item !== 'string' || item.includes('\n') || item.includes('\r') || !pattern.test(item))
        throw new FixedResumeMessageError();
      return item;
    };
    const integer = (key: keyof FixedResumeBinding, minimum: number): number => {
      const item = value(key);
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < minimum)
        throw new FixedResumeMessageError();
      return item;
    };
    const binding = Object.freeze({
      employeeId: identifier('employeeId', ID),
      goalId: identifier('goalId', ID),
      goalGeneration: integer('goalGeneration', 1),
      sessionId: identifier('sessionId', SESSION),
      sessionGeneration: integer('sessionGeneration', 1),
      transitionSequence: integer('transitionSequence', 0),
    });
    const text = [
      'Continue work on your active goal in the canonical Goal service.',
      `Employee: ${binding.employeeId}`,
      `Goal: ${binding.goalId}`,
      `Goal generation: ${binding.goalGeneration}`,
      `Goal transition sequence: ${binding.transitionSequence}`,
      `Session: ${binding.sessionId}`,
      `Session generation: ${binding.sessionGeneration}`,
      'Re-read current instructions and the canonical Goal before continuing.',
      'Respect current blockers, review gates and owner decisions.',
    ].join('\n');
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new FixedResumeMessageError();
    return Object.freeze({
      schemaVersion: 1,
      purpose: 'FIXED_GOAL_RESUME',
      templateVersion: 1,
      binding,
      text,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      automaticAction: 'NONE',
    });
  } catch {
    throw new FixedResumeMessageError();
  }
}
