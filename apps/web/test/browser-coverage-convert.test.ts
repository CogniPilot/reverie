import { expect, it } from 'vitest';
import {
  convertOwnedSource,
  validateDerivedBranches,
  requirePinnedVersion,
  producerProvenance,
} from '../scripts/convert-browser-coverage.js';

const url = 'file:///__reverie_browser_source__/fixture.js';
const code = 'function choose(flag) { if(flag) { return 1; } else { return 2; } }\nchoose(true);';
const bodyEnd = code.indexOf('\n');
function observed(missing: 'then' | 'else') {
  const start = missing === 'then' ? code.indexOf('{ return 1; }') : code.indexOf('{ return 2; }');
  const end = start + '{ return 1; }'.length;
  return {
    scriptId: 'fixture',
    url,
    functions: [
      { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] },
      {
        functionName: 'choose',
        isBlockCoverage: true,
        ranges: [
          { startOffset: 0, endOffset: bodyEnd, count: 1 },
          { startOffset: start, endOffset: end, count: 0 },
        ],
      },
    ],
  };
}

it('keeps unvisited owned statements, functions and branches in the zero denominator', async () => {
  const result = await convertOwnedSource(code, url, []);
  expect(result.summary.statements.total).toBeGreaterThan(0);
  expect(result.summary.functions.total).toBeGreaterThan(0);
  expect(result.summary.branches.total).toBeGreaterThan(0);
  for (const metric of Object.values(result.summary)) expect(metric.covered).toBe(0);
});

it('preserves an uncovered branch and merges complementary observations by canonical source', async () => {
  const one = await convertOwnedSource(code, url, [observed('else')]);
  expect(one.summary.branches.covered).toBeLessThan(one.summary.branches.total);
  const both = await convertOwnedSource(code, url, [observed('else'), observed('then')]);
  expect(both.summary.branches.covered).toBe(both.summary.branches.total);
  expect(both.summary.branches.covered).toBeGreaterThan(one.summary.branches.covered);
  expect(both.summary.statements.total).toBe(one.summary.statements.total);
});

it('refuses unrelated URLs and out-of-source ranges instead of merging them', async () => {
  await expect(convertOwnedSource(code, url, [{ ...observed('else'), url: 'file:///other.js' }])).rejects.toThrow(
    'canonical source'
  );
  const invalid = observed('else');
  invalid.functions[0].ranges[0].endOffset = code.length + 1;
  await expect(convertOwnedSource(code, url, [invalid])).rejects.toThrow('canonical source');
});

it('refuses unverified source remapping before any converter file access', async () => {
  await expect(convertOwnedSource(code + '\n//# sourceMappingURL=/unverified.map', url, [])).rejects.toThrow(
    'separately verified remapping authority'
  );
});

it.each(['c8', 'v8', 'istanbul', 'node:coverage'])(
  'refuses %s ignore directives instead of shrinking the source denominator',
  async (provider) => {
    for (const directive of ['next', 'if', 'else', 'start', 'stop', 'file']) {
      await expect(convertOwnedSource(`/* ${provider} ignore ${directive} */\n${code}`, url, [])).rejects.toThrow(
        'ignore directives require explicit exclusion review'
      );
    }
  }
);

it('normalizes line-end sentinels and retains synthetic branch locations explicitly', async () => {
  const source = 'function maybe(value) {\n  if(value) return "🚀";\n}\nmaybe(true);';
  const result = await convertOwnedSource(source, url, []);
  expect(result.syntheticLocations).toBeGreaterThan(0);
  expect(JSON.stringify(result.file)).not.toContain('null');
  for (const loc of Object.values(result.file.statementMap)) expect(Number.isFinite(loc.end.column)).toBe(true);
});

it('retains the exact inconsistent async continuation range as an unqualified synthetic-else diagnostic', async () => {
  const source =
    'async function resume(settings) {\n const result = await Promise.resolve(settings);\n if(result) {\n  return 1;\n }\n}\nresume(true);';
  const start = source.indexOf('if(result)'),
    end = source.indexOf('{', start);
  const input = {
    scriptId: 'async',
    url,
    functions: [
      { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
      {
        functionName: 'resume',
        isBlockCoverage: true,
        ranges: [
          { startOffset: 0, endOffset: source.lastIndexOf('\nresume'), count: 1 },
          { startOffset: start, endOffset: end, count: 0 },
        ],
      },
    ],
  };
  const result = await convertOwnedSource(source, url, [input]);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ originalCount: -1, index: 1, location: { start: { line: 3 } } });
  expect(result.file.b[result.diagnostics[0].branch]).toEqual([1, 0]);
  expect(result.summary.branches.covered).toBeLessThan(result.summary.branches.total);
});

it('refuses ordinary negative counters rather than clamping them', async () => {
  const result = await convertOwnedSource(code, url, [observed('else')]);
  const file = structuredClone(result.file),
    key = Object.keys(file.b)[0];
  file.b[key][0] = -1;
  expect(() => validateDerivedBranches(file)).toThrow('negative ordinary branch');
});

it('never invents branch coverage from positive function-only V8 observations', async () => {
  const input = observed('else');
  for (const fn of input.functions) fn.isBlockCoverage = false;
  await expect(convertOwnedSource(code, url, [input])).rejects.toThrow(
    'Function-level V8 counts cannot prove branch coverage'
  );
  for (const fn of input.functions) for (const range of fn.ranges) range.count = 0;
  const zero = await convertOwnedSource(code, url, [input]);
  expect(zero.summary.branches.covered).toBe(0);
});

it('uses independent block-level observations without promoting coarse function hits to branch proof', async () => {
  const detailed = observed('else'),
    coarse = observed('then');
  for (const fn of coarse.functions) {
    fn.isBlockCoverage = false;
    fn.ranges = [{ ...fn.ranges[0], count: 100 }];
  }
  const expected = await convertOwnedSource(code, url, [detailed]);
  const mixed = await convertOwnedSource(code, url, [coarse, detailed]);
  expect(mixed.summary.branches).toEqual(expected.summary.branches);
  expect(mixed.summary.branches.covered).toBeLessThan(mixed.summary.branches.total);
});

it('rejects actual dependency version mismatches and absent lock records', () => {
  const lock = { packages: { 'node_modules/selected': { version: '1.2.3' } } };
  expect(requirePinnedVersion('selected', '1.2.3', lock)).toBe('1.2.3');
  expect(() => requirePinnedVersion('selected', '9.9.9', lock)).toThrow('differs from pinned lock');
  expect(() => requirePinnedVersion('absent', '1.2.3', lock)).toThrow('differs from pinned lock');
});

it('records exact adapter/raw-helper bytes and actual installed parser/dependency versions', () => {
  const result = producerProvenance();
  expect(result.adapterSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.rawEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.lockSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.node).toBe(process.version);
  expect(result.dependencies).toMatchObject({
    'ast-v8-to-istanbul': '1.0.3',
    '@bcoe/v8-coverage': '1.0.2',
    'istanbul-lib-coverage': '3.2.2',
  });
  expect(result.dependencies.rolldown).toBeTruthy();
});
