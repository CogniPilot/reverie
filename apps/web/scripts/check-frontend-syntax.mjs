#!/usr/bin/env node
/**
 * Frontend JS syntax check.
 *
 * CI's `npm run lint` only lints TypeScript under src/, and `tsc` excludes the
 * frontend — so a plain SyntaxError in a shipped `src/web/public` script (loaded
 * as a bare <script>, no bundler) passes CI green yet breaks the whole module at
 * load.
 * (This is exactly how PR #112's duplicate-`const` error in session-ui.js slipped
 * through.) This runs `node --check` (parse-only; browser globals don't matter)
 * on every shipped frontend script so that class of bug fails fast.
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'src', 'web', 'public');

const files = readdirSync(PUBLIC_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(PUBLIC_DIR, f));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    const msg = err.stderr ? err.stderr.toString() : String(err);
    console.error(`✗ syntax error in ${file.replace(ROOT + '/', '')}:\n${msg}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} frontend file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`✓ ${files.length} frontend JS files parse cleanly`);
