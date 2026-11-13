/** Source-declaration ratchet. It does not infer behavioral coverage from a passing file. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

export interface Declaration {
  id: string;
  file: string;
  owner: string;
  kind: 'control' | 'detection-gap';
  detail: string;
}

export interface Scenario {
  test: string;
  title: string;
  assertions: string[];
  outcome: string;
}

export interface Manifest {
  version: 2;
  sources: string[];
  sourceExclusions: Record<string, string>;
  scenarios: Record<string, Scenario>;
  mappings: Array<{ declaration: string; scenarios: string[]; remaining: string }>;
  gaps: Array<{ declaration: string; reason: string }>;
  gapBudget: number;
  limitations: string[];
}

const tags = new Set(['button', 'input', 'select', 'textarea', 'summary', 'a']);

/** Web-relative roots also exist in the flattened Nix web source, without Git. */
export const INVENTORY_ROOTS = ['src/web/public', 'packages/xterm-zerolag-input/src'] as const;
export const INVENTORY_GENERATED_SOURCES = [
  'packages/xterm-zerolag-input/src/zerolag-input-addon.ts',
  'packages/xterm-zerolag-input/src/predictive-echo-addon.ts',
] as const;
export const INVENTORY_GENERATORS = [
  'scripts/prepare-test-vendor.mjs',
  'scripts/build.mjs',
  'scripts/postinstall.js',
] as const;
/** Exact assets only. Unknown neighbors are first-party candidates, never directory-excluded. */
export const INVENTORY_EXCLUSIONS: Readonly<Record<string, string>> = {
  'src/web/public/vendor/dompurify.min.js':
    'Third-party DOMPurify browser bundle; committed upstream distribution, not Reverie control source.',
  'src/web/public/vendor/marked.min.js':
    'Third-party Marked Markdown parser browser bundle; committed upstream distribution.',
  'src/web/public/vendor/katex-0.19.0/katex.min.js':
    'Pinned third-party KaTeX0.19.0 browser distribution; vendor/katex-0.19.0/LICENSE.',
  'src/web/public/vendor/highlight-11.12.0.min.js':
    'Pinned third-party Highlight.js11.12.0 distribution; vendor/highlight-LICENSE.txt.',
  'src/web/public/vendor/embassy-qr-code.min.js':
    'Third-party qrcode1.5.4 browser entry bundled with esbuild; exact origin/licenses in vendor/EMBASSY-QR-NOTICES.md.',
  'src/web/public/vendor/embassy-qr-scan.min.js':
    'Third-party jsQR1.4.0 browser bundle; exact origin/integrity/licenses in vendor/EMBASSY-QR-NOTICES.md.',
  'src/web/public/vendor/pdfjs-6.4.299/pdf.mjs':
    'Pinned third-party PDF.js6.4.299 distribution; vendor/pdfjs-6.4.299/PINS.json and LICENSE.',
  'src/web/public/vendor/pdfjs-6.4.299/pdf.worker.mjs':
    'Pinned third-party PDF.js6.4.299 worker distribution; vendor/pdfjs-6.4.299/PINS.json and LICENSE.',
  'src/web/public/vendor/pdfjs-6.4.299/wasm/openjpeg_nowasm_fallback.js':
    'Pinned third-party PDF.js OpenJPEG fallback; vendor/pdfjs-6.4.299/wasm/LICENSE_OPENJPEG.',
  'src/web/public/vendor/pdfjs-6.4.299/wasm/jbig2_nowasm_fallback.js':
    'Pinned third-party PDF.js JBIG2 fallback; vendor/pdfjs-6.4.299/wasm/LICENSE_JBIG2.',
  'src/web/public/vendor/xterm.min.js':
    'Generated third-party @xterm/xterm distribution from node_modules; scripts/prepare-test-vendor.mjs ASSETS.',
  'src/web/public/vendor/xterm-addon-fit.min.js':
    'Generated third-party @xterm/addon-fit distribution; scripts/prepare-test-vendor.mjs ASSETS.',
  'src/web/public/vendor/xterm-addon-serialize.min.js':
    'Generated third-party @xterm/addon-serialize distribution; scripts/prepare-test-vendor.mjs ASSETS.',
  'src/web/public/vendor/xterm-addon-unicode11.min.js':
    'Generated third-party @xterm/addon-unicode11 distribution; scripts/prepare-test-vendor.mjs ASSETS.',
  'src/web/public/vendor/xterm-addon-webgl.min.js':
    'Generated third-party @xterm/addon-webgl distribution; scripts/prepare-test-vendor.mjs ASSETS.',
  'src/web/public/vendor/exceljs.min.js':
    'Generated third-party ExcelJS browser distribution; scripts/prepare-spreadsheet-assets.mjs copies pinned package bytes.',
  'src/web/public/vendor/fflate.min.js':
    'Generated third-party fflate browser bundle; scripts/prepare-spreadsheet-assets.mjs bundles pinned package.',
  'src/web/public/vendor/xterm-zerolag-input.js':
    'Generated duplicate of owned packages/xterm-zerolag-input/src/zerolag-input-addon.ts and its siblings, ALL inventoried as TypeScript; appended alias glue from scripts/prepare-test-vendor.mjs, scripts/build.mjs and scripts/postinstall.js is also inventoried. Producer: scripts/prepare-test-vendor.mjs; separate behavior suite: npm --prefix packages/xterm-zerolag-input test (not qualified by inventory).',
  'src/web/public/vendor/xterm-predictive-echo.js':
    'Generated duplicate of owned packages/xterm-zerolag-input/src/predictive-echo-addon.ts and its siblings, ALL inventoried as TypeScript; appended alias glue from scripts/prepare-test-vendor.mjs, scripts/build.mjs and scripts/postinstall.js is also inventoried. Producer: scripts/prepare-test-vendor.mjs; separate behavior suite: npm --prefix packages/xterm-zerolag-input test (not qualified by inventory).',
};

