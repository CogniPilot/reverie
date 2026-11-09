/** Pure public DATA validation; no owner session, company store or host adapter. */
import { expect, it } from 'vitest';
import { FleetPreviewRequestSchema } from '../src/types/resource-fleet.js';

const employeeId = '10000000-0000-4000-8000-000000000001';
const request = {
  expectedRevision: 'revision',
  targetImageId: 'offered-image',
  policies: [{ employeeId, memoryHighMiB: 1024, memoryMaxMiB: 2048, cpuWeight: 100, perfEnabled: true }],
  pool: { memoryHighMiB: 4096, memoryMaxMiB: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  canaryEmployeeId: employeeId,
  handoff: 'Preserve your current task.',
};

it('preserves finite parent requests and distinguishes explicit unlimited high from missing or invalid values', () => {
  expect(FleetPreviewRequestSchema.parse(request)).toEqual(request);
  const unbounded = { ...request, pool: { ...request.pool, memoryHighMiB: null } };
  expect(FleetPreviewRequestSchema.parse(unbounded)).toEqual(unbounded);
  for (const memoryHighMiB of [undefined, 0, -1, 8192, Infinity, NaN]) {
    expect(FleetPreviewRequestSchema.safeParse({ ...request, pool: { ...request.pool, memoryHighMiB } }).success).toBe(
      false
    );
  }
  expect(
    FleetPreviewRequestSchema.safeParse({ ...unbounded, policies: [{ ...request.policies[0], memoryHighMiB: null }] })
      .success
  ).toBe(false);
  expect(
    FleetPreviewRequestSchema.safeParse({ ...unbounded, pool: { ...unbounded.pool, memoryMaxMiB: null } }).success
  ).toBe(false);
});

it('accepts exactly the explicit handoff ASCII whitelist at interior positions', () => {
  const whitelist =
    '\t\n\r !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  for (let byte = 0; byte < 128; byte++) {
    const character = String.fromCharCode(byte);
    const parsed = FleetPreviewRequestSchema.safeParse({ ...request, handoff: `before${character}after` });
    expect(parsed.success, `ASCII ${byte}`).toBe(whitelist.includes(character));
  }
});

it('preserves non-ASCII code units, unpaired surrogates and the original trim phase', () => {
  for (const value of ['λ', '😀', '\u0080', '\u0085', '\u00a0', '\u2028', '\u2029', '\ud800', '\udfff']) {
    const handoff = `before${value}after`;
    expect(FleetPreviewRequestSchema.parse({ ...request, handoff }).handoff).toBe(handoff);
  }
  expect(FleetPreviewRequestSchema.parse({ ...request, handoff: '\v\f  keep task\t\r\n' }).handoff).toBe('keep task');
});
