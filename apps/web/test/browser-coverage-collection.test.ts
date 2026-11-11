import { SYNTHETIC_BROWSER_PRODUCER } from './helpers/browser-coverage-fixtures.js';
import { RAW_BROWSER_OBSERVATION_VERSION } from './helpers/browser-coverage-producer.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Execution } from './helpers/browser-coverage-execution.js';
import {
  canonicalScript,
  provenance,
  publicFiles,
  catalogIdentity,
  readRawBaseline,
  inlineScripts,
  servedAliases,
  scriptRoutes,
  type Source,
  requireReproducedAsset,
  requireReproducedAssets,
} from './helpers/browser-coverage.js';

const code = 'function selected() { return true; } selected();';
const source: Source = {
  id: 'apps/web/src/web/public/selected.js',
  asset: '/selected.js',
  revision: 'a'.repeat(40),
  sha256: createHash('sha256').update(code).digest('hex'),
  provenance: 'raw-authored',
  kind: 'external',
  code,
  evidence: 'Synthetic source fixture',
  aliases: [],
};
const raw = (url = 'http://127.0.0.1:1234/selected.js?v=cache&credential=synthetic') => ({
  url,
  scriptId: 'fixture-script',
  source: code,
  functions: [
    { functionName: 'selected', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] },
  ],
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('canonicalizes the owned loaded script by verified bytes and never stores cache queries or origin', () => {
  const result = canonicalScript(raw(), 'http://127.0.0.1:1234', [source]);
  expect(result).toEqual({ sourceId: source.id, sha256: source.sha256, functions: raw().functions });
  expect(JSON.stringify(result)).not.toContain('credential');
  expect(JSON.stringify(result)).not.toContain('127.0.0.1');
});

it('rejects changed or unavailable first-party source bytes instead of silently accepting another version', () => {
  expect(() => canonicalScript({ ...raw(), source: code + 'changed()' }, 'http://127.0.0.1:1234', [source])).toThrow(
    'does not match'
  );
  expect(() => canonicalScript({ ...raw(), source: undefined }, 'http://127.0.0.1:1234', [source])).toThrow(
    'source text is unavailable'
  );
});

it('refuses invalid or out-of-bounds native V8 ranges at the typed boundary', () => {
  const input = raw();
  input.functions[0].ranges[0].endOffset = code.length + 1;
  expect(() => canonicalScript(input, 'http://127.0.0.1:1234', [source])).toThrow('exceeds verified source');
  input.functions[0].ranges[0].count = -1;
  expect(() => canonicalScript(input, 'http://127.0.0.1:1234', [source])).toThrow();
  expect(() => canonicalScript({ url: source.asset, functions: [] }, 'http://127.0.0.1:1234', [source])).toThrow();
});

it('validates Chromium offsets as UTF-16 units even when source contains emoji', () => {
  const unicode = 'const glyph = "🚀"; glyph;';
  const entry = { ...source, code: unicode, sha256: createHash('sha256').update(unicode).digest('hex') };
  const input = { ...raw(), source: unicode };
  input.functions[0].ranges[0].endOffset = unicode.length;
  expect(canonicalScript(input, 'http://127.0.0.1:1234', [entry])).toMatchObject({ sha256: entry.sha256 });
  input.functions[0].ranges[0].endOffset = Buffer.byteLength(unicode);
  expect(() => canonicalScript(input, 'http://127.0.0.1:1234', [entry])).toThrow('exceeds verified source');
});

it('keeps vendor, generated first-party, mixed and unresolved ownership distinct', () => {
  expect(provenance('vendor/xterm-zerolag-input.js', false)).toBe('generated-first-party');
  expect(provenance('vendor/xterm-predictive-echo.js', false)).toBe('generated-first-party');
  expect(provenance('vendor/xterm.min.js', false)).toBe('third-party');
  expect(provenance('vendor/exceljs.min.js', false)).toBe('third-party');
  expect(provenance('vendor/fflate.min.js', false)).toBe('third-party');
  expect(provenance('gesture/gesture-reverie.js', true)).toBe('mixed');
  expect(provenance('gesture/wasm/vision_wasm_internal.js', true)).toBe('third-party');
  expect(provenance('vendor/new-owned-module.js', true)).toBe('unknown');
  expect(provenance('nested/authored-module.js', true)).toBe('unknown');
  expect(provenance('selected.js', true)).toBe('raw-authored');
});

it('requires exact fresh output bytes and refuses missing or changed generated assets', () => {
  const outputs = new Map([['vendor/owned.js', code]]);
  expect(requireReproducedAsset('vendor/owned.js', code, outputs)).toBe(source.sha256);
  expect(() => requireReproducedAsset('vendor/owned.js', code + '\nchanged();', outputs)).toThrow(
    'fresh canonical output'
  );
  expect(() => requireReproducedAsset('vendor/missing.js', code, outputs)).toThrow('fresh canonical output');
});

it('requires every generated asset at preflight instead of dropping a missing asset from the catalog', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-required-assets-'));
  roots.push(root);
  mkdirSync(join(root, 'vendor'));
  const files = ['xterm-zerolag-input.js', 'xterm-predictive-echo.js', 'exceljs.min.js', 'fflate.min.js'];
  const outputs = new Map(files.map((file) => ['vendor/' + file, code]));
  for (const file of files) writeFileSync(join(root, 'vendor', file), code);
  expect(requireReproducedAssets(root, outputs).size).toBe(4);
  rmSync(join(root, 'vendor/xterm-predictive-echo.js'));
  expect(() => requireReproducedAssets(root, outputs)).toThrow(
    'Required coverage asset missing or not regular: vendor/xterm-predictive-echo.js'
  );
});