/** Inventory presence is independent of whether a file contains recognized controls. */
export function discoverInventorySources(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    const directory = join(root, relative);
    const original = lstatSync(directory);
    if (!original.isDirectory() || original.isSymbolicLink())
      throw new Error(`Inventory source root is not a real directory: ${relative}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Inventory source symlink is not supported: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (
        entry.isFile() &&
        /\.(?:[cm]?js|jsx|[cm]?ts|tsx|html?)$/i.test(entry.name) &&
        !Object.hasOwn(INVENTORY_EXCLUSIONS, file)
      )
        found.push(file);
    }
  };
  for (const directory of INVENTORY_ROOTS) walk(directory);
  for (const file of INVENTORY_GENERATORS) {
    const entry = lstatSync(join(root, file));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Inventory generator is not a real file: ${file}`);
    found.push(file);
  }
  for (const file of INVENTORY_GENERATED_SOURCES)
    if (!found.includes(file)) throw new Error(`Missing owned primary source: ${file}`);
  return found.sort();
}

export const INVENTORY_SOURCES = discoverInventorySources(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function literal(node: ts.Node | undefined, source: ts.SourceFile): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map((span) => '${' + compact(span.expression.getText(source)) + '}' + span.literal.text)
        .join('')
    );
  return undefined;
}

function scope(node: ts.Node, source: ts.SourceFile): { owner: string; binding: string } {
  let binding = '',
    owner = 'module';
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!binding && ts.isVariableDeclaration(parent)) binding = compact(parent.name.getText(source));
    if (ts.isMethodDeclaration(parent) || ts.isConstructorDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
      owner = ts.isConstructorDeclaration(parent) ? 'constructor' : parent.name?.getText(source) || 'anonymous';
      for (let outer = parent.parent; outer; outer = outer.parent)
        if (ts.isClassDeclaration(outer) || ts.isClassExpression(outer)) {
          owner = `${outer.name?.text || 'anonymous'}.${owner}`;
          break;
        }
      break;
    }
  }
  return { owner, binding: binding || 'inline' };
}

