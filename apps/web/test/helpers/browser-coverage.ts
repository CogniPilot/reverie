/** Actual Chromium coverage; no application request or provider is simulated. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import ts from 'typescript';
import type { Browser, BrowserContext, Page } from 'playwright';
import { OWNER_SCRIPT } from '../../src/owner-auth/pages.js';
import { ExecutionTracker, executionSchema, type Execution } from './browser-coverage-execution.js';

export type Provenance = 'raw-authored' | 'generated-first-party' | 'mixed' | 'third-party' | 'unknown';
export type Source = {
  id: string;
  asset: string;
  sha256: string;
  revision: string;
  provenance: Provenance;
  kind: 'external' | 'inline';
  code: string;
  evidence: string;
  aliases: string[];
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : item
  );
export const catalogIdentity = (sources: unknown[]) => hash(stable(sources));
const posix = (path: string) => path.split(sep).join('/');
const generated = new Set(['vendor/xterm-zerolag-input.js', 'vendor/xterm-predictive-echo.js']);
const thirdParty = new Set([
  'vendor/dompurify.min.js',
  'vendor/embassy-qr-code.min.js',
  'vendor/embassy-qr-scan.min.js',
  'vendor/highlight-11.12.0.min.js',
  'vendor/katex-0.19.0/katex.min.js',
  'vendor/marked.min.js',
  'vendor/pdfjs-6.4.299/wasm/jbig2_nowasm_fallback.js',
  'vendor/pdfjs-6.4.299/wasm/openjpeg_nowasm_fallback.js',
  'vendor/pdfjs-6.4.299/pdf.mjs',
  'vendor/pdfjs-6.4.299/pdf.worker.mjs',
  'vendor/xterm.min.js',
  'vendor/xterm-addon-fit.min.js',
  'vendor/xterm-addon-serialize.min.js',
  'vendor/xterm-addon-unicode11.min.js',
  'vendor/xterm-addon-webgl.min.js',
  'vendor/exceljs.min.js',
  'vendor/fflate.min.js',
  'gesture/wasm/vision_wasm_internal.js',
  'gesture/wasm/vision_wasm_nosimd_internal.js',
]);
const reproduced = [...generated, 'vendor/exceljs.min.js', 'vendor/fflate.min.js'];

/** A fresh canonical build must agree with the bytes the source server serves. */
export function requireReproducedAsset(file: string, code: string, outputs: ReadonlyMap<string, string>): string {
  const expected = outputs.get(file);
  if (expected === undefined || expected !== code)
    throw new Error(`Coverage asset differs from fresh canonical output: ${file}`);
  return hash(expected);
}

export function requireReproducedAssets(publicRoot: string, outputs: ReadonlyMap<string, string>): Map<string, string> {
  return new Map(
    reproduced.map((file) => {
      const path = join(publicRoot, file);
      try {
        if (!lstatSync(path).isFile()) throw new Error('not regular');
      } catch {
        throw new Error(`Required coverage asset missing or not regular: ${file}`);
      }
      return [file, requireReproducedAsset(file, readFileSync(path, 'utf8'), outputs)];
    })
  );
}

function freshCanonicalOutputs(appRoot: string): Map<string, string> {
  if (process.env.VITEST !== 'true') throw new Error('Coverage derivation requires the isolated test runner');
  const output = mkdtempSync(join(tmpdir(), 'browser-coverage-derived-'));
  try {
    execFileSync(process.execPath, [join(appRoot, 'scripts/prepare-test-vendor.mjs'), output], {
      cwd: appRoot,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: dirname(process.execPath) + delimiter + process.env.PATH,
        npm_config_offline: 'true',
      },
    });
    return new Map(reproduced.map((file) => [file, readFileSync(join(output, file.slice('vendor/'.length)), 'utf8')]));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

export function provenance(file: string, tracked: boolean): Provenance {
  if (generated.has(file)) return 'generated-first-party';
  if (thirdParty.has(file)) return 'third-party';
  if (file === 'gesture/gesture-reverie.js') return 'mixed';
  if (tracked && !file.includes('/')) return 'raw-authored';
  return 'unknown';
}

export function publicFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:[cm]?js|html)$/.test(entry.name)) files.push(path);
      else if (entry.isSymbolicLink())
        throw new Error(`Coverage refuses a public source symlink: ${relative(root, path)}`);
    }
  };
  walk(root);
  return files.sort();
}

