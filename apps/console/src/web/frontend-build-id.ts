/**
 * @fileoverview Fingerprint of the frontend this server process serves.
 *
 * Sent in the SSE `init` payload as `buildId`. A browser that connected to an
 * earlier server process sees a different id when SSE reconnects after a deploy,
 * and offers a reload (update-notice.js) instead of running stale code against
 * the new server.
 *
 * The package version does not change on local rebuilds and the build's own
 * hash covers only the hashed assets, so this hashes the CONTENT of what the
 * page loads, once, at startup: the top-level html/js/css plus everything in
 * the subdirectories index.html loads from (`vendor/`, `fonts/`). `gesture/` is
 * left out on purpose: its bundle is injected only when the feature is on and
 * its fetched wasm/model assets are large. A restart that serves identical
 * files keeps the same id, so it never nags.
 */

import { createHash, type Hash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TOP_LEVEL = /\.(html|js|css)$/;
/** Subdirectories whose files the page itself loads (scripts, styles, preloaded fonts). */
export const FINGERPRINTED_DIRS = ['vendor', 'fonts'] as const;

function addFiles(hash: Hash, dir: string, prefix: string, keep: (name: string) => boolean): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter(keep).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      hash
        .update(prefix + name)
        .update('\0')
        .update(readFileSync(path))
        .update('\0');
    } catch {
      /* a file that vanished mid-scan is simply not part of the fingerprint */
    }
  }
}

export function computeFrontendBuildId(publicDir: string): string {
  try {
    if (!statSync(publicDir).isDirectory()) return 'unknown';
  } catch {
    return 'unknown';
  }
  const hash = createHash('sha256');
  addFiles(hash, publicDir, '', (n) => TOP_LEVEL.test(n));
  for (const sub of FINGERPRINTED_DIRS) addFiles(hash, join(publicDir, sub), `${sub}/`, () => true);
  return hash.digest('hex').slice(0, 16);
}
