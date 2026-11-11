import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  INVENTORY_SOURCES,
  scanHtml,
  scanJavaScript,
  scanSources,
  validateManifest,
  type Manifest,
} from '../scripts/control-behavior-inventory.js';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source = `class Panel { render() { const save = this.button('button', 'Save owner details', () => save()); } }`;
const title = 'persists owner details through the authorized API';
const testBody = `it('${title}', async () => { await save.click(); expect(await readOwner()).toEqual('Synthetic owner'); });`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-inventory-'));
  fixtures.push(root);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/owner.test.ts'), testBody);
  const declarations = scanJavaScript('src/panel.js', source);
  const manifest: Manifest = {
    version: 1,
    sources: [...INVENTORY_SOURCES],
    gapBudget: 0,
    gaps: [],
    limitations: ['Recognized constructors only'],
    scenarios: {
      'owner.save': {
        test: 'test/owner.test.ts',
        title,
        assertions: ['await save.click()', "expect(await readOwner()).toEqual('Synthetic owner')"],
        outcome: 'GUI change is persisted and returned through the same API.',
      },
    },
    mappings: [
      {
        declaration: declarations[0].id,
        scenario: 'owner.save',
        remaining: 'Authorization, validation and conflict states still need qualification.',
      },
    ],
  };
  return { root, manifest, declarations };
}

it('checks the reviewed real source manifest without claiming its existing gaps are covered', () => {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(join(root, 'config/control-behavior-manifest.json'), 'utf8')) as Manifest;
  const declarations = scanSources(root, INVENTORY_SOURCES);
  expect(validateManifest(root, manifest, declarations)).toEqual([]);
  expect(manifest.mappings.length).toBeGreaterThan(0);
  expect(manifest.gaps.length).toBeGreaterThan(manifest.mappings.length);
  expect(manifest.gapBudget).toBe(manifest.gaps.length);
  expect(declarations.some((entry) => entry.kind === 'detection-gap')).toBe(true);
});

it('has line-independent declaration IDs and rejects new or renamed controls', () => {
  const { root, manifest, declarations } = fixture();
  expect(scanJavaScript('src/panel.js', '\n\n' + source)).toEqual(declarations);
  expect(validateManifest(root, manifest, declarations)).toEqual([]);
  const added = scanJavaScript(
    'src/panel.js',
    source.replace('const save', "this.button('button', 'New action', () => {}); const save")
  );
  expect(validateManifest(root, manifest, added)).toContainEqual(expect.stringContaining('New unmapped declaration'));
  const renamed = scanJavaScript('src/panel.js', source.replace('Save owner details', 'Save changed owner'));
  expect(validateManifest(root, manifest, renamed)).toContainEqual(
    expect.stringContaining('Deleted or renamed declaration')
  );
  expect(validateManifest(root, manifest, renamed)).toContainEqual(expect.stringContaining('New unmapped declaration'));
});

it('rejects duplicate mappings, removed scenarios, and a larger unqualified gap budget', () => {
  const { root, manifest, declarations } = fixture();
  manifest.mappings.push({ ...manifest.mappings[0] });
  expect(validateManifest(root, manifest, declarations)).toContainEqual(
    expect.stringContaining('Duplicate declaration mapping')
  );
  manifest.mappings.pop();
  delete manifest.scenarios['owner.save'];
  expect(validateManifest(root, manifest, declarations)).toContain('Missing mapped scenario: owner.save');
  manifest.mappings = [];
  manifest.gaps.push({ declaration: declarations[0].id, reason: 'Behavior remains to be qualified' });
  expect(validateManifest(root, manifest, declarations)).toContain('Reviewed gap budget exceeded');
});

it('rejects missing test files, renamed scenarios, and deleted assertions', () => {
  const { root, manifest, declarations } = fixture();
  writeFileSync(join(root, 'test/owner.test.ts'), testBody.replace(title, 'renamed scenario'));
  expect(validateManifest(root, manifest, declarations)).toContain('Missing or ambiguous scenario title: owner.save');
  writeFileSync(
    join(root, 'test/owner.test.ts'),
    testBody.replace("expect(await readOwner()).toEqual('Synthetic owner')", 'expect(true).toBe(true)')
  );
  expect(validateManifest(root, manifest, declarations)).toContain('Missing scenario assertion: owner.save');
  rmSync(join(root, 'test/owner.test.ts'));
  expect(validateManifest(root, manifest, declarations)).toContain('Missing scenario test: owner.save');
});

it('requires ordered assertions inside the named scenario and ignores comments or another test', () => {
  const { root, manifest, declarations } = fixture();
  writeFileSync(
    join(root, 'test/owner.test.ts'),
    `it('${title}',()=>{ /* await save.click(); expect(await readOwner()).toEqual('Synthetic owner') */ });\n${testBody.replace(title, 'other test')}`
  );
  expect(validateManifest(root, manifest, declarations)).toContain('Missing scenario assertion: owner.save');
  writeFileSync(
    join(root, 'test/owner.test.ts'),
    `it('${title}',async()=>{ expect(await readOwner()).toEqual('Synthetic owner'); await save.click(); });`
  );
  expect(validateManifest(root, manifest, declarations)).toContain('Missing scenario assertion: owner.save');
});

it('refuses direct skipped tests and scenarios nested in skipped, todo or conditional suites', () => {
  const { root, manifest, declarations } = fixture();
  for (const modifier of ['skip', 'todo', 'skipIf(true)', 'runIf(false)']) {
    writeFileSync(join(root, 'test/owner.test.ts'), `describe.${modifier}('disabled', () => { ${testBody} });`);
    expect(validateManifest(root, manifest, declarations)).toContain('Missing or ambiguous scenario title: owner.save');
  }
  writeFileSync(join(root, 'test/owner.test.ts'), testBody.replace('it(', 'it.skip('));
  expect(validateManifest(root, manifest, declarations)).toContain('Missing or ambiguous scenario title: owner.save');
});

it('keeps local factories, dynamic markup, roles, and ambiguous declarations visible', () => {
  const found = scanJavaScript(
    'src/view.js',
    `function render(tag) { el('input'); button('Save', action); document.createElement(tag); this.el('div').innerHTML='<button>Action</button>'; tab.setAttribute('role','tab'); this.button('x','Same'); this.button('x','Same'); }`
  );
  expect(found.some((entry) => entry.detail === 'input:[binding label]')).toBe(true);
  expect(found.some((entry) => entry.detail === 'button:Save')).toBe(true);
  expect(found.filter((entry) => entry.kind === 'detection-gap')).toHaveLength(4);
  const { root, manifest } = fixture();
  manifest.mappings[0].declaration = found.find((entry) => entry.kind === 'detection-gap')!.id;
  expect(validateManifest(root, manifest, found)).toContainEqual(
    expect.stringContaining('Unresolved declaration cannot carry a scenario link')
  );
});

it('enumerates static HTML controls including quoted greater-than signs without script/comment false positives', () => {
  const found = scanHtml(
    'src/index.html',
    `<!-- <button>Ignored</button> --><script>const s='<button>Ignored</button>'</script><button id="save" title="A > B">Save</button><input id="name"><a href="/help">Help</a>`
  );
  expect(found.filter((entry) => entry.kind === 'control')).toHaveLength(3);
  expect(found.some((entry) => entry.id.includes('button:save'))).toBe(true);
});

it('does not permit dropping a source surface from the manifest', () => {
  const { root, manifest, declarations } = fixture();
  manifest.sources = manifest.sources.slice(1);
  expect(validateManifest(root, manifest, declarations)).toContain(
    'Source surface list differs from the reviewed scanner scope'
  );
});
