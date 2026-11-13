/** Actual Rust encoder DATA parity. Fixture records grant no recovery authority. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { NativeOwnerId } from '../src/native-owner-data.js';
import {
  EmployeeRecoveryApproval,
  EmployeeRecoveryResult,
  parseEmployeeRecoveryResult,
} from '../src/employee-recovery-operation.js';

const repositoryFixture = new URL(
  '../../../crates/reverie-contracts/tests/fixtures/employee-recovery-diagnostics-v1.json',
  import.meta.url
);
const packagedFixture = new URL('./fixtures/employee-recovery-diagnostics-v1.json', import.meta.url);
const fixture = existsSync(repositoryFixture) ? repositoryFixture : packagedFixture;
// Validate without replacing the native key order. The public parser must
// accept the original wire approval, rather than a normalized test copy.
const OriginalApproval = z.custom<EmployeeRecoveryApproval>(
  (value) => EmployeeRecoveryApproval.safeParse(value).success
);
const Envelope = z
  .object({ kind: z.literal('resource-result'), requestId: NativeOwnerId, value: EmployeeRecoveryResult })
  .strict();
const cases = z
  .array(
    z
      .object({
        case: z.enum(['primary-only', 'secondary-only', 'primary-and-secondary']),
        canonicalReply: z.string(),
        reply: Envelope,
        request: z
          .object({
            kind: z.literal('resource-operation'),
            requestId: NativeOwnerId,
            verb: z.literal('employee-recovery-observe'),
            employeeId: NativeOwnerId,
            approval: OriginalApproval,
          })
          .strict(),
      })
      .strict()
  )
  .length(3)
  .parse(JSON.parse(readFileSync(fixture, 'utf8')));

it.each(cases)('decodes actual Rust $case diagnostics and retains an unconfirmed outcome', (row) => {
  expect(new Set(cases.map((entry) => entry.case)).size).toBe(3);
  const encoded = Envelope.parse(JSON.parse(row.canonicalReply));
  expect(encoded).toEqual(row.reply);
  expect(encoded.requestId).toBe(row.request.requestId);
  const result = parseEmployeeRecoveryResult(encoded.value, row.request.employeeId, row.request.approval);
  expect(result).toEqual(row.reply.value);
  expect(result.outcome).toBe('unconfirmed');
  expect(result.earlierEffects).toBe('unproved');
  expect(result.approval.sessionGeneration).toBe('9007199254740993');
  const diagnostics = result.diagnostics!;
  expect(diagnostics.primaryCode !== null).toBe(row.case !== 'secondary-only');
  expect(diagnostics.secondaryCode !== null).toBe(row.case !== 'primary-only');
});
