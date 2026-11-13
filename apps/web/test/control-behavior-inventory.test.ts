import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  symlinkSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  INVENTORY_SOURCES,
  INVENTORY_ROOTS,
  INVENTORY_GENERATED_SOURCES,
  INVENTORY_GENERATORS,
  INVENTORY_EXCLUSIONS,
  discoverInventorySources,
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
  for (const directory of INVENTORY_ROOTS) mkdirSync(join(root, directory), { recursive: true });
  for (const file of INVENTORY_GENERATED_SOURCES) writeFileSync(join(root, file), 'export {};');
  mkdirSync(join(root, 'scripts'));
  for (const file of INVENTORY_GENERATORS) writeFileSync(join(root, file), 'export {};');
  writeFileSync(join(root, 'src/web/public/panel.js'), source);
  const declarations = scanJavaScript('src/web/public/panel.js', source);
  const manifest: Manifest = {
    version: 2,
    sources: discoverInventorySources(root),
    sourceExclusions: { ...INVENTORY_EXCLUSIONS },
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
        scenarios: ['owner.save'],
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
  expect(scanJavaScript('src/web/public/panel.js', '\n\n' + source)).toEqual(declarations);
  expect(validateManifest(root, manifest, declarations)).toEqual([]);
  const added = scanJavaScript(
    'src/web/public/panel.js',
    source.replace('const save', "this.button('button', 'New action', () => {}); const save")
  );
  expect(validateManifest(root, manifest, added)).toContainEqual(expect.stringContaining('New unmapped declaration'));
  const renamed = scanJavaScript('src/web/public/panel.js', source.replace('Save owner details', 'Save changed owner'));
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

it('requires version 2 and nonempty unique scenario IDs for each mapped declaration', () => {
  const { root, manifest, declarations } = fixture();
  expect(validateManifest(root, { ...manifest, version: 1 } as unknown as Manifest, declarations)).toEqual([
    'Unknown manifest version: expected 2',
  ]);
  manifest.mappings[0].scenarios = [];
  expect(validateManifest(root, manifest, declarations)).toContainEqual(
    expect.stringContaining('Mapping requires scenario IDs')
  );
  manifest.mappings[0].scenarios = ['owner.save', 'owner.save'];
  expect(validateManifest(root, manifest, declarations)).toContainEqual(
    expect.stringContaining('Duplicate scenario link')
  );
  manifest.mappings[0].scenarios = [''];
  expect(validateManifest(root, manifest, declarations)).toContainEqual(
    expect.stringContaining('Mapping contains an empty scenario ID')
  );
  manifest.mappings[0].scenarios = ['owner.save', 'owner.readback'];
  manifest.scenarios['owner.readback'] = {
    ...manifest.scenarios['owner.save'],
    assertions: ["expect(await readOwner()).toEqual('Synthetic owner')"],
    outcome: 'The saved value is returned on a subsequent read.',
  };
  expect(validateManifest(root, manifest, declarations)).toEqual([]);
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

it('accepts only the exact nonempty static numeric each table used by reviewed browser scenarios', () => {
  const { root, manifest, declarations } = fixture();
  writeFileSync(join(root, 'test/owner.test.ts'), testBody.replace('it(', 'it.each([320, 1280])('));
  expect(validateManifest(root, manifest, declarations)).toEqual([]);
});

it('refuses empty, runtime, sparse, skipped and conditional parameterized scenario registrations', () => {
  const { root, manifest, declarations } = fixture();
  for (const each of [
    'it.each([])',
    'it.each(widths)',
    'it.each([getWidth()])',
    'it.each([...[320]])',
    'it.each([,320])',
    'it.each([1e999])',
    'it.skip.each([320])',
    'it.runIf(true).each([320])',
    'it.skipIf(false).each([320])',
  ]) {
    writeFileSync(join(root, 'test/owner.test.ts'), testBody.replace('it(', each + '('));
    expect(validateManifest(root, manifest, declarations), each).toContain(
      'Missing or ambiguous scenario title: owner.save'
    );
  }
  for (const modifier of ['skip', 'todo', 'skipIf(true)', 'runIf(false)']) {
    writeFileSync(
      join(root, 'test/owner.test.ts'),
      `describe.${modifier}('disabled', () => { ${testBody.replace('it(', 'it.each([320, 1280])(')} });`
    );
    expect(validateManifest(root, manifest, declarations)).toContain('Missing or ambiguous scenario title: owner.save');
  }
  writeFileSync(join(root, 'test/owner.test.ts'), 'if (false) { ' + testBody.replace('it(', 'it.each([320])(') + ' }');
  expect(validateManifest(root, manifest, declarations)).toContain('Missing or ambiguous scenario title: owner.save');
});

for (const [label, prefix, suffix] of [
  ['false-and', 'false && ', ''],
  ['true-or', 'true || ', ''],
  ['uninvoked-function', 'function hidden() { ', ' }'],
]) {
  it('refuses a nonexecuting each registration in ' + label, () => {
    const { root, manifest, declarations } = fixture();
    writeFileSync(join(root, 'test/owner.test.ts'), prefix + testBody.replace('it(', 'it.each([320])(') + suffix);
    expect(validateManifest(root, manifest, declarations)).toContain('Missing or ambiguous scenario title: owner.save');
  });
}

for (const path of ['src/web/public/account-ui.js', 'src/web/public/nested/new-empty-module.js']) {
  it('refuses an omitted first-party source even without recognized controls: ' + path, () => {
    const { root, manifest, declarations } = fixture();
    for (const existing of manifest.sources) {
      mkdirSync(join(root, existing, '..'), { recursive: true });
      if (!existsSync(join(root, existing))) writeFileSync(join(root, existing), '');
    }
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'export const noControls = true;');
    expect(validateManifest(root, manifest, declarations)).toContain(
      'Source surface list differs from the reviewed scanner scope'
    );
  });
}

it('discovers owned TypeScript and unknown vendor/generated neighbors, with stable exact duplicate exclusions', () => {
  const { root, manifest, declarations } = fixture();
  const before = discoverInventorySources(root);
  for (const path of Object.keys(INVENTORY_EXCLUSIONS)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), '/* known generated or third-party asset */');
  }
  expect(discoverInventorySources(root)).toEqual(before);
  for (const path of [
    'src/web/public/vendor/owned-new.js',
    'src/web/public/vendor/katex-0.19.0/owned-controls.html',
    'src/web/public/generated/owned-new.mjs',
    'packages/xterm-zerolag-input/src/nested/owned-control.ts',
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), path.endsWith('.html') ? '<button>Owned</button>' : 'export const owned = true;');
    expect(discoverInventorySources(root)).toContain(path);
    expect(validateManifest(root, manifest, declarations)).toContain(
      'Source surface list differs from the reviewed scanner scope'
    );
  }
  manifest.sourceExclusions = {};
  expect(validateManifest(root, manifest, declarations)).toContain(
    'Source exclusions differ from the reviewed exact asset policy'
  );
});

