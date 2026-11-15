/** Pure build construction/locked dependency checks. Never builds or calls Docker. */
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { planOfficeAssetSources, requirePlanOfficeDependencyLock } from '../scripts/build-plan-office.mjs';
const factory = path.resolve('../../nix/ci-plan-office-images.nix');
const good = 'sha256:' + 'a'.repeat(64),
  ns = 'reverie-ci-plan-office-' + 'b'.repeat(32);
function evaluate(
  overrides = '',
  expression = 'builtins.toJSON { metadata=f.metadata; worker=f.workerImage; source=f.sourceImage; helper=f.helperImage; control=f.mkControl {workerImageId="' +
    good +
    '";sourceImageIds=["' +
    good +
    '"];helperImageId="' +
    good +
    '";}; }'
) {
  const code = `let pkgs={lib.optionalAttrs=condition: value: if condition then value else {};runCommand=name: attrs:  script: "/fake/"+name;buildEnv=attrs: "/fake/platform";closureInfo=attrs: "/fake/closure";writeText=name: text: "/fake/config";dockerTools.buildLayeredImage=x: x;nodejs_22="/fake/node";esbuild="/fake/esbuild";bashInteractive="/fake/bash";coreutils="/fake/core";findutils="/fake/find";gnugrep="/fake/grep";gnused="/fake/sed";gawk="/fake/awk";util-linux="/fake/util";python3="/fake/python";docker-client="/fake/docker";tmux="/fake/tmux";}; f=import ${JSON.stringify(factory)} ({inherit pkgs;src="/owning/source";dependencyConsole="/deps-only";imageNamespace="${ns}";clientCapsule="/capsule";clientManifestDigest="${'c'.repeat(64)}";initCapsule="/init";workerTools="/tools";resourceHelper="/helper";} // {${overrides}}); in ${expression}`;
  return spawnSync('nix-instantiate', ['--eval', '--strict', '--expr', code], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}
it('preserves ordinary current-source control and fixed unprivileged worker image contracts in unique CI namespaces', () => {
  const r = evaluate();
  expect(r.status, r.stderr).toBe(0);
  const v = JSON.parse(JSON.parse(r.stdout));
  expect(v.metadata.sourcePath).toBe('/owning/source');
  expect(v.metadata.controlPort).toBe(3000);
  for (const role of ['source', 'worker', 'helper', 'control']) expect(v[role].name).toBe(ns + '-' + role);
  expect(v.worker.config.Entrypoint).toEqual(['/opt/reverie/perf/bin/reverie-worker-init']);
  expect(v.worker.config.Cmd).toEqual([]);
  expect(v.worker.config.Env).toContain('TERMINFO=/opt/reverie-worker-tools/share/terminfo');
  expect(v.worker.fakeRootCommands).toContain('cp /helper/bin/reverie-docker-resources');
  expect(v.control.config.Cmd).toEqual(['web', '--host', '0.0.0.0', '--port', '3000']);
  expect(v.control.config.Entrypoint).toEqual([
    '/fake/node/bin/node',
    '/fake/reverie-ci-plan-office-runtime/lib/reverie/dist/index.js',
  ]);
  expect(v.control.passthru.runtimeConfiguration).toEqual({
    version: 1,
    purpose: 'reverie-boxed-runtime-v1',
    deployment: ns,
    workerImageId: good,
    sourceImageIds: [good],
    helperImageId: good,
    clientManifestDigest: 'c'.repeat(64),
    apiUrl: 'http://reverie:3000',
  });
  expect(v.control.config.Env).toContain('REVERIE_RUNTIME_BACKEND=boxed-docker-v1');
  expect(v.control.config.Env).toContain('REVERIE_DATA_DIR=/fixture/data');
  expect(v.control.config.Env).not.toContainEqual(expect.stringMatching(/BROKER|WORKER_SOCKET/));
});
it('rejects generic/invalid namespaces and malformed manifest or actual Engine IDs before image construction', () => {
  for (const override of [
    'imageNamespace="reverie-boxed";',
    'imageNamespace="' + ns.toUpperCase() + '";',
    'clientManifestDigest="short";',
  ])
    expect(evaluate(override).status).not.toBe(0);
  for (const tuple of [
    'workerImageId="latest";sourceImageIds=["' + good + '"];helperImageId="' + good + '";',
    'workerImageId="' + good + '";sourceImageIds=[];helperImageId="' + good + '";',
    'workerImageId="' + good + '";sourceImageIds=["tag:latest"];helperImageId="' + good + '";',
  ])
    expect(evaluate('', 'builtins.toJSON (f.mkControl {' + tuple + '})').status).not.toBe(0);
});
it('accepts only dependency versions and integrity from the same current source lock', () => {
  const source = { packages: { 'node_modules/zod': { version: '4.3.6', integrity: 'sha512-fixture' } } };
  expect(() => requirePlanOfficeDependencyLock(source, source)).not.toThrow();
  const workspace = {
    packages: { 'node_modules/xterm-zerolag-input': { link: true, resolved: 'packages/xterm-zerolag-input' } },
  };
  expect(() => requirePlanOfficeDependencyLock(workspace, workspace)).not.toThrow();
  expect(() =>
    requirePlanOfficeDependencyLock(
      { packages: { 'node_modules/x': { link: true, resolved: '../outside' } } },
      { packages: { 'node_modules/x': { link: true, resolved: '../outside' } } }
    )
  ).toThrow();
  for (const entry of [
    { version: '4.3.7', integrity: 'sha512-fixture' },
    { version: '4.3.6', integrity: 'changed' },
    { link: true, version: '4.3.6', integrity: 'sha512-fixture' },
  ])
    expect(() => requirePlanOfficeDependencyLock({ packages: { 'node_modules/zod': entry } }, source)).toThrow();
  expect(() => requirePlanOfficeDependencyLock({ packages: {} }, source)).toThrow();
  expect(() =>
    requirePlanOfficeDependencyLock({ packages: { 'node_modules/unlocked': { version: '1' } } }, source)
  ).toThrow();
});

it('resolves mandatory assets against the actual monorepo layout and canonical root skill', () => {
  const source = path.resolve('../..'),
    assets = planOfficeAssetSources(source);
  expect(assets.map((asset) => [path.relative(source, asset.source), asset.destination])).toEqual([
    ['apps/web/scripts', 'scripts'],
    ['apps/web/packages', 'packages'],
    ['skills/reverie', 'skills/reverie'],
  ]);
  for (const asset of assets) expect(fs.lstatSync(asset.source).isDirectory(), asset.source).toBe(true);
  const skill = assets.find((asset) => asset.destination === 'skills/reverie')!;
  expect(fs.statSync(path.join(skill.source, 'SKILL.md')).isFile()).toBe(true);
  expect(fs.readFileSync(path.join(skill.source, 'SKILL.md'), 'utf8').length).toBeGreaterThan(100);
});
