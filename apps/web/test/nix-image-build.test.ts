import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function runBuild(failNix = false) {
  const root = mkdtempSync(join(tmpdir(), 'reverie-image-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'calls');
  for (const command of ['nix', 'docker']) {
    const path = join(bin, command);
    writeFileSync(path, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify([${JSON.stringify(command)},...process.argv.slice(2)])+'\\n'); process.exit(${command === 'nix' && failNix ? 7 : 0});\n`);
    chmodSync(path, 0o700);
  }
  const result = spawnSync(process.execPath, [resolve('scripts/build-agent-image.mjs'), '--image', 'local/agent:test'], {
    env: { ...process.env, PATH: bin, CALL_LOG: log, REVERIE_BUILD_DIR: join(root, 'build') }, encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  rmSync(root, { recursive: true, force: true });
  return { result, calls };
}

describe('shared Nix image deployment', () => {
  it('loads and tags only after building the root flake runtime', () => {
    const { result, calls } = runBuild();
    expect(result.status, result.stderr).toBe(0);
    expect(calls.map(call => call.slice(0, 2))).toEqual([['nix', 'build'], ['docker', 'load'], ['docker', 'tag']]);
    expect(calls[0][2]).toMatch(/#dockerImage$/);
    expect(calls[1][3]).toBe(calls[0][4]);
    expect(calls[2]).toEqual(['docker', 'tag', 'reverie:latest', 'local/agent:test']);
  });
  it('leaves loaded images untouched when the Nix build fails', () => {
    const { result, calls } = runBuild(true);
    expect(result.status).toBe(7);
    expect(calls).toHaveLength(1);
  });
});