it('records external, anonymous, server-generated and unknown sources as explicit omissions', () => {
  expect(canonicalScript(raw('https://example.test/selected.js'), 'http://127.0.0.1:1234', [source])).toEqual({
    omitted: 'outside-owned-origin',
    path: 'external',
  });
  expect(canonicalScript(raw('__playwright_evaluation_script__'), 'http://127.0.0.1:1234', [source])).toEqual({
    omitted: 'anonymous-or-evaluation',
    path: 'non-url',
  });
  expect(canonicalScript(raw('http://127.0.0.1:1234/owner/setup'), 'http://127.0.0.1:1234', [source])).toEqual({
    omitted: 'server-rendered-or-unmapped',
    path: '/owner/setup',
  });
  expect(canonicalScript(raw(), 'http://127.0.0.1:1234', [{ ...source, provenance: 'unknown' }])).toEqual({
    omitted: 'unknown-provenance',
    path: '/selected.js',
  });
});

it('matches static authored inline bytes without equating injected scripts with their parent HTML', () => {
  const inline = {
    ...source,
    id: 'apps/web/src/web/public/index.html#inline-1',
    asset: '/index.html',
    kind: 'inline' as const,
  };
  expect(canonicalScript(raw('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234', [inline])).toMatchObject({
    sourceId: inline.id,
  });
  expect(
    canonicalScript({ ...raw('http://127.0.0.1:1234/'), source: 'serverInjected()' }, 'http://127.0.0.1:1234', [inline])
  ).toEqual({ omitted: 'server-injected-or-unmapped-inline', path: '/' });
});

it('extracts real inline scripts without interpreting script examples in HTML comments', () => {
  const html = '<!-- <script>example()</script> --><script id="actual">const comment = "<!-- keep -->";</script>';
  expect(inlineScripts(html)).toEqual([{ attributes: ' id="actual"', code: 'const comment = "<!-- keep -->";' }]);
});

it('derives aliases and generated script routes from actual handler declarations', () => {
  const routes = `const PAGE = 'company-plans.html'; const serve = () => readFile(join(dir, PAGE)); const redirect = () => reply.redirect('/'); app.get('/company/plans', serve); app.get('/plans', redirect);`;
  expect(servedAliases(routes)).toEqual({ 'company-plans.html': ['/company/plans'] });
  expect(servedAliases(routes.replace('/company/plans', '/new/plans'))).toEqual({
    'company-plans.html': ['/new/plans'],
  });
  expect(
    scriptRoutes(
      `app.get('/owner/code.js', (_, reply) => reply.send(OWNER_SCRIPT)); app.get('/other', unrelated);`,
      'OWNER_SCRIPT'
    )
  ).toEqual(['/owner/code.js']);
  const inline = {
    ...source,
    id: 'apps/web/src/web/public/company-plans.html#inline-1',
    asset: '/company-plans.html',
    aliases: ['/company/plans'],
    kind: 'inline' as const,
  };
  expect(
    canonicalScript(raw('http://127.0.0.1:1234/company/plans?embedded=1'), 'http://127.0.0.1:1234', [inline])
  ).toMatchObject({ sourceId: inline.id });
});

it('discovers nested JavaScript and module files without treating them as visited', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-source-catalog-'));
  roots.push(root);
  mkdirSync(join(root, 'nested'));
  for (const file of ['top.js', 'nested/module.mjs', 'nested/compat.cjs', 'index.html', 'ignored.css'])
    writeFileSync(join(root, file), 'fixture');
  expect(publicFiles(root).map((file) => file.slice(root.length + 1))).toEqual([
    'index.html',
    'nested/compat.cjs',
    'nested/module.mjs',
    'top.js',
  ]);
});