/** Recognizes these constructors only; unresolved dynamic constructors/markup stay visible as gaps. */
export function scanJavaScript(file: string, text: string): Declaration[] {
  const kind = /\.tsx$/i.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/i.test(file)
      ? ts.ScriptKind.TS
      : /\.jsx$/i.test(file)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const declarations: Declaration[] = [];
  const add = (node: ts.Node, kind: Declaration['kind'], detail: string) => {
    const { owner, binding } = scope(node, source);
    declarations.push({ id: `${file}::${owner}::${binding}::${detail}`, file, owner, kind, detail });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) || ts.isIdentifier(node.expression))
    ) {
      const property = ts.isPropertyAccessExpression(node.expression);
      const factory = property ? node.expression.name.text : node.expression.getText(source);
      if (factory === 'button') {
        const label = literal(node.arguments[property ? 1 : 0], source);
        add(
          node,
          label === undefined ? 'detection-gap' : 'control',
          `button:${label ?? '[dynamic label:' + digest(compact(node.arguments[property ? 1 : 0]?.getText(source) || '')) + ']'}`
        );
      } else if (['el', 'literalText', 'createElement'].includes(factory)) {
        const tag = literal(node.arguments[0], source);
        if (tag && tags.has(tag.toLowerCase()))
          add(node, 'control', `${tag}:${literal(node.arguments[property ? 2 : 1], source) ?? '[binding label]'}`);
        else if (tag === undefined)
          add(node, 'detection-gap', `dynamic-constructor:${digest(compact(node.getText(source)))}`);
      }
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      /<(?:button|input|select|textarea|summary|a)\b/i.test(node.getText(source))
    )
      add(node, 'detection-gap', `embedded-control-markup:${digest(compact(node.getText(source)))}`);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setAttribute' &&
      literal(node.arguments[0], source) === 'role' &&
      ['button', 'tab', 'switch', 'checkbox', 'menuitem'].includes(literal(node.arguments[1], source) || '')
    )
      add(node, 'detection-gap', `semantic-role:${compact(node.getText(source))}`);

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))
      add(node, 'detection-gap', `jsx-markup:${digest(compact(node.getText(source)))}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Repeated identical declarations cannot be safely linked to a unique scenario.
  const counts = new Map<string, number>();
  for (const entry of declarations) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  const unique = new Map<string, Declaration>();
  for (const entry of declarations) {
    const count = counts.get(entry.id)!;
    const value =
      count > 1 ? { ...entry, id: `${entry.id}::ambiguous-${count}`, kind: 'detection-gap' as const } : entry;
    unique.set(value.id, value);
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Static HTML only. Scripts and template-generated controls require separate source inspection. */
export function scanHtml(file: string, text: string): Declaration[] {
  const html = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  const declarations: Declaration[] = [];
  const seen = new Map<string, number>();
  for (const match of html.matchAll(/<(button|input|select|textarea|summary|a)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tag = match[1].toLowerCase(),
      markup = compact(match[0]);
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(markup)?.[1];
    const key = `${file}::html::${tag}:${id || digest(markup)}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    declarations.push({ id: `${key}::${count}`, file, owner: 'html', kind: 'control', detail: markup });
  }
  let inline = 0;
  for (const match of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
    if (src)
      declarations.push({
        id: `${file}::external-script::${src}`,
        file,
        owner: 'html',
        kind: 'detection-gap',
        detail: `Script dependency; review its coverage against the scoped source list: ${src}`,
      });
    else declarations.push(...scanJavaScript(`${file}#inline-${++inline}`, match[2]));
  }
  return declarations.sort((a, b) => a.id.localeCompare(b.id));
}

export function scanSources(root: string, sources: string[]): Declaration[] {
  return sources.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    return /\.html?$/i.test(file) ? scanHtml(file, text) : scanJavaScript(file, text);
  });
}

function tokens(text: string): string {
  const source = ts.createSourceFile('scenario.ts', text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    const children = node.getChildren(source);
    if (children.length) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.getText(source)) out.push(node.getText(source));
  };
  visit(source);
  return out.join('\u001f');
}

