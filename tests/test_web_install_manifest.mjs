import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import test from 'node:test';

const webRoot = new URL('../apps/web/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', webRoot), 'utf8'));
const target = 'scripts/reverie-postinstall.mjs';
const canonicalSource = Buffer.from(
  '// Installation never starts a server or changes a running installation.\n' +
    "console.log('Reverie installed. Build with npm run build; start with reverie web.');\n"
);

function explicitlyShipsHook(candidate) {
  return candidate.scripts?.postinstall === `node ${target}` && candidate.files?.includes(target) === true;
}

test('declared canonical hook is a regular source file and explicitly shipped', () => {
  assert.equal(lstatSync(new URL(target, webRoot)).isFile(), true);
  assert.equal(explicitlyShipsHook(manifest), true);
});

test('installation keeps canonical hook and enables no additional install hooks', () => {
  assert.equal(manifest.scripts.postinstall, `node ${target}`);
  for (const hook of ['preinstall', 'install', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    assert.equal(Object.hasOwn(manifest.scripts, hook), false, hook);
  }
});

test('canonical hook retains exact print-only bytes and empty import closure', () => {
  const source = readFileSync(new URL(target, webRoot));
  assert.deepEqual(source, canonicalSource);
  assert.equal(source.length, 158);
  assert.doesNotMatch(source.toString('utf8'), /\b(?:import|require)\s*(?:\(|\{|['"])/);
});

test('legacy shipped script cannot stand in for missing canonical target', () => {
  assert.equal(lstatSync(new URL('scripts/postinstall.js', webRoot)).isFile(), true);
  const missingTarget = { ...manifest, files: manifest.files.filter((entry) => entry !== target) };
  assert.equal(missingTarget.files.includes('scripts/postinstall.js'), true);
  assert.equal(explicitlyShipsHook(missingTarget), false);
  const legacyRedirect = { ...manifest, scripts: { ...manifest.scripts, postinstall: 'node scripts/postinstall.js' } };
  assert.equal(explicitlyShipsHook(legacyRedirect), false);
});

test('all pre-existing allowlist entries stay present and canonical target is unique', () => {
  for (const entry of ['dist', 'scripts/postinstall.js', 'scripts/fix-node-pty.mjs', 'skills', 'LICENSE', 'README.md']) {
    assert.equal(manifest.files.includes(entry), true, entry);
  }
  assert.equal(manifest.files.filter((entry) => entry === target).length, 1);
});