it('refuses a missing required owned primary source instead of silently excluding its generated bundle', () => {
  const { root } = fixture();
  rmSync(join(root, INVENTORY_GENERATED_SOURCES[0]));
  expect(() => discoverInventorySources(root)).toThrow('Missing owned primary source');
});

it('uses the TypeScript parser for inventoried owned addon source', () => {
  const file = 'packages/xterm-zerolag-input/src/panel.ts';
  const controls = scanJavaScript(
    file,
    "interface Context { label: string } class Panel { render(context: Context): void { const input: HTMLInputElement = document.createElement('input'); } }"
  );
  expect(controls).toContainEqual(
    expect.objectContaining({
      file,
      owner: 'Panel.render',
      kind: 'control',
      detail: 'input:[binding label]',
    })
  );
});

it('keeps the actual full inventory valid in a flattened web source without Git or prepared vendor outputs', () => {
  const original = resolve(import.meta.dirname, '..');
  const root = mkdtempSync(join(tmpdir(), 'flat-control-inventory-'));
  fixtures.push(root);
  const manifest = JSON.parse(
    readFileSync(join(original, 'config/control-behavior-manifest.json'), 'utf8')
  ) as Manifest;
  const inputs = new Set([...manifest.sources, ...Object.values(manifest.scenarios).map((scenario) => scenario.test)]);
  for (const file of inputs) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    copyFileSync(join(original, file), join(root, file));
  }
  expect(existsSync(join(root, '.git'))).toBe(false);
  expect(discoverInventorySources(root)).toEqual(manifest.sources);
  expect(validateManifest(root, manifest)).toEqual([]);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'config'));
  copyFileSync(
    join(original, 'scripts/control-behavior-inventory.ts'),
    join(root, 'scripts/control-behavior-inventory.ts')
  );
  copyFileSync(
    join(original, 'config/control-behavior-manifest.json'),
    join(root, 'config/control-behavior-manifest.json')
  );
  copyFileSync(join(original, 'package.json'), join(root, 'package.json'));
  symlinkSync(
    join(original, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const cli = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/control-behavior-inventory.ts')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout).sources).toEqual(manifest.sources);
  expect(JSON.parse(cli.stdout).errors).toEqual([]);
});

