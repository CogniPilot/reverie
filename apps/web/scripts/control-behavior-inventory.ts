/** Source-declaration ratchet. It does not infer behavioral coverage from a passing file. */
import { readFileSync } from 'node:fs';
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
  scenarios: Record<string, Scenario>;
  mappings: Array<{ declaration: string; scenarios: string[]; remaining: string }>;
  gaps: Array<{ declaration: string; reason: string }>;
  gapBudget: number;
  limitations: string[];
}

const tags = new Set(['button', 'input', 'select', 'textarea', 'summary', 'a']);
export const INVENTORY_SOURCES = [
  'src/web/public/chat-app.js',
  'src/web/public/company-ui.js',
  'src/web/public/company-resources.js',
  'src/web/public/plans-ui.js',
  'src/web/public/workspace-files.js',
  'src/web/public/index.html',
  'src/web/public/board.html',
  'src/web/public/plans.html',
  'src/web/public/company-plans.html',
  'src/web/public/workspace-files.html',
];
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
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
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
    return file.endsWith('.html') ? scanHtml(file, text) : scanJavaScript(file, text);
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

function skippedAncestor(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isCallExpression(parent)) continue;
    let expression: ts.Expression = parent.expression;
    const parts: string[] = [];
    while (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression)) {
      if (ts.isCallExpression(expression)) expression = expression.expression;
      else {
        parts.push(expression.name.text);
        expression = expression.expression;
      }
    }
    if (
      ts.isIdentifier(expression) &&
      ['describe', 'it', 'test'].includes(expression.text) &&
      parts.some((part) => ['skip', 'todo', 'skipIf', 'runIf'].includes(part))
    )
      return true;
  }
  return false;
}

/** Exact title and assertion anchors are reviewed scenario contracts, not evidence inferred from filenames. */
export function validateManifest(
  root: string,
  manifest: Manifest,
  declarations = scanSources(root, INVENTORY_SOURCES)
): string[] {
  const errors: string[] = [];
  if (manifest.version !== 2) return ['Unknown manifest version: expected 2'];
  if (JSON.stringify(manifest.sources) !== JSON.stringify(INVENTORY_SOURCES))
    errors.push('Source surface list differs from the reviewed scanner scope');
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
  for (const [id, scenario] of Object.entries(manifest.scenarios)) {
    if (!scenario.outcome.trim() || !scenario.assertions.length)
      errors.push(`Scenario lacks behavioral contract: ${id}`);
    let source: string;
    try {
      source = readFileSync(join(root, scenario.test), 'utf8');
    } catch {
      errors.push(`Missing scenario test: ${id}`);
      continue;
    }
    const parsed = ts.createSourceFile(scenario.test, source, ts.ScriptTarget.Latest, true);
    const bodies: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['it', 'test'].includes(node.expression.text)
      ) {
        const title = literal(node.arguments[0], parsed);
        if (title === scenario.title && node.arguments[1] && !skippedAncestor(node))
          bodies.push(node.arguments[1].getText(parsed));
      }
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
