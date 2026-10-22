#!/usr/bin/env node
/**
 * @fileoverview Build the opt-in gesture-overlay bundle from its vendored source
 * in `packages/gesture-control/` into the web bundle Reverie actually serves,
 * `src/web/public/gesture/gesture-reverie.js`.
 *
 * The source lives in this repo (workspace package `reverie-gesture-control`,
 * was the standalone `Ark0N/codeman-gesture-control` repo before it was vendored
 * in). `src/reverie/entry.ts` is the Reverie *consumer* entry — it imports the
 * transport-agnostic gesture core (`src/gesture/*`) and maps grab/drag/drop onto
 * Reverie's real session tabs + toolbar buttons. esbuild bundles it (MediaPipe
 * tasks-vision JS included) into a single ESM file; the MediaPipe wasm + model
 * are loaded at runtime from same-origin `/gesture/wasm` + `/gesture/*.task`
 * (fetched separately by scripts/fetch-gesture-assets.mjs), NOT bundled here.
 *
 * Run it after editing anything under packages/gesture-control/src/ and commit
 * the regenerated bundle (the committed copy is what `npm run dev` / tsx serves,
 * since the web UI ships as plain JS with no bundler). `npm run build` also runs
 * this so a production build always reflects the current source.
 *
 * Usage: node scripts/build-gesture-bundle.mjs [--out <path>]
 *   --out  output file (default src/web/public/gesture/gesture-reverie.js)
 *
 * NOT minified — matches the historical bundle and keeps it debuggable; the
 * build's compress step gzips/brotlis it for production anyway.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join, dirname, isAbsolute } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'packages/gesture-control/src/reverie/entry.ts');
const DEFAULT_OUT = join(ROOT, 'src/web/public/gesture/gesture-reverie.js');

const outArg = process.argv[process.argv.indexOf('--out') + 1];
const outfile =
  process.argv.includes('--out') && outArg
    ? isAbsolute(outArg)
      ? outArg
      : join(process.cwd(), outArg)
    : DEFAULT_OUT;

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile,
  logLevel: 'info',
});

console.log(`[gesture] bundle built → ${outfile}`);
