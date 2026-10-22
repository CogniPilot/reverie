/**
 * Generate config/clis.stock.json from the stock CLI registry.
 * Run npm run generate:cli-catalog, or append -- --check to check for drift.
 * Only fields needed by the image builders are exported.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';

const JSON_PATH = fileURLToPath(new URL('../config/clis.stock.json', import.meta.url));
interface CatalogEntry {
  id: string;
  label: string;
  shortBadge: string;
  enabled: boolean;
  order: number;
  kind: string;
  discovery: {
    binaries: string[];
    searchDirs: string[];
    identity?: { arg: string; regex: string };
    install: {
      command: Record<string, string>;
      npmPackage?: string;
      docsUrl?: string;
      agentImageLayer?: { kind: 'dedicated'; reason: string };
    };
  };
}

function toCatalogEntry(entry: CliEntry): CatalogEntry {
  const { binaries, searchDirs, identity, install } = entry.discovery;
  return {
    id: entry.id as string,
    label: entry.label,
    shortBadge: entry.shortBadge,
    // ⚠️ The field the previous attempt omitted, which is how a disabled CLI's npm package
    // still got baked into every agent image. Every consumer filters on it.
    enabled: entry.enabled,
    order: entry.order,
    kind: entry.kind,
    discovery: {
      binaries: [...binaries],
      searchDirs: [...searchDirs],
      ...(identity ? { identity: { arg: identity.arg, regex: identity.regex } } : {}),
      install: {
        command: { ...install.command } as Record<string, string>,
        ...(install.npmPackage ? { npmPackage: install.npmPackage } : {}),
        ...(install.docsUrl ? { docsUrl: install.docsUrl } : {}),
        ...(install.agentImageLayer ? { agentImageLayer: { ...install.agentImageLayer } } : {}),
      },
    },
  };
}

export function renderCatalogJson(entries: CliEntry[] = STOCK_CLIS): string {
  return `${JSON.stringify(entries.map(toCatalogEntry), null, 2)}\n`;
}

/**
 * ⚠️ Guarded so the module can be IMPORTED for its pure renderers without running.
 * `test/cli-catalog-sync.test.ts` imports them, and an unguarded main would have that test
 * rewrite the very artifacts it is supposed to be checking — passing always, guarding never.
 */
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return fileURLToPath(import.meta.url) === resolve(invoked);
}

function main(): void {
  const check = process.argv.includes('--check');
  const wantJson = renderCatalogJson();

  if (check) {
    const drift: string[] = [];
    if (readFileSync(JSON_PATH, 'utf-8') !== wantJson) drift.push('config/clis.stock.json');
    if (drift.length > 0) {
      console.error(`Out of date with stock.ts: ${drift.join(', ')}`);
      console.error('Run `npm run generate:cli-catalog` and commit the result.');
      process.exit(1);
    }
    console.log('CLI catalogue artifacts are in sync with stock.ts.');
  } else {
    writeFileSync(JSON_PATH, wantJson, 'utf-8');
    console.log(`Wrote config/clis.stock.json (${STOCK_CLIS.length} entries).`);
  }
}

if (isMainModule()) main();