export function inlineScripts(html: string): Array<{ attributes: string; code: string }> {
  const opening = /<!--|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  const closing = /<\/script\s*>/gi;
  const scripts: Array<{ attributes: string; code: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    if (match[0] === '<!--') {
      const end = html.indexOf('-->', opening.lastIndex);
      if (end < 0) break;
      opening.lastIndex = end + 3;
      continue;
    }
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(html);
    if (!end) break;
    scripts.push({ attributes: match[1], code: html.slice(opening.lastIndex, end.index) });
    opening.lastIndex = closing.lastIndex;
  }
  return scripts;
}

function mentions(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (item: ts.Node) => {
    if (ts.isIdentifier(item) && item.text === name) found = true;
    ts.forEachChild(item, visit);
  };
  visit(node);
  return found;
}

/** The actual route source identifies both the served file and its static aliases. */
export function servedAliases(text: string): Record<string, string[]> {
  const file = ts.createSourceFile('routes.ts', text, ts.ScriptTarget.Latest, true);
  const names = new Map<string, string>(),
    handlers = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text.endsWith('.html')
    )
      names.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const handler = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const matches = [...names].filter(([name]) => mentions(node.initializer!, name));
      if (matches.length === 1) handlers.set(node.name.text, matches[0][1]);
    }
    ts.forEachChild(node, handler);
  };
  handler(file);
  const aliases: Record<string, string[]> = {};
  const route = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1] &&
      ts.isIdentifier(node.arguments[1])
    ) {
      const target = handlers.get(node.arguments[1].text);
      if (target) (aliases[target] ??= []).push(node.arguments[0].text);
    }
    ts.forEachChild(node, route);
  };
  route(file);
  return aliases;
}

export function scriptRoutes(text: string, exportedName: string): string[] {
  const file = ts.createSourceFile('routes.ts', text, ts.ScriptTarget.Latest, true),
    paths: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1] &&
      mentions(node.arguments[1], exportedName)
    )
      paths.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return paths;
}

