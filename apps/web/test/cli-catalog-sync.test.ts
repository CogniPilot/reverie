/** The committed image-builder catalogue must match the stock CLI registry. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCatalogJson } from '../scripts/generate-cli-catalog.mts';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const REGENERATE = 'Run `npm run generate:cli-catalog` and commit the result.';

const jsonPath = fileURLToPath(new URL('../config/clis.stock.json', import.meta.url));

describe('generated CLI catalogue artifacts', () => {
  it('config/clis.stock.json matches a fresh generation', () => {
    expect(readFileSync(jsonPath, 'utf-8'), `config/clis.stock.json is stale. ${REGENERATE}`).toBe(renderCatalogJson());
  });

  it('exports every stock CLI, carrying the enabled flag', () => {
    const exported = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Array<{ id: string; enabled: boolean }>;
    expect(exported.map((e) => e.id)).toEqual(STOCK_CLIS.map((e) => e.id as string));
    // The field the previous attempt omitted, which let a disabled CLI's npm package be baked
    // into every agent image. Its PRESENCE is the contract; its value is whatever stock says.
    for (const entry of exported) {
      expect(typeof entry.enabled, `${entry.id} has no enabled flag`).toBe('boolean');
    }
  });

  it('exports no spawn-time fields', () => {
    // launch/env/capabilities/overlays are the server's alone. Exporting them would invite a
    // second reading of the launch model in a consumer that cannot be tested against a spawn.
    const raw = readFileSync(jsonPath, 'utf-8');
    for (const forbidden of ['"launch"', '"env"', '"capabilities"', '"overlays"']) {
      expect(raw.includes(forbidden), `${forbidden} leaked into the exported catalogue`).toBe(false);
    }
  });

});
