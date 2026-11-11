import { expect, it } from 'vitest';
import {
  convertOwnedSource,
  validateDerivedBranches,
  validateCounterMaps,
  parseConvertedCoverage,
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
  expect(result.rawProducerSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.lockSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.node).toBe(process.version);
  expect(result.dependencies).toMatchObject({
    'ast-v8-to-istanbul': '1.0.3',
    '@bcoe/v8-coverage': '1.0.2',
    'istanbul-lib-coverage': '3.2.2',
  });
  expect(result.dependencies.rolldown).toBeTruthy();
});

it.each(['s', 'f', 'b'] as const)('requires a bijection between own %s counters and source-map keys', async (group) => {
  const { file: original } = await convertOwnedSource(code, url, [observed('else')]);
  for (const defect of ['orphan', 'missing', 'substituted', 'inherited'] as const) {
    const file = structuredClone(original),
      counters = file[group];
    const key = Object.keys(counters)[0],
      value = counters[key];
    if (defect !== 'orphan') delete counters[key];
    if (defect === 'orphan' || defect === 'substituted') Reflect.set(counters, 'orphan-counter', value);
    if (defect === 'inherited') Object.setPrototypeOf(counters, { [key]: value });
    expect(() => validateCounterMaps(file), `${group}:${defect}`).toThrow('exactly matching own keys');
    expect(() => validateDerivedBranches(file), `${group}:${defect}`).toThrow('exactly matching own keys');
  }
  expect(() => validateCounterMaps(original)).not.toThrow();
});
it.each(['short', 'long'] as const)(
  'refuses %s branch counter arrays without losing their locations',
  async (defect) => {
    const { file } = await convertOwnedSource(code, url, []);
    const key = Object.keys(file.b)[0],
      locations = structuredClone(file.branchMap[key].locations);
    if (defect === 'short') file.b[key].pop();
    else file.b[key].push(0);
    expect(() => validateCounterMaps(file)).toThrow('exactly matching arity');
    expect(file.branchMap[key].locations).toEqual(locations);
  }
);

it.each(['s', 'f', 'b', 'statementMap', 'fnMap', 'branchMap'] as const)(
  'refuses raw %s descriptor/prototype normalization before schema parsing',
  async (group) => {
    const { file: original } = await convertOwnedSource(code, url, []);
    for (const defect of ['special', 'hidden', 'symbol', 'inherited', 'accessor'] as const) {
      const file = structuredClone(original),
        record = file[group];
      if (defect === 'special') Object.defineProperty(record, '__proto__', { enumerable: true, value: 99 });
      if (defect === 'hidden') Object.defineProperty(record, 'hidden-orphan', { enumerable: false, value: 99 });
      if (defect === 'symbol') Reflect.set(record, Symbol('orphan'), 99);
      if (defect === 'inherited') Object.setPrototypeOf(record, { 'inherited-orphan': 99 });
      const getter = () => {
        throw new Error('getter must not run');
      };
      if (defect === 'accessor') Object.defineProperty(record, 'getter', { enumerable: true, get: getter });
      expect(() => parseConvertedCoverage({ [file.path]: file }, file.path), `${group}:${defect}`).toThrow(
        'Unsupported raw coverage'
      );
    }
  }
);
it('refuses raw outer-map orphan keys that a record parser would remove', async () => {
  const { file } = await convertOwnedSource(code, url, []);
  const raw = { [file.path]: file };
  Object.defineProperty(raw, '__proto__', { enumerable: true, value: file });
  expect(() => parseConvertedCoverage(raw, file.path)).toThrow('Unsupported raw coverage');
  expect(parseConvertedCoverage({ [file.path]: file }, file.path)).toEqual(file);
});
it('refuses malformed raw branch arity and unsupported array keys before derived counter mutation', async () => {
  const { file: original } = await convertOwnedSource(code, url, []);
  const key = Object.keys(original.b)[0];
  for (const defect of ['arity', 'hidden', 'symbol'] as const) {
    const file = structuredClone(original);
    if (defect === 'arity') file.b[key].push(0);
    if (defect === 'hidden') Object.defineProperty(file.b[key], 'orphan', { value: 99 });
    if (defect === 'symbol') Reflect.set(file.b[key], Symbol('orphan'), 99);
    expect(() => parseConvertedCoverage({ [file.path]: file }, file.path)).toThrow(
      defect === 'arity' ? 'exactly matching arity' : 'Unsupported raw coverage array'
    );
  }
});

