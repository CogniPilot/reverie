/** The default web CI runs this in a real checkout; a packaged Nix source has no Git object database. */
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { sourceCatalog } from './helpers/browser-coverage.js';

it('inventories actual Git-verified source and proves fresh canonical generated output bytes', () => {
  const sources = sourceCatalog(resolve(import.meta.dirname, '..'));
  expect(sources.find((entry) => entry.asset === '/chat-app.js')).toMatchObject({
    provenance: 'raw-authored',
    kind: 'external',
  });
  expect(sources.find((entry) => entry.asset === '/gesture/gesture-reverie.js')).toMatchObject({ provenance: 'mixed' });
  for (const asset of ['xterm-zerolag-input.js', 'xterm-predictive-echo.js', 'exceljs.min.js', 'fflate.min.js'])
    expect(sources.find((entry) => entry.asset === '/vendor/' + asset)?.evidence).toMatch(/[Ff]resh canonical output/);
  expect(sources.filter((entry) => entry.provenance === 'raw-authored').length).toBeGreaterThan(70);
  expect(sources.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256) && /^[a-f0-9]{40}$/.test(entry.revision))).toBe(
    true
  );
});
