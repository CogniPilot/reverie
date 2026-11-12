/** Validate raw synthetic Chromium evidence before publishing a summary. No percentage thresholds are implied. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRawBaseline } from '../test/helpers/browser-coverage.js';

export function writeBrowserCoverageReport(input: string, output: string) {
  const report = readRawBaseline(resolve(input));
  const target = resolve(output),
    temporary = target + '.' + randomUUID() + '.tmp';
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4)
      throw new Error('Usage: node --import tsx scripts/report-browser-coverage.ts <raw-directory> <summary.json>');
    const report = writeBrowserCoverageReport(process.argv[2], process.argv[3]);
    console.log(
      `Validated raw browser coverage: ${report.observations} observations, ${report.sources.length} sources; ${report.unvisitedOwned.length} unvisited owned sources. No percentage or completeness claim.`
    );
  } catch (error) {
    console.error(`Browser coverage validation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
