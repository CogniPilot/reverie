import { afterEach, expect, it, vi } from 'vitest';
import * as registry from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';
import { CODEX_REASONING_EFFORTS, EFFORT_LEVELS } from '../src/types/session.js';
import { buildEffortCliArgs } from '../src/session-cli-builder.js';
import { hireEffortInput, preferredLocalModelHarness } from '../src/utils/hire-launch-selection.js';

const getCli = registry.getCli;
afterEach(() => vi.restoreAllMocks());

it('shares the exact session effort wire values with the actual engine codec', () => {
  expect(hireEffortInput('claude')).toEqual({ values: EFFORT_LEVELS });
  for (const effort of EFFORT_LEVELS)
    expect(buildEffortCliArgs(effort)).toEqual(
      effort === 'ultracode' ? ['--settings', '{"ultracode":true}'] : ['--effort', effort]
    );
  expect(hireEffortInput('codex')).toEqual({ values: CODEX_REASONING_EFFORTS, field: 'reasoningEffort' });
  expect(hireEffortInput('pi')).toMatchObject({ field: 'thinking' });
});
it('retains custom declared enum destinations without acquiring the session-level codec', () => {
  const custom = { ...structuredClone(getCli('pi')!), id: 'custom-agent' as CliEntry['id'], stock: false };
  vi.spyOn(registry, 'getCli').mockImplementation((mode) => (mode === custom.id ? custom : getCli(mode)));
  expect(hireEffortInput(custom.id)).toEqual({
    values: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    field: 'thinking',
  });
  expect(hireEffortInput('unknown-agent')).toEqual({ values: [] });
  expect(hireEffortInput('shell')).toEqual({ values: [] });
});
it('refuses copied or forged session codecs and changed stock protocols, while preserving cosmetic overrides', () => {
  const original = structuredClone(getCli('claude')!);
  const custom = { ...structuredClone(original), id: 'custom-agent' as CliEntry['id'], stock: true };
  const changed = structuredClone(original);
  changed.launch.variants[0].args[0] = { lit: 'different-program' };
  const read = vi
    .spyOn(registry, 'getCli')
    .mockImplementation((mode) => (mode === custom.id ? custom : mode === original.id ? changed : getCli(mode)));
  expect(hireEffortInput(custom.id)).toEqual({ values: [] });
  expect(hireEffortInput(original.id)).toEqual({ values: [] });
  read.mockImplementation((mode) =>
    mode === original.id ? { ...original, label: 'Owner display label' } : getCli(mode)
  );
  expect(hireEffortInput(original.id)).toEqual({ values: EFFORT_LEVELS });
});
it('validates the actual engine/config binding instead of accepting arbitrary session codec metadata', () => {
  const entry = structuredClone(getCli('claude')!);
  entry.launch.params.effortJson = { type: 'engine', source: 'sessionId' };
  expect(CliEntrySchema.safeParse(entry).success).toBe(false);
  const nested = structuredClone(getCli('claude')!);
  nested.launch.legacyConfigField = 'customConfig';
  expect(CliEntrySchema.safeParse(nested).success).toBe(false);
  expect(
    CliEntrySchema.safeParse({
      ...getCli('claude')!,
      launch: { ...getCli('claude')!.launch, effortInput: 'unknown-codec' },
    }).success
  ).toBe(false);
});
it('orders compatible local harnesses by declared preference, then custom provenance, then input order', () => {
  const preferred = getCli('opencode')!,
    first = getCli('claude')!;
  const custom = { ...structuredClone(getCli('pi')!), id: 'custom-agent' as CliEntry['id'], stock: false };
  expect(preferredLocalModelHarness([first, custom, preferred])).toBe(preferred);
  expect(preferredLocalModelHarness([first, custom])).toBe(custom);
  expect(preferredLocalModelHarness([first])).toBe(first);
  expect(preferredLocalModelHarness([])).toBeUndefined();
});