it.skipIf(process.platform === 'win32')('refuses source symlinks instead of hiding their target from discovery', () => {
  const { root } = fixture();
  symlinkSync('panel.js', join(root, 'src/web/public/alias.js'));
  expect(() => discoverInventorySources(root)).toThrow('Inventory source symlink is not supported');
});

it('refuses a missing owned adapter-glue producer instead of classifying its code as third-party', () => {
  const { root } = fixture();
  rmSync(join(root, INVENTORY_GENERATORS[0]));
  expect(() => discoverInventorySources(root)).toThrow();
});

for (const path of [
  'src/web/public/nested/owned-page.htm',
  'packages/xterm-zerolag-input/src/owned-module.mts',
  'packages/xterm-zerolag-input/src/owned-module.cts',
]) {
  it('discovers a new ordinary frontend source extension: ' + path, () => {
    const { root, manifest, declarations } = fixture();
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(
      join(root, path),
      path.endsWith('.htm') ? '<button>Owned</button>' : 'export const owned: boolean = true;'
    );
    expect(discoverInventorySources(root)).toContain(path);
    expect(validateManifest(root, manifest, declarations)).toContain(
      'Source surface list differs from the reviewed scanner scope'
    );
  });
}

for (const extension of ['jsx', 'tsx']) {
  it('keeps JSX markup unresolved instead of silently dropping its controls: ' + extension, () => {
    const declarations = scanJavaScript(
      'src/web/public/view.' + extension,
      'const view = <div><button>Go</button><input /></div>;'
    );
    expect(declarations).toHaveLength(3);
    expect(
      declarations.every((entry) => entry.kind === 'detection-gap' && entry.detail.startsWith('jsx-markup:'))
    ).toBe(true);
    expect(declarations.some((entry) => entry.kind === 'control')).toBe(false);
  });
}

it('selects the HTML scanner for an ordinary htm page', () => {
  const { root } = fixture();
  const file = 'src/web/public/page.htm';
  writeFileSync(join(root, file), '<button id="owned">Go</button>');
  expect(scanSources(root, [file])).toContainEqual(
    expect.objectContaining({
      owner: 'html',
      kind: 'control',
      detail: '<button id="owned">',
    })
  );
});

it('retains ordinary controls when parsing owned TypeScript module variants', () => {
  for (const extension of ['ts', 'mts', 'cts', 'tsx']) {
    const file = 'packages/xterm-zerolag-input/src/view.' + extension;
    expect(
      scanJavaScript(
        file,
        "interface Context { label: string } class Panel { render(context: Context): void { const input: HTMLInputElement = document.createElement('input'); } }"
      )
    ).toContainEqual(
      expect.objectContaining({ file, owner: 'Panel.render', kind: 'control', detail: 'input:[binding label]' })
    );
  }
});
