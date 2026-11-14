import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DOCKER_CODEX_WORKSPACE_PROGRAM } from '../src/docker-employee-codex-workspace.js';
import { generateCodexTurnSummaryHooks } from '../src/hooks-config.js';
import { reverieCodexHookTrustFromText } from '../src/codex-hook-trust.js';
let root: string, workspace: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boxed-codex-workspace-'));
  workspace = join(root, 'case');
  mkdirSync(workspace, { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = (args: string[], cwd = workspace) =>
  spawnSync(process.execPath, ['--input-type=commonjs', '-e', DOCKER_CODEX_WORKSPACE_PROGRAM, '--', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
    env: { PATH: process.env.PATH },
  });
const observe = () => run(['observe', workspace, root]);
describe('actual read-only worker workspace protocol', () => {
  it('observes actual directory identity without creating hooks or account config', () => {
    const before = readdirSync(workspace);
    const child = observe();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      realPath: workspace,
      dev: String(statSync(workspace, { bigint: true }).dev),
      ino: String(statSync(workspace, { bigint: true }).ino),
      hooksText: null,
    });
    expect(readdirSync(workspace)).toEqual(before);
  });
  it('reads actual generated handlers; classifier uses worker path and excludes foreign commands', () => {
    mkdirSync(join(workspace, '.codex'));
    const hooks = generateCodexTurnSummaryHooks();
    hooks.hooks.Stop = [{ hooks: [{ type: 'command', command: 'foreign-hook' }] }];
    writeFileSync(join(workspace, '.codex/hooks.json'), JSON.stringify(hooks));
    const child = observe();
    expect(child.status).toBe(0);
    const value = JSON.parse(child.stdout);
    const trust = reverieCodexHookTrustFromText(value.hooksText, [value.realPath]);
    expect(Object.keys(trust)).toHaveLength(4);
    expect(Object.keys(trust).every((key) => key.startsWith(workspace + '/.codex/hooks.json:'))).toBe(true);
    expect(Object.keys(trust).some((key) => key.includes(':stop:'))).toBe(false);
    hooks.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'edited-managed-hook' }] }];
    expect(Object.keys(reverieCodexHookTrustFromText(JSON.stringify(hooks), [workspace]))).toHaveLength(3);
  });
  it.each(['directory', 'file'])('refuses a symlinked hooks %s without reading or changing it', (kind) => {
    const external = join(root, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'hooks.json'), '{}');
    if (kind === 'directory') symlinkSync(external, join(workspace, '.codex'));
    else {
      mkdirSync(join(workspace, '.codex'));
      symlinkSync(join(external, 'hooks.json'), join(workspace, '.codex/hooks.json'));
    }
    expect(observe().status).toBe(1);
    expect(readdirSync(external)).toEqual(['hooks.json']);
  });
  it('refuses oversized hooks and an escape from the selected physical mount', () => {
    mkdirSync(join(workspace, '.codex'));
    writeFileSync(join(workspace, '.codex/hooks.json'), 'x'.repeat(1048577));
    expect(observe().status).toBe(1);
    expect(run(['observe', root, workspace]).status).toBe(1);
  });
  it('refuses a symlinked mount root rather than claiming mount identity from its spelling', () => {
    const alias = join(root, 'alias');
    symlinkSync(workspace, alias);
    expect(run(['observe', alias, alias]).status).toBe(1);
  });
  it('verifies the actual inherited cwd and refuses a replacement at the same pathname', () => {
    const child = observe(),
      value = JSON.parse(child.stdout);
    expect(run(['verify', value.realPath, value.dev, value.ino]).status).toBe(0);
    renameSync(workspace, workspace + '-old');
    mkdirSync(workspace);
    expect(run(['verify', value.realPath, value.dev, value.ino]).status).toBe(1);
  });
  it('refuses wrong inode, relative and traversal protocol arguments', () => {
    const value = JSON.parse(observe().stdout);
    expect(run(['verify', value.realPath, value.dev, '1']).status).toBe(1);
    expect(run(['observe', 'relative', root]).status).toBe(1);
    expect(run(['observe', workspace + '/../case', root]).status).toBe(1);
  });
  it.each(['ENOENT', 'EINTR'])(
    'does not acknowledge or retry an actual consumed hook close whose reply fails with %s',
    (code) => {
      mkdirSync(join(workspace, '.codex'));
      writeFileSync(join(workspace, '.codex/hooks.json'), JSON.stringify(generateCodexTurnSummaryHooks()));
      const injection = `const injectedFs=require('node:fs'), actualClose=injectedFs.closeSync, counts={}; let first=true;
      injectedFs.closeSync=fd=>{counts[fd]=(counts[fd]||0)+1; actualClose(fd); if(first){first=false;const e=Error('lost close reply');e.code=${JSON.stringify(code)};throw e;}};
      process.once('exit',()=>process.stderr.write(JSON.stringify(counts)));`;
      const child = spawnSync(
        process.execPath,
        ['--input-type=commonjs', '-e', injection + DOCKER_CODEX_WORKSPACE_PROGRAM, '--', 'observe', workspace, root],
        { encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH } }
      );
      expect(child.status).toBe(1);
      expect(child.stdout).toBe('');
      const counts = JSON.parse(child.stderr);
      expect(Object.keys(counts)).toHaveLength(3);
      expect(Object.values(counts).every((n) => n === 1)).toBe(true);
    }
  );
});
