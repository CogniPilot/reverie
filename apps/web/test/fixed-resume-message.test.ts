/** Synthetic metadata only; no session, credentials, model, route or effect adapter. */
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildFixedResumeMessage, FixedResumeMessageError } from '../src/fixed-resume-message.js';

const binding = {
  employeeId: 'employee:one',
  goalId: '.goal:part.1',
  goalGeneration: 2,
  sessionId: '12345678-1234-1234-1234-123456789abc',
  sessionGeneration: 3,
  transitionSequence: 4,
};
function refused(value: unknown) {
  expect(() => buildFixedResumeMessage(value)).toThrowError(FixedResumeMessageError);
  expect(() => buildFixedResumeMessage(value)).toThrowError(/^RESUME_MESSAGE_INVALID$/);
}

it('renders the one server-owned template and exact binding deterministically', () => {
  const result = buildFixedResumeMessage(binding);
  expect(result.text).toBe(
    'Continue work on your active goal in the canonical Goal service.\n' +
      'Employee: employee:one\nGoal: .goal:part.1\nGoal generation: 2\nGoal transition sequence: 4\n' +
      'Session: 12345678-1234-1234-1234-123456789abc\nSession generation: 3\n' +
      'Re-read current instructions and the canonical Goal before continuing.\n' +
      'Respect current blockers, review gates and owner decisions.'
  );
  expect(result).toEqual(buildFixedResumeMessage({ ...binding }));
  expect(result.sha256).toBe(createHash('sha256').update(result.text).digest('hex'));
  expect(result.binding).toEqual(binding);
  expect(Object.keys(result).sort()).toEqual(
    ['schemaVersion', 'purpose', 'templateVersion', 'binding', 'text', 'sha256', 'automaticAction'].sort()
  );
  expect(result.automaticAction).toBe('NONE');
});

it('copies and freezes the envelope and tuple without retaining mutable caller references', () => {
  const source = { ...binding };
  const result = buildFixedResumeMessage(source);
  source.goalId = 'different';
  expect(result.binding.goalId).toBe(binding.goalId);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.binding)).toBe(true);
});

it('keeps largest canonical IDs and safe integer generations under the fixed byte bound', () => {
  const result = buildFixedResumeMessage({
    ...binding,
    employeeId: '.' + 'e'.repeat(99),
    goalId: ':' + 'g'.repeat(99),
    goalGeneration: Number.MAX_SAFE_INTEGER,
    sessionGeneration: Number.MAX_SAFE_INTEGER,
    transitionSequence: Number.MAX_SAFE_INTEGER,
  });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024);
  expect(result.binding.employeeId).toHaveLength(100);
  expect(result.binding.goalId).toHaveLength(100);
});

it.each(['text', 'prompt', 'objective', 'template', 'urgent', 'maximumBytes', 'automaticAction'])(
  'refuses caller-supplied %s rather than letting it alter the message or envelope',
  (key) => refused({ ...binding, [key]: 'SYNTHETIC_UNTRUSTED_CONTENT' })
);

it.each(['employeeId', 'goalId'])('enforces the accepted canonical ASCII ID envelope for %s', (key) => {
  for (const value of ['', 'x'.repeat(101), 'a/b', 'a b', 'é', 'a\n', 'a\r', 'a`b'])
    refused({ ...binding, [key]: value });
  expect(buildFixedResumeMessage({ ...binding, [key]: '_.:-' }).binding[key]).toBe('_.:-');
});

it('requires exact canonical session UUID syntax', () => {
  for (const value of ['session-one', binding.sessionId.toUpperCase(), binding.sessionId + '\n', '', 1])
    refused({ ...binding, sessionId: value });
});

it.each(['goalGeneration', 'sessionGeneration', 'transitionSequence'] as const)(
  'rejects malformed numeric %s and preserves zero only for the sequence',
  (key) => {
    for (const value of [true, '1', null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      refused({ ...binding, [key]: value });
    if (key === 'transitionSequence') expect(buildFixedResumeMessage({ ...binding, [key]: 0 }).binding[key]).toBe(0);
    else refused({ ...binding, [key]: 0 });
  }
);

it('rejects absent fields, arrays, inherited fields, symbols and accessors without reading their values', () => {
  for (const input of [undefined, null, [], 'text', Object.create(binding)]) refused(input);
  const missing = { ...binding } as Record<string, unknown>;
  delete missing.goalId;
  refused(missing);
  refused({ ...binding, [Symbol('extra')]: 'synthetic' });
  const getter = vi.fn(() => {
    throw new Error('PRIVATE_SYNTHETIC_SENTINEL');
  });
  const accessors = { ...binding };
  Object.defineProperty(accessors, 'goalId', { get: getter });
  refused(accessors);
  expect(getter).not.toHaveBeenCalled();
  expect(buildFixedResumeMessage(Object.assign(Object.create(null), binding)).binding).toEqual(binding);
});

it('changes the text fingerprint for every exact binding dimension without reading goal prose', () => {
  const original = buildFixedResumeMessage(binding);
  for (const changed of [
    { employeeId: 'employee:two' },
    { goalId: 'goal:two' },
    { goalGeneration: 3 },
    { sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    { sessionGeneration: 4 },
    { transitionSequence: 5 },
  ])
    expect(buildFixedResumeMessage({ ...binding, ...changed }).sha256).not.toBe(original.sha256);
});