function staticRegistrationLoop(loop: ts.ForOfStatement): boolean {
  if (loop.awaitModifier || !ts.isVariableDeclarationList(loop.initializer)) return false;
  const bindings = loop.initializer;
  const table = loop.expression;
  const statements = ts.isBlock(loop.statement) ? loop.statement.statements : [loop.statement];
  return (
    !!(bindings.flags & ts.NodeFlags.Const) &&
    bindings.declarations.length === 1 &&
    ts.isIdentifier(bindings.declarations[0]!.name) &&
    ts.isArrayLiteralExpression(table) &&
    table.elements.length > 0 &&
    table.elements.every((entry) => ts.isNumericLiteral(entry) && Number.isFinite(Number(entry.text))) &&
    statements.length > 0 &&
    statements.every(
      (entry) =>
        ts.isExpressionStatement(entry) &&
        ts.isCallExpression(entry.expression) &&
        ts.isIdentifier(entry.expression.expression) &&
        ['it', 'test'].includes(entry.expression.expression.text)
    )
  );
}

function exitsRegistrationScope(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  return ts.forEachChild(node, exitsRegistrationScope) === true;
}

function registrationSource(source: string) {
  const filename = '/scenario.ts';
  const options: ts.CompilerOptions = {
    noResolve: true,
    noLib: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (file, languageVersion) =>
    file === filename ? ts.createSourceFile(file, source, languageVersion, true) : undefined;
  host.fileExists = (file) => file === filename;
  host.readFile = () => undefined;
  host.directoryExists = () => false;
  host.getDirectories = () => [];
  host.getCurrentDirectory = () => '/';
  const program = ts.createProgram([filename], options, host);
  const parsed = program.getSourceFile(filename);
  if (!parsed) throw Error('The original scenario module was not parsed');
  return {
    parsed,
    checker: program.getTypeChecker(),
    syntaxValid: program.getSyntacticDiagnostics(parsed).length === 0,
  };
}

function transparentRegistrationExpression(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

function registrationProperty(input: ts.Node) {
  const node = transparentRegistrationExpression(input);
  if (ts.isPropertyAccessExpression(node))
    return { base: transparentRegistrationExpression(node.expression), key: node.name.text };
  if (ts.isElementAccessExpression(node)) {
    const key = transparentRegistrationExpression(node.argumentExpression);
    if (ts.isStringLiteralLike(key)) return { base: transparentRegistrationExpression(node.expression), key: key.text };
  }
  return undefined;
}

function registrationReassigned(identifier: ts.Identifier, checker: ts.TypeChecker, method?: 'each'): boolean {
  const original = checker.getSymbolAtLocation(identifier);
  const binding = (input: ts.Node): boolean => {
    const node = transparentRegistrationExpression(input);
    if (ts.isIdentifier(node)) return node.text === identifier.text && checker.getSymbolAtLocation(node) === original;
    if (original) return false;
    const property = registrationProperty(node);
    return (
      !!property &&
      property.key === identifier.text &&
      ts.isIdentifier(property.base) &&
      ['globalThis', 'global', 'window'].includes(property.base.text) &&
      !checker.getSymbolAtLocation(property.base)?.declarations?.length
    );
  };
  const target = (input: ts.Node): boolean => {
    const node = transparentRegistrationExpression(input);
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(target);
    if (ts.isObjectLiteralExpression(node)) return node.properties.some(target);
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return target(node.expression);
    if (ts.isPropertyAssignment(node)) return target(node.initializer);
    if (ts.isShorthandPropertyAssignment(node))
      return node.name.text === identifier.text && checker.getShorthandAssignmentValueSymbol(node) === original;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return target(node.left);
    if (binding(node)) return true;
    const property = registrationProperty(node);
    return method !== undefined && property?.key === method && binding(property.base);
  };
  const visit = (node: ts.Node): boolean => {
    if (
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        target(node.left)) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        target(node.operand)) ||
      (ts.isDeleteExpression(node) && target(node.expression)) ||
      ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && target(node.initializer))
    )
      return true;
    return ts.forEachChild(node, visit) === true;
  };
  return visit(identifier.getSourceFile());
}

/** Free configured Vitest globals and real named Vitest imports may register tests.
 * A local alias, parameter or replacement function supplies no such proof.
 */