it('refuses source symlinks rather than following them outside the inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-source-link-'));
  roots.push(root);
  writeFileSync(join(root, 'original.js'), code);
  symlinkSync(join(root, 'original.js'), join(root, 'alias.js'));
  expect(() => publicFiles(root)).toThrow('source symlink');
});

function execution(kind: 'main' | 'iframe'): Execution {
  return {
    state: 'attributed',
    kind,
    scriptId: 'fixture-script',
    sourceSha256: source.sha256,
    contextId: kind === 'main' ? 1 : 2,
    generation: 0,
    frameId: kind === 'main' ? 'main' : 'child',
    mainFrameId: 'main',
    ancestry: kind === 'main' ? ['main'] : ['child', 'main'],
  };
}

function baselineFixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-baseline-'));
  roots.push(root);
  for (const folder of ['catalogs', 'sources', 'observations']) mkdirSync(join(root, folder));
  const { code: text, ...metadata } = source;
  const catalog = {
    version: 1,
    sources: [{ ...metadata, codeLength: text.length, bytes: Buffer.byteLength(text) }],
    limitations: ['Synthetic unit fixture'],
  };
  const id = catalogIdentity(catalog.sources);
  writeFileSync(join(root, 'catalogs', id + '.json'), JSON.stringify(catalog));
  writeFileSync(join(root, 'sources', source.sha256 + '.js'), text);
  const observation = {
    version: RAW_BROWSER_OBSERVATION_VERSION,
    producer: structuredClone(SYNTHETIC_BROWSER_PRODUCER),
    catalogId: id,
    fixture: 'synthetic unit',
    fixtureSources: { 'fixture.ts': 'b'.repeat(64) },
    entries: [] as Array<{
      sourceId: string;
      sha256: string;
      scriptId: string;
      functions: ReturnType<typeof raw>['functions'];
      execution: Execution;
    }>,
    omitted: [],
    frameGaps: [],
  };
  const save = (file = 'one.json') => writeFileSync(join(root, 'observations', file), JSON.stringify(observation));
  return { root, catalog, observation, save };
}

it('keeps unvisited owned scripts as zero execution and requires real module and iframe evidence', () => {
  const { root, observation, save } = baselineFixture();
  save();
  const options = { critical: [] as string[], iframe: [] as string[] };
  expect(readRawBaseline(root, options).unvisitedOwned).toEqual([source.id]);
  expect(readRawBaseline(root, options).sources[0]).toMatchObject({ observations: 0, executed: false });
  expect(() => readRawBaseline(root, { critical: ['/selected.js'], iframe: [] })).toThrow('was not executed');
  observation.entries.push({
    sourceId: source.id,
    sha256: source.sha256,
    scriptId: 'fixture-script',
    functions: raw().functions,
    execution: execution('main'),
  });
  save();
  expect(() => readRawBaseline(root, { critical: [], iframe: ['/selected.js'] })).toThrow(
    'iframe JavaScript coverage was not collected'
  );
  observation.entries[0].execution = execution('iframe');
  save();
  expect(readRawBaseline(root, { critical: ['/selected.js'], iframe: ['/selected.js'] }).unvisitedOwned).toEqual([]);
});

it('refuses mixed fixture identities and source corruption instead of merging incompatible reports', () => {
  const { root, observation, save } = baselineFixture();
  save();
  observation.fixtureSources['fixture.ts'] = 'c'.repeat(64);
  save('two.json');
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow('mixes fixture source revisions');
  rmSync(join(root, 'observations', 'two.json'));
  writeFileSync(join(root, 'sources', source.sha256 + '.js'), 'corrupt');
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow('snapshot is corrupt');
});

