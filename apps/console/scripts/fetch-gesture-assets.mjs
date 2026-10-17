/**
 * @fileoverview Fetch the gesture-overlay runtime assets (MediaPipe wasm + the
 * gesture-recognizer model) into src/web/public/gesture/ so Codeman can serve
 * them same-origin (a browser content-blocker otherwise blocks the public CDNs
 * and the overlay fails to start). These are large binaries (~27 MB) kept OUT of
 * git (ignored explicitly via `src/web/public/gesture/wasm/` + `*.task` in
 * .gitignore); they are fetched here at install (postinstall) and build time.
 *
 * Idempotent: skips files already present. Non-fatal: the gesture overlay is
 * opt-in (CODEMAN_GESTURE=1), so a fetch failure only warns — it must not break
 * `npm install` / `npm run build`. The build then copies src/web/public into
 * dist/ as usual, so prod gets these too.
 *
 * The @mediapipe/tasks-vision version MUST match the one bundled into the gesture
 * overlay (Ark0N/codeman-gesture-control) so the wasm loader matches its JS API.
 */
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GESTURE = join(__dirname, '..', 'src', 'web', 'public', 'gesture');
const WASM = join(GESTURE, 'wasm');

const MP_VERSION = '0.10.21'; // keep in sync with the gesture overlay's @mediapipe/tasks-vision
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

const ASSETS = [
  { url: `${WASM_BASE}/vision_wasm_internal.js`, path: join(WASM, 'vision_wasm_internal.js') },
  { url: `${WASM_BASE}/vision_wasm_internal.wasm`, path: join(WASM, 'vision_wasm_internal.wasm') },
  { url: `${WASM_BASE}/vision_wasm_nosimd_internal.js`, path: join(WASM, 'vision_wasm_nosimd_internal.js') },
  { url: `${WASM_BASE}/vision_wasm_nosimd_internal.wasm`, path: join(WASM, 'vision_wasm_nosimd_internal.wasm') },
  { url: MODEL_URL, path: join(GESTURE, 'gesture_recognizer.task') },
];

async function main() {
  mkdirSync(WASM, { recursive: true });
  let fetched = 0;
  let skipped = 0;
  for (const a of ASSETS) {
    if (existsSync(a.path) && statSync(a.path).size > 0) {
      skipped++;
      continue;
    }
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${a.url}`);
    writeFileSync(a.path, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
  console.log(`[gesture] MediaPipe assets ready (${fetched} fetched, ${skipped} cached) → ${GESTURE}`);
}

main().catch((err) => {
  // Non-fatal: opt-in feature. Warn and exit 0 so install/build still succeed.
  console.warn(`[gesture] could not fetch MediaPipe assets — overlay disabled until fetched: ${err.message}`);
});