function registrationBinding(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  suite = false,
  method?: 'each'
): boolean {
  if (registrationReassigned(identifier, checker, method)) return false;
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return true;
  if (symbol.declarations?.length !== 1) return false;
  const binding = symbol.declarations[0]!;
  if (!ts.isImportSpecifier(binding) || binding.isTypeOnly) return false;
  const clause = binding.parent.parent;
  const imported = clause.parent;
  if (
    !ts.isImportClause(clause) ||
    clause.isTypeOnly ||
    !ts.isImportDeclaration(imported) ||
    !ts.isStringLiteral(imported.moduleSpecifier) ||
    imported.moduleSpecifier.text !== 'vitest'
  )
    return false;
  return (suite ? ['describe'] : ['it', 'test']).includes((binding.propertyName ?? binding.name).text);
}

/** Registration must be unconditional, optionally in ordinary suites or fixed numeric loops.
 * A matching title in a factory or unreachable branch establishes no registration.
 */
function unconditionalRegistration(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const initial = node.parent;
  if (!ts.isExpressionStatement(initial)) return false;
  let statement: ts.Statement = initial;
  for (;;) {
    const scope = statement.parent;
    if (ts.isSourceFile(scope) || ts.isBlock(scope)) {
      if (scope.statements.slice(0, scope.statements.indexOf(statement)).some(exitsRegistrationScope)) return false;
    }
    if (ts.isSourceFile(scope)) return true;
    const loop = ts.isForOfStatement(scope)
      ? scope
      : ts.isBlock(scope) && ts.isForOfStatement(scope.parent)
        ? scope.parent
        : undefined;
    if (loop) {
      if (!staticRegistrationLoop(loop)) return false;
      statement = loop;
      continue;
    }
    if (!ts.isBlock(scope)) return false;
    const callback = scope.parent;
    if (
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      callback.body !== scope ||
      callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      (ts.isFunctionExpression(callback) && callback.asteriskToken)
    )
      return false;
    const suite = callback.parent;
    if (
      !ts.isCallExpression(suite) ||
      !ts.isIdentifier(suite.expression) ||
      suite.expression.text !== 'describe' ||
      !registrationBinding(suite.expression, checker, true) ||
      suite.arguments[1] !== callback ||
      !suite.arguments[0] ||
      !ts.isStringLiteralLike(suite.arguments[0])
    )
      return false;
    if (!ts.isExpressionStatement(suite.parent)) return false;
    statement = suite.parent;
  }
}

/** Only a direct top-level nonempty static numeric browser table is a known registration.
 * Runtime tables, holes/spreads, conditional registrations and modifiers remain unknown.
 */
function scenarioRegistration(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (!unconditionalRegistration(node, checker)) return false;
  const expression = node.expression;
  if (ts.isIdentifier(expression))
    return ['it', 'test'].includes(expression.text) && registrationBinding(expression, checker);
  if (!ts.isExpressionStatement(node.parent) || !ts.isSourceFile(node.parent.parent)) return false;
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return false;
  const factory = expression.expression;
  if (
    !ts.isPropertyAccessExpression(factory) ||
    factory.name.text !== 'each' ||
    !ts.isIdentifier(factory.expression) ||
    !['it', 'test'].includes(factory.expression.text) ||
    !registrationBinding(factory.expression, checker, false, 'each')
  )
    return false;
  const table = expression.arguments[0];
  if (
    !ts.isArrayLiteralExpression(table) ||
    !table.elements.length ||
    !table.elements.every((entry) => ts.isNumericLiteral(entry) && Number.isFinite(Number(entry.text)))
  )
    return false;

  return true;
}