it('does not turn main execution plus zero-count iframe parsing into iframe execution', () => {
  const { root, observation, save } = baselineFixture();
  observation.entries.push({
    sourceId: source.id,
    sha256: source.sha256,
    scriptId: 'fixture-script',
    functions: raw().functions,
    execution: execution('main'),
  });
  const zero = raw().functions;
  zero[0].ranges[0].count = 0;
  observation.entries.push({
    sourceId: source.id,
    sha256: source.sha256,
    scriptId: 'fixture-script',
    functions: zero,
    execution: execution('iframe'),
  });
  save();
  const summary = readRawBaseline(root, { critical: ['/selected.js'], iframe: [] });
  expect(summary.sources[0].frameKinds).toEqual(['main']);
  expect(() => readRawBaseline(root, { critical: [], iframe: ['/selected.js'] })).toThrow(
    'iframe JavaScript coverage was not collected'
  );
});

it('does not qualify a positive zero-length range as executed bytes in any frame', () => {
  const { root, observation, save } = baselineFixture();
  const empty = raw().functions;
  empty[0].ranges[0].endOffset = 0;
  observation.entries.push({
    sourceId: source.id,
    sha256: source.sha256,
    scriptId: 'fixture-script',
    functions: empty,
    execution: execution('iframe'),
  });
  save();
  expect(readRawBaseline(root, { critical: [], iframe: [] }).sources[0]).toMatchObject({
    executed: false,
    frameKinds: [],
  });
  expect(() => readRawBaseline(root, { critical: ['/selected.js'], iframe: [] })).toThrow('was not executed');
  expect(() => readRawBaseline(root, { critical: [], iframe: ['/selected.js'] })).toThrow(
    'iframe JavaScript coverage was not collected'
  );
});

it('checks declared UTF-16 and byte lengths against the verified snapshot', () => {
  const { root, catalog, save } = baselineFixture();
  save();
  rmSync(join(root, 'catalogs'), { recursive: true });
  mkdirSync(join(root, 'catalogs'));
  catalog.sources[0].codeLength++;
  writeFileSync(join(root, 'catalogs', catalogIdentity(catalog.sources) + '.json'), JSON.stringify(catalog));
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow('lengths conflict with verified snapshot');
  catalog.sources[0].codeLength--;
  catalog.sources[0].bytes++;
  rmSync(join(root, 'catalogs'), { recursive: true });
  mkdirSync(join(root, 'catalogs'));
  writeFileSync(join(root, 'catalogs', catalogIdentity(catalog.sources) + '.json'), JSON.stringify(catalog));
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow('lengths conflict with verified snapshot');
});

it('refuses duplicate source IDs and conflicting metadata even when the source SHA is unchanged', () => {
  const { root, catalog, save } = baselineFixture();
  save();
  const changed = structuredClone(catalog);
  changed.sources[0].provenance = 'mixed';
  writeFileSync(join(root, 'catalogs', catalogIdentity(changed.sources) + '.json'), JSON.stringify(changed));
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow('metadata conflicts');
  rmSync(join(root, 'catalogs'), { recursive: true });
  mkdirSync(join(root, 'catalogs'));
  catalog.sources.push({ ...catalog.sources[0] });
  writeFileSync(join(root, 'catalogs', catalogIdentity(catalog.sources) + '.json'), JSON.stringify(catalog));
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow('Duplicate source ID');
});

it('refuses unversioned legacy producer evidence rather than fabricating a browser identity', () => {
  const { root, observation, save } = baselineFixture();
  Reflect.set(observation, 'version', 2);
  save();
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow();
  Reflect.set(observation, 'version', RAW_BROWSER_OBSERVATION_VERSION);
  Reflect.deleteProperty(observation, 'producer');
  save();
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow();
});
it('refuses mixed runtime producers even with matching source and fixture identities', () => {
  const { root, observation, save } = baselineFixture();
  save();
  observation.producer.chromium.jsVersion = 'different-v8';
  save('two.json');
  expect(() => readRawBaseline(root, { critical: [], iframe: [] })).toThrow('mixes runtime producer identities');
});
it('retains recorded producer metadata while explicitly declining semantic qualification', () => {
  const { root, save } = baselineFixture();
  save();
  const summary = readRawBaseline(root, { critical: [], iframe: [] });
  expect(summary.producer).toEqual(SYNTHETIC_BROWSER_PRODUCER);
  expect(summary.producerQualification).toBe('runtime-recorded-not-semantically-qualified');
});
