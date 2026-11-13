import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

const commands = [
  'test',
  'test:ci',
  'test:watch',
  'test:all',
  'test:perf',
  'test:browser',
  'test:mobile',
  'test:coverage',
];

function lifecycleFixture(command = 'test:coverage'): string {
  const root = mkdtempSync(join(tmpdir(), 'test-preparation-'));
  try {
    cpSync(join(repoRoot, 'src/web/public'), join(root, 'src/web/public'), { recursive: true });
    cpSync(join(repoRoot, 'packages/xterm-zerolag-input/src'), join(root, 'packages/xterm-zerolag-input/src'), {
      recursive: true,
    });
    mkdirSync(join(root, 'scripts'));
    for (const script of ['prepare-test-vendor.mjs', 'prepare-spreadsheet-assets.mjs', 'check-public-assets.mjs'])
      copyFileSync(join(repoRoot, 'scripts', script), join(root, 'scripts', script));
    copyFileSync(join(repoRoot, '.prettierignore'), join(root, '.prettierignore'));
    symlinkSync(
      join(repoRoot, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    // Keep the REAL lifecycle hook. Replace only the expensive test phase
    // with an observable marker so this integration test never recurses.
    pkg.scripts[command] = 'node test-entry.mjs';
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(
      join(root, 'test-entry.mjs'),
      "import {readFileSync,writeFileSync} from 'node:fs';for(const asset of ['exceljs.min.js','fflate.min.js','xterm-zerolag-input.js']){if(readFileSync(new URL('./src/web/public/vendor/'+asset,import.meta.url)).length<100)throw Error('Missing browser asset: '+asset);}writeFileSync(new URL('./test-started',import.meta.url),'started');\n"
    );
    for (const file of ['exceljs.min.js', 'fflate.min.js', 'xterm-zerolag-input.js'])
      rmSync(join(root, 'src/web/public/vendor', file), { force: true });
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

it.each(commands)('%s prepares missing browser assets before entering its test runner', (command) => {
  const root = lifecycleFixture(command);
  try {
    execFileSync('npm', ['run', command, '--silent'], { cwd: root, stdio: 'pipe', timeout: 25_000 });
    expect(existsSync(join(root, 'test-started'))).toBe(true);
    for (const file of ['exceljs.min.js', 'fflate.min.js', 'xterm-zerolag-input.js'])
      expect(readFileSync(join(root, 'src/web/public/vendor', file)).length).toBeGreaterThan(100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(commands)('%s stops before its test runner when browser preparation fails', (command) => {
  const root = lifecycleFixture(command);
  try {
    rmSync(join(root, 'packages/xterm-zerolag-input/src/zerolag-input-addon.ts'));
    const result = spawnSync('npm', ['run', command, '--silent'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 25_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('[test-vendor] missing input:');
    expect(existsSync(join(root, 'test-started'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('coverage lifecycle refuses invalid public assets before entering coverage', () => {
  const root = lifecycleFixture();
  writeFileSync(join(root, 'src/web/public/app.js'), Buffer.from([0]));
  try {
    const result = spawnSync('npm', ['run', 'test:coverage', '--silent'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 25_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('contains literal NUL byte');
    expect(existsSync(join(root, 'test-started'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('frontend public asset tooling', () => {
  it('exposes a public asset check script', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['check:public-assets']).toContain('scripts/check-public-assets.mjs');
  });

  it('keeps app.js free of literal NUL bytes', () => {
    const appJs = readFileSync(resolve(repoRoot, 'src/web/public/app.js'));

    expect(appJs.includes(0)).toBe(false);
  });

  it('uses the same message wrapper for brief and full response views', () => {
    const appJs = readFileSync(resolve(repoRoot, 'src/web/public/app.js'), 'utf8');

    expect(appJs).toContain("body.appendChild(this._buildResponseViewerMessage(lastResponse, 'assistant'");
    expect(appJs).toContain(
      'body.appendChild(this._buildResponseViewerMessage(msg.text, msg.role, agentLabel, { ...msg, continuation }));'
    );
    // ⚠️ A numeric `turn` gates continuation rendering. Only the Claude reader
    // emits turns; Codex, the external-CLI pane parser and an older server emit
    // adjacent same-role messages with none, and must keep one badge per card.
    expect(appJs).toContain(
      "!!previous && previous.role === msg.role && typeof msg.turn === 'number' && previous.turn === msg.turn"
    );
    expect(appJs).toContain("div.className = 'rv-message ' + (isUser ? 'rv-msg-user' : 'rv-msg-assistant');");
    expect(appJs).toContain("renderedText.className = 'rv-text';");
  });

  it('runs the public asset check script', () => {
    expect(() => {
      execFileSync('npm', ['run', 'check:public-assets', '--silent'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});