/** Exact title and assertion anchors are reviewed scenario contracts, not evidence inferred from filenames. */
export function validateManifest(
  root: string,
  manifest: Manifest,
  declarations = scanSources(root, discoverInventorySources(root))
): string[] {
  const errors: string[] = [];
  if (manifest.version !== 2) return ['Unknown manifest version: expected 2'];
  if (JSON.stringify(manifest.sources) !== JSON.stringify(discoverInventorySources(root)))
    errors.push('Source surface list differs from the reviewed scanner scope');
  if (JSON.stringify(manifest.sourceExclusions) !== JSON.stringify(INVENTORY_EXCLUSIONS))
    errors.push('Source exclusions differ from the reviewed exact asset policy');
  const actual = new Map(declarations.map((entry) => [entry.id, entry]));
  const assigned = new Set<string>();
  for (const entry of [...manifest.mappings, ...manifest.gaps]) {
    if (assigned.has(entry.declaration)) errors.push(`Duplicate declaration mapping: ${entry.declaration}`);
    assigned.add(entry.declaration);
    if (!actual.has(entry.declaration)) errors.push(`Deleted or renamed declaration: ${entry.declaration}`);
  }
  for (const entry of declarations) if (!assigned.has(entry.id)) errors.push(`New unmapped declaration: ${entry.id}`);
  if (manifest.gaps.length > manifest.gapBudget) errors.push('Reviewed gap budget exceeded');
  for (const gap of manifest.gaps) if (!gap.reason.trim()) errors.push(`Gap lacks reason: ${gap.declaration}`);
  const scenarioSources = new Map<string, ReturnType<typeof registrationSource>>();
  for (const [id, scenario] of Object.entries(manifest.scenarios)) {
    if (!scenario.outcome.trim() || !scenario.assertions.length)
      errors.push(`Scenario lacks behavioral contract: ${id}`);
    let original = scenarioSources.get(scenario.test);
    if (!original) {
      let source: string;
      try {
        source = readFileSync(join(root, scenario.test), 'utf8');
      } catch {
        errors.push(`Missing scenario test: ${id}`);
        continue;
      }
      original = registrationSource(source);
      scenarioSources.set(scenario.test, original);
    }
    const { parsed, checker } = original;
    if (!original.syntaxValid) {
      errors.push(`Invalid scenario test syntax: ${id}`);
      continue;
    }
    const bodies: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        literal(node.arguments[0], parsed) === scenario.title &&
        node.arguments[1] &&
        scenarioRegistration(node, checker)
      )
        bodies.push(node.arguments[1].getText(parsed));
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (bodies.length !== 1) errors.push(`Missing or ambiguous scenario title: ${id}`);
    const body = tokens(bodies[0] || '');
    let after = 0;
    for (const assertion of scenario.assertions) {
      const anchor = tokens(assertion),
        at = anchor ? body.indexOf(anchor, after) : -1;
      if (at < 0) errors.push(`Missing scenario assertion: ${id}`);
      else after = at + anchor.length;
    }
  }
  for (const mapping of manifest.mappings) {
    if (!Array.isArray(mapping.scenarios) || mapping.scenarios.length === 0)
      errors.push(`Mapping requires scenario IDs: ${mapping.declaration}`);
    else {
      const seen = new Set<string>();
      for (const id of mapping.scenarios) {
        if (typeof id !== 'string' || !id.trim())
          errors.push(`Mapping contains an empty scenario ID: ${mapping.declaration}`);
        else if (!manifest.scenarios[id]) errors.push(`Missing mapped scenario: ${id}`);
        if (seen.has(id)) errors.push(`Duplicate scenario link: ${mapping.declaration}: ${id}`);
        seen.add(id);
      }
    }
    if (!mapping.remaining.trim()) errors.push(`Mapping lacks remaining state gaps: ${mapping.declaration}`);
    if (actual.get(mapping.declaration)?.kind !== 'control')
      errors.push(`Unresolved declaration cannot carry a scenario link: ${mapping.declaration}`);
  }
  return errors;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(join(root, 'config/control-behavior-manifest.json'), 'utf8')) as Manifest;
  const declarations = scanSources(root, INVENTORY_SOURCES);
  const errors = validateManifest(root, manifest, declarations);
  console.log(
    JSON.stringify(
      {
        sources: manifest.sources,
        sourceExclusions: manifest.sourceExclusions,
        declarations: declarations.length,
        mappedDeclarations: manifest.mappings.length,
        reviewedScenarioLinks: manifest.mappings.reduce(
          (count, mapping) => count + (Array.isArray(mapping.scenarios) ? mapping.scenarios.length : 0),
          0
        ),
        interpretation: 'Static registration integrity only; the associated scenario must also execute and pass.',
        existingGaps: manifest.gaps.length,
        detectionGaps: declarations.filter((entry) => entry.kind === 'detection-gap').length,
        limitations: manifest.limitations,
        errors,
      },
      null,
      2
    )
  );
  if (errors.length) process.exitCode = 1;
}
