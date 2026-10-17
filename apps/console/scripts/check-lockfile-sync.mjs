#!/usr/bin/env node
// Fails if package-lock.json's version fields don't match package.json.
// Changesets bumps package.json but NOT the lockfile — this catches that drift
// (the top-level `version` in lockfiles is metadata, so `npm ci` won't flag it).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'));

const expected = pkg.version;
const rootVersion = lock.version;
const selfVersion = lock.packages?.['']?.version;

const mismatches = [];
if (rootVersion !== expected) mismatches.push(`  package-lock.json#.version = ${rootVersion} (expected ${expected})`);
if (selfVersion !== expected) mismatches.push(`  package-lock.json#.packages[""].version = ${selfVersion} (expected ${expected})`);

if (mismatches.length > 0) {
  console.error(`\nLockfile version drift detected (package.json is ${expected}):`);
  console.error(mismatches.join('\n'));
  console.error('\nFix: run `npm install --package-lock-only` and commit the updated package-lock.json.\n');
  process.exit(1);
}

console.log(`Lockfile in sync with package.json (${expected}).`);
