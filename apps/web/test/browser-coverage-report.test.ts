import { SYNTHETIC_BROWSER_PRODUCER } from './helpers/browser-coverage-fixtures.js';
import { RAW_BROWSER_OBSERVATION_VERSION } from './helpers/browser-coverage-producer.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { catalogIdentity } from './helpers/browser-coverage.js';
import { writeBrowserCoverageReport } from '../scripts/report-browser-coverage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-report-'));
  roots.push(root);
  for (const dir of ['catalogs', 'sources', 'observations']) mkdirSync(join(root, dir));
  const code = 'globalThis;',
    sha256 = createHash('sha256').update(code).digest('hex');
  const assets = [
    '/app.js',
    '/chat-app.js',
    '/company-resources.js',
    '/owner/owner.js',
    '/company-plans.html',
    '/workspace-files.js',
  ];
  const sources = assets.map((asset, index) => ({
    id: 'fixture-source-' + index,
    asset,
    revision: 'a'.repeat(40),
    sha256,
    provenance: 'raw-authored',
    kind: asset.endsWith('.html') ? 'inline' : 'external',
    evidence: 'Synthetic unit source',
    aliases: [],
    codeLength: code.length,
    bytes: Buffer.byteLength(code),
  }));
  const catalogId = catalogIdentity(sources);
  writeFileSync(
    join(root, 'catalogs', catalogId + '.json'),
    JSON.stringify({ version: 1, sources, limitations: ['Synthetic unit fixture only'] })
  );
  writeFileSync(join(root, 'sources', sha256 + '.js'), code);
  const observation = {
    version: RAW_BROWSER_OBSERVATION_VERSION,
    producer: structuredClone(SYNTHETIC_BROWSER_PRODUCER),
    catalogId,
    fixture: 'synthetic report fixture',
    fixtureSources: { 'fixture.ts': 'b'.repeat(64) },
    omitted: [],
    frameGaps: [],
    entries: sources.map((source, index) => ({
      sourceId: source.id,
      sha256,
      scriptId: String(index),
      functions: [
        { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] },
      ],
      execution: {
        state: 'attributed',
        kind: index >= 4 ? 'iframe' : 'main',
        scriptId: String(index),
        sourceSha256: sha256,
        contextId: index,
        generation: 0,
        frameId: index >= 4 ? 'child' : 'main',
        mainFrameId: 'main',
        ancestry: index >= 4 ? ['child', 'main'] : ['main'],
      },
    })),
  };
  const save = () => writeFileSync(join(root, 'observations/one.json'), JSON.stringify(observation));
  save();
  return { root, observation, save, sha256 };
}

it('writes a validated raw summary through the explicit TypeScript CLI', () => {
  const { root } = fixture(),
    output = join(root, 'report/summary.json');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/report-browser-coverage.ts', root, output], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('No percentage or completeness claim');
  expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ version: 2, observations: 1, unvisitedOwned: [] });
});

it('exits nonzero for missing evidence and produces no success summary', () => {
  const { root } = fixture(),
    output = join(root, 'summary.json');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/report-browser-coverage.ts', join(root, 'absent'), output],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 15_000 }
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Browser coverage validation failed');
  expect(existsSync(output)).toBe(false);
});

it('refuses corrupt source snapshots before writing a report', () => {
  const { root, sha256 } = fixture(),
    output = join(root, 'summary.json');
  writeFileSync(join(root, 'sources', sha256 + '.js'), 'corrupt');
  expect(() => writeBrowserCoverageReport(root, output)).toThrow('snapshot is corrupt');
  expect(existsSync(output)).toBe(false);
});

it('refuses unqualified iframe data before writing a report', () => {
  const { root, observation, save } = fixture(),
    output = join(root, 'summary.json');
  observation.entries[4].execution = {
    ...observation.entries[4].execution,
    kind: 'main',
    frameId: 'main',
    ancestry: ['main'],
  };
  save();
  expect(() => writeBrowserCoverageReport(root, output)).toThrow('Actual iframe JavaScript coverage was not collected');
  expect(existsSync(output)).toBe(false);
});