it.each(['counter', 'location'] as const)(
  'refuses a sparse raw branch %s instead of promoting an inherited value',
  async (target) => {
    const { file } = await convertOwnedSource(code, url, []),
      key = Object.keys(file.b)[0];
    const array = target === 'counter' ? file.b[key] : file.branchMap[key].locations;
    const index = array.length - 1,
      value = array[index];
    delete array[index];
    const original = Object.getOwnPropertyDescriptor(Array.prototype, String(index));
    try {
      Object.defineProperty(Array.prototype, String(index), { value, writable: true, configurable: true });
      expect(() => parseConvertedCoverage({ [file.path]: file }, file.path)).toThrow(
        'Unsupported raw coverage sparse array'
      );
      expect(Object.hasOwn(array, index)).toBe(false);
    } finally {
      if (original) Object.defineProperty(Array.prototype, String(index), original);
      else Reflect.deleteProperty(Array.prototype, String(index));
    }
  }
);

it.each(['statement-line', 'function-name', 'function-location', 'branch-location'] as const)(
  'never borrows inherited required nested %s metadata',
  async (target) => {
    const { file } = await convertOwnedSource(code, url, []);
    const statement = file.statementMap[Object.keys(file.statementMap)[0]],
      fn = file.fnMap[Object.keys(file.fnMap)[0]],
      branch = file.branchMap[Object.keys(file.branchMap)[0]];
    const object = target === 'statement-line' ? statement.start : target.startsWith('function') ? fn : branch;
    const property = target === 'statement-line' ? 'line' : target === 'function-name' ? 'name' : 'loc';
    const value = Reflect.get(object, property);
    Reflect.deleteProperty(object, property);
    const original = Object.getOwnPropertyDescriptor(Object.prototype, property);
    try {
      Object.defineProperty(Object.prototype, property, { value, configurable: true, writable: true });
      expect(() => parseConvertedCoverage({ [file.path]: file }, file.path)).toThrow();
    } finally {
      if (original) Object.defineProperty(Object.prototype, property, original);
      else Reflect.deleteProperty(Object.prototype, property);
    }
  }
);
it.each(['cycle', 'accessor', 'symbol', 'hidden', 'prototype', 'function'] as const)(
  'rejects unsupported %s values anywhere in nested adapter metadata',
  async (defect) => {
    const { file } = await convertOwnedSource(code, url, []);
    const fn = file.fnMap[Object.keys(file.fnMap)[0]],
      getter = () => {
        throw new Error('nested getter must not run');
      };
    if (defect === 'cycle') Reflect.set(fn, 'extra', file);
    if (defect === 'accessor') Object.defineProperty(fn.loc.start, 'extra', { enumerable: true, get: getter });
    if (defect === 'symbol') Reflect.set(fn.loc.start, 'extra', Symbol('unsupported'));
    if (defect === 'hidden') Object.defineProperty(fn.loc.start, 'extra', { value: 1 });
    if (defect === 'prototype') Object.setPrototypeOf(fn.loc.start, { line: fn.loc.start.line });
    if (defect === 'function') Reflect.set(fn, 'extra', () => 1);
    expect(() => parseConvertedCoverage({ [file.path]: file }, file.path)).toThrow('Unsupported raw coverage');
  }
);
it('supports null-prototype records, shared metadata, undefined synthetic points and Infinity sentinels', async () => {
  const { file } = await convertOwnedSource(code, url, []);
  const statement = file.statementMap[Object.keys(file.statementMap)[0]],
    fn = file.fnMap[Object.keys(file.fnMap)[0]];
  statement.end.column = Infinity;
  fn.decl = statement;
  Object.setPrototypeOf(statement.start, null);
  Reflect.set(fn, 'syntheticMetadata', { line: undefined, column: undefined });
  expect(
    parseConvertedCoverage({ [file.path]: file }, file.path).statementMap[Object.keys(file.statementMap)[0]].end.column
  ).toBe(Infinity);
});

it('keeps parsed synthetic and optional metadata free of inherited values after Zod reconstruction', async () => {
  const { file } = await convertOwnedSource('function maybe(value) {\n  if(value) return 1;\n}\nmaybe(true);', url, []);
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'line');
  try {
    Object.defineProperty(Object.prototype, 'line', { value: 7, configurable: true, writable: true });
    const parsed = parseConvertedCoverage({ [file.path]: file }, file.path);
    const fn = parsed.fnMap[Object.keys(parsed.fnMap)[0]];
    expect(Object.getPrototypeOf(fn)).toBeNull();
    if (!Object.hasOwn(fn, 'line')) expect(fn.line).toBeUndefined();
    const synthetic = Object.values(parsed.branchMap)
      .flatMap((branch) => branch.locations)
      .find((loc) => Reflect.get(loc.start, 'line') === undefined);
    expect(synthetic).toBeDefined();
    expect(Object.getPrototypeOf(synthetic!.start)).toBeNull();
    expect(Reflect.get(synthetic!.start, 'line')).toBeUndefined();
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'line', original);
    else Reflect.deleteProperty(Object.prototype, 'line');
  }
});