/** Git is the authority for authored bytes; generated assets declare their source inputs. */
export function sourceCatalog(appRoot: string): Source[] {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: appRoot, encoding: 'utf8' }).trim();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim();
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: gitRoot, encoding: 'utf8' }).split('\0'));
  const verify = (file: string) => {
    const name = posix(relative(gitRoot, file));
    const code = readFileSync(file, 'utf8');
    if (tracked.has(name)) {
      const expected = execFileSync('git', ['show', `${revision}:${name}`], {
        cwd: gitRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (hash(code) !== hash(expected)) throw new Error(`Coverage source differs from Git revision: ${name}`);
    }
    return { name, code, tracked: tracked.has(name) };
  };
  const publicRoot = join(appRoot, 'src/web/public');
  const generator = verify(join(appRoot, 'scripts/prepare-test-vendor.mjs'));
  const spreadsheet = verify(join(appRoot, 'scripts/prepare-spreadsheet-assets.mjs'));
  const lock = verify(join(appRoot, 'package-lock.json'));
  const inputs = [...tracked].filter(
    (name) =>
      name.startsWith(posix(relative(gitRoot, appRoot)) + '/packages/xterm-zerolag-input/src/') && name.endsWith('.ts')
  );
  if (!inputs.length || !generator.tracked || !spreadsheet.tracked || !lock.tracked)
    throw new Error('Coverage derivation lacks tracked generator, lock or authored inputs');
  const inputHashes = inputs.sort().map((name) => `${name}:${hash(verify(join(gitRoot, name)).code)}`);
  const fresh = freshCanonicalOutputs(appRoot);
  const reproducedProofs = requireReproducedAssets(publicRoot, fresh);
  const aliases: Record<string, string[]> = {};
  const routeInputs: string[] = [];
  for (const route of ['board-page-routes.ts', 'plans-page-routes.ts']) {
    const input = verify(join(appRoot, 'src/web/routes', route));
    if (!input.tracked) throw new Error('Static page aliases require tracked route authority');
    Object.assign(aliases, servedAliases(input.code));
    routeInputs.push(`${input.name}:${hash(input.code)}`);
  }
  const output: Source[] = [];
  for (const file of publicFiles(publicRoot)) {
    const input = verify(file),
      local = posix(relative(publicRoot, file));
    if (/\.[cm]?js$/.test(file)) {
      const category = provenance(local, input.tracked);
      let evidence = input.tracked ? `Git ${revision}:${input.name}` : 'Untracked asset; provenance not verified';
      const proof = reproducedProofs.get(local);
      if (proof) {
        evidence =
          category === 'generated-first-party'
            ? `Fresh canonical output ${proof}; generator ${hash(generator.code)}; lock ${hash(lock.code)}; inputs ${hash(inputHashes.join('\n'))}`
            : `Third-party fresh canonical output ${proof}; preparer ${hash(spreadsheet.code)}; lock ${hash(lock.code)}`;
      }
      output.push({
        id: input.name,
        asset: '/' + local,
        revision,
        sha256: hash(input.code),
        provenance: category,
        kind: 'external',
        code: input.code,
        evidence,
        aliases: [],
      });
      continue;
    }
    // Authored inline script bytes remain distinct from server-injected scripts.
    let index = 0;
    for (const script of inlineScripts(input.code)) {
      if (/\bsrc\s*=/.test(script.attributes) || !script.code.trim()) continue;
      const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(script.attributes)?.[1];
      if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
      output.push({
        id: `${input.name}#inline-${++index}`,
        asset: '/' + local,
        revision,
        sha256: hash(script.code),
        provenance: input.tracked && !local.includes('/') ? 'raw-authored' : 'unknown',
        kind: 'inline',
        code: script.code,
        evidence: input.tracked
          ? `Inline script in Git ${revision}:${input.name}; routes ${routeInputs.join(',')}`
          : 'Untracked inline script',
        aliases: aliases[local] || [],
      });
    }
  }
  const owner = verify(join(appRoot, 'src/owner-auth/pages.ts'));
  const ownerRoute = verify(join(appRoot, 'src/owner-auth/routes.ts'));
  const ownerPaths = scriptRoutes(ownerRoute.code, 'OWNER_SCRIPT');
  if (!owner.tracked || !ownerRoute.tracked || ownerPaths.length !== 1)
    throw new Error('Owner client coverage lacks unambiguous tracked source/route authority');
  output.push({
    id: `${owner.name}#OWNER_SCRIPT`,
    asset: ownerPaths[0],
    revision,
    sha256: hash(OWNER_SCRIPT),
    provenance: 'generated-first-party',
    kind: 'external',
    code: OWNER_SCRIPT,
    evidence: `Generated pure OWNER_SCRIPT export; Git ${revision}:${owner.name}:${hash(owner.code)}; route ${ownerRoute.name}:${hash(ownerRoute.code)}; Node ${process.version}`,
    aliases: [],
  });
  return output;
}

const range = z
  .object({
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .refine((value) => value.endOffset >= value.startOffset, 'Invalid V8 range order');
export const rawScriptSchema = z.object({
  url: z.string(),
  scriptId: z.string(),
  source: z.string().optional(),
  functions: z.array(
    z.object({ functionName: z.string(), isBlockCoverage: z.boolean(), ranges: z.array(range).min(1) })
  ),
});
export type RawScript = z.infer<typeof rawScriptSchema>;
type Canonical = { sourceId: string; sha256: string; functions: RawScript['functions'] };
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceMetadataSchema = z.object({
  id: z.string().min(1),
  asset: z.string().startsWith('/'),
  sha256: digestSchema,
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  provenance: z.enum(['raw-authored', 'generated-first-party', 'mixed', 'third-party', 'unknown']),
  kind: z.enum(['external', 'inline']),
  evidence: z.string(),
  aliases: z.array(z.string().startsWith('/')),
  codeLength: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
const catalogSchema = z.object({
  version: z.literal(1),
  sources: z.array(sourceMetadataSchema).min(1),
  limitations: z.array(z.string()),
});
const observationSchema = z.object({
  version: z.literal(2),
  catalogId: digestSchema,
  fixture: z.string().min(1),
  fixtureSources: z
    .record(z.string(), digestSchema)
    .refine((value) => Object.keys(value).length > 0, 'Fixture source identity is required'),
  entries: z.array(
    z
      .object({
        sourceId: z.string(),
        sha256: digestSchema,
        scriptId: z.string().min(1),
        functions: rawScriptSchema.shape.functions,
        execution: executionSchema,
      })
      .superRefine((entry, context) => {
        if (
          entry.execution.state === 'attributed' &&
          (entry.execution.scriptId !== entry.scriptId || entry.execution.sourceSha256 !== entry.sha256)
        )
          context.addIssue({
            code: 'custom',
            path: ['execution'],
            message: 'Execution proof does not match the raw script identity',
          });
      })
  ),
  omitted: z.array(z.object({ omitted: z.string(), path: z.string() })),
  frameGaps: z.array(z.string()),
});

/** All catalogued authored sources remain present, even with no observed execution. */
export function readRawEvidence(
  output: string,
  required = {
    critical: ['/app.js', '/chat-app.js', '/company-resources.js', '/owner/owner.js'],
    iframe: ['/company-plans.html', '/workspace-files.js'],
  }
) {
  const catalogs = new Map<string, z.infer<typeof catalogSchema>>();
  for (const file of readdirSync(join(output, 'catalogs')).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const id = file.slice(0, -5),
      value = catalogSchema.parse(JSON.parse(readFileSync(join(output, 'catalogs', file), 'utf8')));
    if (catalogIdentity(value.sources) !== id) throw new Error('Coverage catalog identity does not match its contents');
    catalogs.set(id, value);
  }
  const observations = readdirSync(join(output, 'observations'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => observationSchema.parse(JSON.parse(readFileSync(join(output, 'observations', file), 'utf8'))));
  if (!observations.length) throw new Error('Browser coverage contains no observations');
  const revisions = new Set(
    [...catalogs.values()].flatMap((catalog) => catalog.sources.map((source) => source.revision))
  );
  if (revisions.size !== 1) throw new Error('Browser coverage mixes Git source revisions');
  if (new Set(observations.map((entry) => stable(entry.fixtureSources))).size !== 1)
    throw new Error('Browser coverage mixes fixture source revisions');
  const sources = new Map<
    string,
    z.infer<typeof sourceMetadataSchema> & { observations: number; executed: boolean; frameKinds: string[] }
  >();
  const identities = new Map<string, z.infer<typeof sourceMetadataSchema>>();
  const sourceCode = new Map<string, string>();
  for (const catalog of catalogs.values()) {
    const seen = new Set<string>();
    for (const source of catalog.sources) {
      if (seen.has(source.id)) throw new Error(`Duplicate source ID in coverage catalog: ${source.id}`);
      seen.add(source.id);
      const identity = identities.get(source.id);
      if (identity && stable(identity) !== stable(source))
        throw new Error(`Coverage source metadata conflicts: ${source.id}`);
      identities.set(source.id, source);
      const prior = sources.get(source.id);
      if (!prior) sources.set(source.id, { ...source, observations: 0, executed: false, frameKinds: [] });
      if (!prior && source.provenance !== 'unknown') {
        const snapshot = readFileSync(join(output, 'sources', source.sha256 + '.js'), 'utf8');
        if (hash(snapshot) !== source.sha256) throw new Error(`Coverage source snapshot is corrupt: ${source.id}`);
        if (snapshot.length !== source.codeLength || Buffer.byteLength(snapshot) !== source.bytes)
          throw new Error(`Coverage source lengths conflict with verified snapshot: ${source.id}`);
        sourceCode.set(source.id, snapshot);
      }
    }
  }
  for (const observation of observations) {
    const catalog = catalogs.get(observation.catalogId);
    if (!catalog) throw new Error('Observation refers to an unavailable source catalog');
    for (const entry of observation.entries) {
      const source = sources.get(entry.sourceId);
      if (
        !source ||
        source.sha256 !== entry.sha256 ||
        !catalog.sources.some((item) => item.id === entry.sourceId && item.sha256 === entry.sha256)
      )
        throw new Error('Observation does not match its verified catalog');
      if (entry.functions.some((fn) => fn.ranges.some((range) => range.endOffset > source.codeLength)))
        throw new Error('Observed range exceeds catalogued source');
      source.observations++;
      const executed = entry.functions.some((fn) =>
        fn.ranges.some((range) => range.count > 0 && range.endOffset > range.startOffset)
      );
      source.executed ||= executed;
      if (executed)
        source.frameKinds = [
          ...new Set([
            ...source.frameKinds,
            entry.execution.state === 'attributed' ? entry.execution.kind : 'unattributed',
          ]),
        ];
    }
  }
  for (const asset of required.critical)
    if (![...sources.values()].some((source) => source.asset === asset && source.executed))
      throw new Error(`Critical browser module was not executed: ${asset}`);
  for (const asset of required.iframe)
    if (
      ![...sources.values()].some(
        (source) => source.asset === asset && source.executed && source.frameKinds.includes('iframe')
      )
    )
      throw new Error(`Actual iframe JavaScript coverage was not collected: ${asset}`);
  const summary = {
    version: 2,
    revision: [...revisions][0],
    observations: observations.length,
    fixtures: [...new Set(observations.map((item) => item.fixture))],
    sources: [...sources.values()],
    unvisitedOwned: [...sources.values()]
      .filter((source) => ['raw-authored', 'generated-first-party'].includes(source.provenance) && !source.executed)
      .map((source) => source.id),
    omissions: observations.flatMap((item) => item.omitted),
    frameGaps: observations.flatMap((item) => item.frameGaps),
    limitations: [...new Set([...catalogs.values()].flatMap((catalog) => catalog.limitations))],
  };
  return { summary, observations, sourceCode };
}

export function readRawBaseline(output: string, required?: { critical: string[]; iframe: string[] }) {
  return readRawEvidence(output, required).summary;
}

export function canonicalScript(
  input: unknown,
  origin: string,
  catalog: Source[]
): Canonical | { omitted: string; path: string } {
  const script = rawScriptSchema.parse(input);
  let url: URL;
  try {
    url = new URL(script.url);
  } catch {
    return { omitted: 'anonymous-or-evaluation', path: 'non-url' };
  }
  if (url.origin !== origin) return { omitted: 'outside-owned-origin', path: 'external' };
  const path = decodeURIComponent(url.pathname),
    asset = path === '/' ? '/index.html' : path;
  const candidates = catalog.filter((source) => source.asset === asset || source.aliases.includes(path));
  if (!candidates.length) return { omitted: 'server-rendered-or-unmapped', path };
  const source = candidates.find(
    (candidate) => script.source !== undefined && candidate.sha256 === hash(script.source)
  );
  if (!source) {
    if (/\.[cm]?js$/.test(path))
      throw new Error(
        script.source === undefined
          ? `Coverage source text is unavailable: ${path}`
          : `Loaded JavaScript does not match its verified source: ${path}`
      );
    return { omitted: 'server-injected-or-unmapped-inline', path };
  }
  for (const fn of script.functions)
    for (const block of fn.ranges)
      if (block.endOffset > source.code.length) throw new Error(`V8 range exceeds verified source: ${source.id}`);
  if (source.provenance === 'unknown') return { omitted: 'unknown-provenance', path };
  return { sourceId: source.id, sha256: source.sha256, functions: script.functions };
}

function writeOnce(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !lstatSync(path).isFile() ||
      readFileSync(path, 'utf8') !== content
    )
      throw error;
  } finally {
    unlinkSync(temporary);
  }
}

export class BrowserCoverageCollection {
  private readonly catalog: Source[];
  private readonly pages = new WeakMap<Page, { origin: string; label: string; tracker: ExecutionTracker }>();
  private readonly starting = new WeakSet<Page>();
  private readonly runId = randomUUID();
  private count = 0;
  private readonly catalogId: string;
  private readonly fixtures: Record<string, string>;
  constructor(
    appRoot: string,
    private readonly output: string
  ) {
    if (process.env.VITEST !== 'true') throw new Error('Browser coverage requires the isolated test runner');
    this.catalog = sourceCatalog(appRoot);
    this.fixtures = Object.fromEntries(
      [
        'test/helpers/browser-coverage.ts',
        'test/helpers/browser-coverage-execution.ts',
        'test/helpers/office-browser.ts',
        'test/helpers/isolated-office.ts',
        'test/office-server.browser.test.ts',
        'test/office-owner-controls.browser.test.ts',
      ].map((file) => [file, hash(readFileSync(join(appRoot, file), 'utf8'))])
    );
    const metadata = this.catalog.map(({ code, ...source }) => ({
      ...source,
      codeLength: code.length,
      bytes: Buffer.byteLength(code),
    }));
    this.catalogId = catalogIdentity(metadata);
    writeOnce(
      join(output, 'catalogs', this.catalogId + '.json'),
      JSON.stringify(
        {
          version: 1,
          sources: metadata,
          limitations: [
            'Coverage belongs to these isolated synthetic scenarios, not production.',
            'Unvisited authored scripts remain in this catalog with zero observations.',
            'Mixed, third-party and unknown provenance are reported separately.',
            'Unmatched server-rendered/injected scripts and workers remain explicit collection gaps; no completeness is claimed.',
            'Anonymous scripts are disabled and uncollected; they are not included in omission counts.',
            'Echo and spreadsheet bundles are byte-matched to fresh canonical preparer outputs; other generated/mixed assets have no such derivation proof.',
            'Out-of-process or unattributed execution contexts remain explicit gaps and cannot qualify iframe execution.',
          ],
        },
        null,
        2
      )
    );
    for (const source of this.catalog)
      if (source.provenance !== 'unknown') writeOnce(join(output, 'sources', source.sha256 + '.js'), source.code);
  }
  async start(page: Page, origin: string, label: string) {
    if (this.pages.has(page) || this.starting.has(page)) throw new Error('Browser coverage already owns this page');
    if (!label.trim()) throw new Error('Coverage requires an explicit fixture label');
    this.starting.add(page);
    let tracker: ExecutionTracker | undefined;
    try {
      tracker = await ExecutionTracker.attach(page, origin);
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
      this.pages.set(page, { origin, label, tracker });
    } catch (error) {
      if (tracker) await tracker.seal();
      throw error;
    } finally {
      this.starting.delete(page);
    }
  }
  async finish(page: Page) {
    const state = this.pages.get(page);
    if (!state) return;
    this.pages.delete(page);
    const entries: Array<Canonical & { scriptId: string; execution: Execution }> = [],
      omitted: Array<{ omitted: string; path: string }> = [];
    try {
      const rawEntries = await page.coverage.stopJSCoverage();
      const execution = await state.tracker.seal();
      for (const raw of rawEntries) {
        const entry = canonicalScript(raw, state.origin, this.catalog);
        if ('omitted' in entry) {
          omitted.push(entry);
          continue;
        }
        entries.push({
          ...entry,
          scriptId: raw.scriptId,
          execution: execution.proof(raw.scriptId, raw.url, entry.sha256),
        });
      }
      writeOnce(
        join(this.output, 'observations', `${this.runId}-${++this.count}.json`),
        JSON.stringify(
          {
            version: 2,
            catalogId: this.catalogId,
            fixture: state.label,
            fixtureSources: this.fixtures,
            entries,
            omitted,
            frameGaps: [
              ...execution.collectionGaps(),
              ...entries
                .filter((entry) => entry.execution.state === 'unattributed')
                .map(
                  (entry) =>
                    `${entry.sourceId}:${entry.execution.state === 'unattributed' ? entry.execution.reason : ''}`
                ),
            ],
          },
          null,
          2
        )
      );
    } finally {
      await state.tracker.seal();
    }
  }
}

const output = process.env.TEST_BROWSER_COVERAGE_DIR;
let collection: BrowserCoverageCollection | undefined;
export async function beginBrowserCoverage(page: Page, origin: string, label: string) {
  if (!output) return;
  collection ??= new BrowserCoverageCollection(resolve(import.meta.dirname, '../..'), output);
  await collection.start(page, origin, label);
}
export async function closeCoveredPage(page: Page) {
  try {
    await collection?.finish(page);
  } finally {
    await page.close();
  }
}
export async function closeCoveredContext(context: BrowserContext) {
  try {
    for (const page of context.pages()) await collection?.finish(page);
  } finally {
    await context.close();
  }
}
export async function closeCoveredBrowser(browser: Browser) {
  try {
    for (const context of browser.contexts()) for (const page of context.pages()) await collection?.finish(page);
  } finally {
    await browser.close();
  }
}
