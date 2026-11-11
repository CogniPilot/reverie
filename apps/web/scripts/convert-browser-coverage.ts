/** Prototype measurement only: no floors and no production or complete-site claim. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
import { convert } from 'ast-v8-to-istanbul';
import { parseAstAsync, viteVersion } from 'vitest/node';
import { readRawEvidence } from '../test/helpers/browser-coverage.js';

const require = createRequire(import.meta.url);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const lockSchema = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional() }).passthrough()),
});
export function requirePinnedVersion(name: string, actual: string, lock: unknown) {
  const expected = lockSchema.parse(lock).packages['node_modules/' + name]?.version;
  if (!expected || actual !== expected)
    throw new Error(`Coverage dependency version differs from pinned lock: ${name}`);
  return actual;
}
function installedPackage(name: string, specifier: string, from: string) {
  const entry = createRequire(from).resolve(specifier);
  let directory = dirname(entry);
  while (true) {
    const file = join(directory, 'package.json');
    if (existsSync(file)) {
      const metadata = z
        .object({ name: z.string().optional(), version: z.string().optional() })
        .parse(JSON.parse(readFileSync(file, 'utf8')));
      if (metadata.name === name && metadata.version) return { entry, version: metadata.version };
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Coverage dependency metadata unavailable: ${name}`);
    directory = parent;
  }
}
export function producerProvenance() {
  const lockText = readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
    lock: unknown = JSON.parse(lockText);
  const definitions = [
    ['ast-v8-to-istanbul', 'ast-v8-to-istanbul'],
    ['@bcoe/v8-coverage', '@bcoe/v8-coverage'],
    ['istanbul-lib-coverage', 'istanbul-lib-coverage'],
    ['vitest', 'vitest/node'],
  ];
  const dependencies: Record<string, string> = {};
  for (const [name, specifier] of definitions)
    dependencies[name] = requirePinnedVersion(name, installedPackage(name, specifier, import.meta.url).version, lock);
  const vitest = installedPackage('vitest', 'vitest/node', import.meta.url);
  const vite = installedPackage('vite', 'vite', pathToFileURL(vitest.entry).href);
  if (vite.version !== viteVersion) throw new Error('Loaded parser version differs from resolved Vite metadata');
  dependencies.vite = requirePinnedVersion('vite', vite.version, lock);
  dependencies.rolldown = requirePinnedVersion(
    'rolldown',
    installedPackage('rolldown', 'rolldown/parseAst', pathToFileURL(vite.entry).href).version,
    lock
  );
  return {
    adapterSha256: digest(readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    rawEvidenceSha256: digest(readFileSync(new URL('../test/helpers/browser-coverage.ts', import.meta.url), 'utf8')),
    lockSha256: digest(lockText),
    node: process.version,
    dependencies,
    parser: 'vitest/node → vite → rolldown/parseAst',
  };
}
function method(receiver: unknown, name: string, arguments_: unknown[]): unknown {
  if ((typeof receiver !== 'object' && typeof receiver !== 'function') || receiver === null)
    throw new Error(`Invalid coverage dependency object: ${name}`);
  const callable: unknown = Reflect.get(receiver, name);
  if (typeof callable !== 'function') throw new Error(`Coverage dependency method unavailable: ${name}`);
  const result: unknown = Reflect.apply(callable, receiver, arguments_);
  return result;
}
const v8Schema = z.object({
  scriptId: z.string(),
  url: z.string(),
  functions: z.array(
    z.object({
      functionName: z.string(),
      isBlockCoverage: z.boolean(),
      ranges: z
        .array(
          z.object({
            startOffset: z.number().int().nonnegative(),
            endOffset: z.number().int().nonnegative(),
            count: z.number().int().nonnegative(),
          })
        )
        .min(1),
    })
  ),
});
const point = z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() });
const location = z.object({
  start: point,
  end: point.extend({ column: z.union([z.number().int().nonnegative(), z.literal(Infinity)]) }),
});
const absentPoint = z.object({ line: z.undefined().optional(), column: z.undefined().optional() }).strict();
const branchLocation = z.union([location, z.object({ start: absentPoint, end: absentPoint }).strict()]);
const count = z.number().int().nonnegative();
const fileSchema = z.object({
  path: z.string(),
  statementMap: z.record(z.string(), location),
  fnMap: z.record(
    z.string(),
    z.object({ name: z.string(), decl: location, loc: location, line: z.number().optional() })
  ),
  branchMap: z.record(
    z.string(),
    z.object({ type: z.string(), loc: location, locations: z.array(branchLocation), line: z.number().optional() })
  ),
  s: z.record(z.string(), count),
  f: z.record(z.string(), count),
  b: z.record(z.string(), z.array(z.number().int())),
});
const metric = z.object({ total: count, covered: count, skipped: count, pct: z.number().min(0).max(100) });
const summarySchema = z.object({ lines: metric, statements: metric, functions: metric, branches: metric });
type FileCoverage = z.infer<typeof fileSchema>;
const bcoe: unknown = require('@bcoe/v8-coverage');
const istanbul: unknown = require('istanbul-lib-coverage');

export function validateDerivedBranches(file: FileCoverage) {
  const diagnostics: Array<{
    branch: string;
    index: number;
    originalCount: number;
    location: z.infer<typeof location>;
    reason: string;
  }> = [];
  for (const [key, counts] of Object.entries(file.b)) {
    for (const [index, value] of counts.entries()) {
      if (value >= 0) continue;
      const branch = file.branchMap[key],
        loc = branch?.locations[index];
      if (branch?.type !== 'if' || counts.length !== 2 || index !== 1 || !loc || location.safeParse(loc).success)
        throw new Error('Converter produced a negative ordinary branch counter');
      diagnostics.push({
        branch: key,
        index,
        originalCount: value,
        location: branch.loc,
        reason:
          'Unprovable synthetic else from inconsistent precise V8 counts; conservatively zero, denominator retained',
      });
      counts[index] = 0;
    }
  }
  return diagnostics;
}

function summarize(files: FileCoverage[]) {
  const map = method(istanbul, 'createCoverageMap', [Object.fromEntries(files.map((file) => [file.path, file]))]);
  return summarySchema.parse(method(method(map, 'getCoverageSummary', []), 'toJSON', []));
}

export async function convertOwnedSource(code: string, url: string, observations: Array<z.infer<typeof v8Schema>>) {
  if (/\b(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:next|if|else|start|stop|file)\b/i.test(code))
    throw new Error('Owned browser coverage ignore directives require explicit exclusion review');
  if (/#\s*sourceMappingURL=(.*)\s*$/m.test(code))
    throw new Error('Owned browser source maps require separately verified remapping authority');
  for (const input of observations) {
    const entry = v8Schema.parse(input);
    if (
      entry.url !== url ||
      entry.functions.some((fn) =>
        fn.ranges.some((range) => range.endOffset > code.length || range.endOffset < range.startOffset)
      )
    )
      throw new Error('Conversion input does not match canonical source offsets and URL');
  }
  const merged = observations.length
    ? v8Schema.parse(method(bcoe, 'mergeScriptCovs', [structuredClone(observations)]))
    : { scriptId: 'unvisited', url, functions: [] };
  if (merged.functions.some((fn) => !fn.isBlockCoverage && fn.ranges.some((range) => range.count > 0)))
    throw new Error('Function-level V8 counts cannot prove branch coverage');
  const converted: unknown = await convert({
    code,
    ast: parseAstAsync(code),
    coverage: { url, functions: merged.functions },
  });
  const map = z.record(z.string(), fileSchema).parse(converted);
  const expected = fileURLToPath(url);
  if (Object.keys(map).length !== 1 || !map[expected] || map[expected].path !== expected)
    throw new Error('Converter remapped canonical source to an unexpected file');
  const file = map[expected];
  const lines = code.split('\n');
  const normalize = (loc: z.infer<typeof location>) => {
    for (const side of ['start', 'end'] as const) {
      const position = loc[side],
        text = lines[position.line - 1];
      if (text === undefined || (position.column !== Infinity && position.column > text.length))
        throw new Error('Converter position exceeds verified source text');
      if (position.column === Infinity) position.column = text.length;
    }
    return loc;
  };
  for (const loc of Object.values(file.statementMap)) normalize(loc);
  for (const fn of Object.values(file.fnMap)) {
    normalize(fn.decl);
    normalize(fn.loc);
  }
  let syntheticLocations = 0;
  for (const branch of Object.values(file.branchMap)) {
    normalize(branch.loc);
    for (const loc of branch.locations) {
      const parsed = location.safeParse(loc);
      if (parsed.success) Object.assign(loc, normalize(parsed.data));
      else syntheticLocations++;
    }
  }
  if (
    Object.keys(file.statementMap).some((key) => !(key in file.s)) ||
    Object.keys(file.fnMap).some((key) => !(key in file.f)) ||
    Object.entries(file.branchMap).some(([key, branch]) => file.b[key]?.length !== branch.locations.length)
  )
    throw new Error('Converter produced incomplete counters');
  const diagnostics = validateDerivedBranches(file);
  return { file, summary: summarize([file]), syntheticLocations, diagnostics };
}

export async function convertBrowserBaseline(
  input: string,
  output: string,
  required?: { critical: string[]; iframe: string[] }
) {
  const producer = producerProvenance();
  const { summary: raw, observations, sourceCode } = readRawEvidence(input, required);
  const modules: Array<
    { id: string; asset: string; sha256: string; provenance: string; observations: number } & Awaited<
      ReturnType<typeof convertOwnedSource>
    >
  > = [];
  for (const source of raw.sources) {
    if (!['raw-authored', 'generated-first-party'].includes(source.provenance)) continue;
    const code = sourceCode.get(source.id);
    if (code === undefined) throw new Error(`Verified source snapshot unavailable: ${source.id}`);
    const name = createHash('sha256').update(source.id).digest('hex') + '.js';
    const url = pathToFileURL('/__reverie_browser_source__/' + name).href;
    const entries = observations.flatMap((observation) =>
      observation.entries
        .filter((entry) => entry.sourceId === source.id)
        .map((entry) => ({ scriptId: entry.scriptId, url, functions: entry.functions }))
    );
    const converted = await convertOwnedSource(code, url, entries);
    modules.push({
      id: source.id,
      asset: source.asset,
      sha256: source.sha256,
      provenance: source.provenance,
      observations: source.observations,
      ...converted,
    });
  }
  const report = {
    version: 1,
    revision: raw.revision,
    producer,
    observations: raw.observations,
    percentageFloorStatus: modules.some((module) => module.diagnostics.length)
      ? 'unqualified-synthetic-else-counters'
      : 'not-reviewed',
    summary: summarize(modules.map((module) => module.file)),
    groups: Object.fromEntries(
      ['raw-authored', 'generated-first-party'].map((group) => [
        group,
        summarize(modules.filter((module) => module.provenance === group).map((module) => module.file)),
      ])
    ),
    modules: modules.map(({ file, ...module }) => module),
    excluded: raw.sources
      .filter((source) => !['raw-authored', 'generated-first-party'].includes(source.provenance))
      .map((source) => ({ id: source.id, sha256: source.sha256, provenance: source.provenance })),
    limitations: [
      ...raw.limitations,
      'Prototype AST conversion of source-bound owned JavaScript only; no coverage floor or complete-site claim.',
      'Mixed, third-party and unknown sources are excluded from owned metrics and listed explicitly.',
      'Negative absent-source synthetic else counts are conservatively zero with original diagnostics and denominator retained; any such diagnostic prevents percentage-floor qualification.',
    ],
  };
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'coverage-final.json'),
    JSON.stringify(Object.fromEntries(modules.map((module) => [module.file.path, module.file])), null, 2) + '\n'
  );
  writeFileSync(join(output, 'browser-coverage-summary.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4)
      throw new Error(
        'Usage: node --import tsx scripts/convert-browser-coverage.ts <raw-directory> <output-directory>'
      );
    const report = await convertBrowserBaseline(resolve(process.argv[2]), resolve(process.argv[3]));
    console.log(
      JSON.stringify({
        prototype: true,
        percentageFloorStatus: report.percentageFloorStatus,
        diagnostics: report.modules.reduce((total, module) => total + module.diagnostics.length, 0),
        summary: report.summary,
        groups: report.groups,
        modules: report.modules.length,
        excluded: report.excluded.length,
      })
    );
  } catch (error) {
    console.error(
      `Browser coverage conversion failed: ${error instanceof z.ZodError ? JSON.stringify(error.issues.slice(0, 3)) : error instanceof Error ? error.message : 'unknown error'}`
    );
    process.exitCode = 1;
  }
}
