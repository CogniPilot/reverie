/** Disposable hosted runner only. Builds the maintained test factories, loads
 * only fresh CI tags and passes actual Engine IDs to the real native canary. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

assert.deepEqual(process.argv.slice(2), ['--ci']);
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use explicit qualified IDs for local native acceptance');
assert.equal(process.env.REVERIE_CI_RUNNER_ENVIRONMENT, 'github-hosted', 'No self-hosted production Engine');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const temp = process.env.RUNNER_TEMP;
assert.ok(temp && path.isAbsolute(temp));
const prefix = 'reverie-ci-memory-high-' + randomBytes(16).toString('hex');
const evidence = path.join(temp, prefix);
fs.mkdirSync(evidence, { mode: 0o700 });
const source = fileURLToPath(new URL('../../..', import.meta.url));
const configuration = path.join(evidence, 'docker-config');
fs.mkdirSync(configuration, { mode: 0o700 });
const env = {
  ...process.env,
  DOCKER_CONFIG: configuration,
  DOCKER_HOST: 'unix:///var/run/docker.sock',
};
let serial = 0;
function save(name: string, value: unknown): void {
  const fd = fs.openSync(path.join(evidence, name + '.json'), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function run(label: string, program: string, args: string[], timeout = 120000): string {
  const key = String(++serial).padStart(3, '0') + '-' + label;
  save(key + '-intent', { program, args });
  const result = spawnSync(program, args, {
    cwd: source,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  save(key + '-result', {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.error, undefined, label + ' outcome unconfirmed');
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const head = run('head', 'git', ['rev-parse', 'HEAD']).trim();
assert.equal(run('clean', 'git', ['status', '--porcelain']), '', 'Commit all image/runner source first');
save('plan', {
  head,
  prefix,
  purpose: 'reverie-memory-high-native-ci-v1',
  companyAcceptance: false,
});
const archived = JSON.parse(
  run('archive-source', 'nix', ['flake', 'archive', '--json', '--no-write-lock-file', source])
) as { path: string };
assert.match(archived.path, /^\/nix\/store\/[a-z0-9]{32}-source$/u);
assert.equal(fs.realpathSync(archived.path), archived.path);
const locked = JSON.parse(
  run('lock-archived-source', 'nix', ['flake', 'metadata', '--json', '--no-write-lock-file', archived.path])
) as { path: string; url: string; locked: { type: string; path: string; narHash: string } };
assert.equal(locked.path, archived.path);
assert.equal(locked.locked.type, 'path');
assert.equal(locked.locked.path, archived.path);
assert.match(locked.locked.narHash, /^sha256-[A-Za-z0-9+/]+=*$/u);
assert.ok(locked.url.startsWith('path:' + archived.path + '?'));
save('locked-source', { path: locked.path, lockedReference: locked.url, narHash: locked.locked.narHash });
const expression = `let source = builtins.getFlake ${JSON.stringify(locked.url)}; in import (source.outPath + "/nix/docker-memory-high-native-images.nix") { pkgs = import source.inputs.nixpkgs { system = "x86_64-linux"; }; src = source.outPath; namePrefix = ${JSON.stringify(prefix)}; }`;
const out = path.join(evidence, 'images');
run(
  'build-images',
  'nix',
  ['build', '--expr', expression, '--no-write-lock-file', '--max-jobs', '1', '--cores', '2', '--out-link', out, '-L'],
  1800000
);
const metadata = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as Record<string, unknown>;
assert.deepEqual(metadata, {
  version: 1,
  purpose: 'reverie-ci-memory-high-images-v1',
  namePrefix: prefix,
  baselineTag: prefix + '-baseline:latest',
  writerTag: prefix + '-writer:latest',
  imageIdentity: 'actual-engine-inspection-required',
});
const ids: string[] = [];
for (const role of ['baseline', 'writer']) {
  const tag = prefix + '-' + role + ':latest';
  assert.equal(
    run('tag-absent-' + role, 'docker', [
      '--host',
      'unix:///var/run/docker.sock',
      'image',
      'ls',
      '--quiet',
      '--no-trunc',
      '--filter',
      'reference=' + tag,
    ]).trim(),
    '',
    'Refuse an existing tag before image load'
  );
  const archive = fs.realpathSync(path.join(out, role + '.tar.gz'));
  assert.ok(archive.startsWith('/nix/store/'));
  run('load-' + role, 'docker', ['--host', 'unix:///var/run/docker.sock', 'image', 'load', '--input', archive]);
  const image = JSON.parse(
    run('actual-image-' + role, 'docker', ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', tag])
  )[0] as { Id: string; RepoTags: string[] };
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(image.RepoTags.includes(tag));
  assert.ok(
    image.RepoTags.every((value) => value.startsWith(prefix + '-')),
    'Refuse unexpected non-CI aliases'
  );
  ids.push(image.Id);
  save('selected-' + role, {
    archive,
    actualImageId: image.Id,
    actualRepoTags: image.RepoTags,
    notArchiveConfigHashInference: true,
  });
}
assert.equal(run('source-still-current', 'git', ['rev-parse', 'HEAD']).trim(), head);
assert.equal(run('source-still-clean', 'git', ['status', '--porcelain']), '');
run('actual-native', process.execPath, [
  '--experimental-strip-types',
  path.join(source, 'apps/web/test/fixtures/docker-memory-high-canary.ts'),
  ids[0],
  ids[1],
  path.join(evidence, 'native'),
]);
const originalReader = fs.realpathSync(path.join(out, 'original-writer.mjs'));
assert.ok(originalReader.startsWith('/nix/store/'));
assert.ok(fs.statSync(originalReader).isFile());
const originalReply = run('actual-original-helper', process.execPath, [
  originalReader,
  ids[0],
  ids[1],
  path.join(evidence, 'original-helper'),
]);
assert.equal(originalReply.trim(), 'Original helper metadata closure accepted; no current-policy claim.');
save('completed', {
  status: 0,
  head,
  baselineImageId: ids[0],
  writerImageId: ids[1],
  realKernelAcceptance: true,
  originalStoppedWorkerReaderAcceptance: true,
  companyAcceptance: false,
});
process.stdout.write(
  JSON.stringify({
    status: 0,
    evidence,
    realKernelAcceptance: true,
    originalStoppedWorkerReaderAcceptance: true,
    companyAcceptance: false,
  }) + '\n'
);
