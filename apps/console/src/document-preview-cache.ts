/**
 * @fileoverview Shared disk cache for expensive Office document previews.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runWithConversionLimit } from './document-conversion-limiter.js';

const execFileAsync = promisify(execFile);

const OFFICE_CONVERSION_TIMEOUT_MS = 5 * 60_000;
const DOCUMENT_PREVIEW_CACHE_DIR = join(tmpdir(), 'codeman-document-preview-cache');
/**
 * Cap on persistent converted-PDF files kept in DOCUMENT_PREVIEW_CACHE_DIR.
 * The cache key embeds the source mtime, so every edit to a doc orphans its
 * prior PDF; without a cap the dir grows unbounded across long-running sessions.
 * Override with CODEMAN_MAX_PREVIEW_CACHE_FILES (clamped to >= 1).
 */
const MAX_PREVIEW_CACHE_FILES = (() => {
  const raw = Number(process.env.CODEMAN_MAX_PREVIEW_CACHE_FILES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 100;
})();
function buildWordExportPdfScript(sourcePath: string, outputPath: string): string {
  return `
$ErrorActionPreference = "Stop"
$source = ${toPowerShellSingleQuotedString(sourcePath)}
$output = ${toPowerShellSingleQuotedString(outputPath)}
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($source)
  $doc.ExportAsFixedFormat($output, 17)
} finally {
  if ($null -ne $doc) {
    $doc.Close($false) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
  }
  if ($null -ne $word) {
    $word.Quit() | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`.trim();
}

type OfficePreviewConverter = 'msword' | 'libreoffice';

const inFlightOfficeConversions = new Map<string, Promise<string | null>>();

export function clearDocumentPreviewCache(): void {
  inFlightOfficeConversions.clear();
}

/**
 * Best-effort LRU-ish eviction for the persistent converted-PDF cache: keeps at
 * most MAX_PREVIEW_CACHE_FILES `*.pdf` files in `cacheDir`, deleting the oldest
 * by mtime once over the cap. Never throws — a pruning failure must not fail the
 * conversion that triggered it. Only `*.pdf` files are considered, so the
 * transient `work-*` mkdtemp dirs are ignored.
 */
export async function pruneDocumentPreviewCache(cacheDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(cacheDir);
    const pdfs = entries.filter((name) => name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length <= MAX_PREVIEW_CACHE_FILES) return;

    const stats = await Promise.all(
      pdfs.map(async (name) => {
        const fullPath = join(cacheDir, name);
        try {
          const stat = await fs.stat(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs ?? 0 };
        } catch {
          return null;
        }
      })
    );

    const sorted = stats.filter((s): s is { fullPath: string; mtimeMs: number } => s !== null);
    sorted.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const toRemove = sorted.slice(0, Math.max(0, sorted.length - MAX_PREVIEW_CACHE_FILES));
    await Promise.all(toRemove.map((entry) => fs.rm(entry.fullPath, { force: true }).catch(() => {})));
  } catch {
    // Best-effort: pruning must never break a conversion.
  }
}

export async function getOfficePreviewPdfPath(filePath: string, extension: string): Promise<string | null> {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext !== 'docx' && ext !== 'pptx') return null;

  let sourceStat;
  try {
    sourceStat = await fs.stat(filePath);
  } catch {
    return null;
  }

  for (const converter of getOfficePreviewConverters(filePath, ext)) {
    const cacheKey = createDocumentPreviewCacheKey(filePath, ext, sourceStat.size, sourceStat.mtimeMs ?? 0, converter);
    const cachePath = getOfficePreviewCachePath(filePath, cacheKey, converter);

    if (await fileExists(cachePath)) {
      return cachePath;
    }

    const inFlightKey = `${converter}:${cacheKey}`;
    const inFlight = inFlightOfficeConversions.get(inFlightKey);
    if (inFlight) {
      const converted = await inFlight;
      if (converted) return converted;
      continue;
    }

    const conversion =
      converter === 'msword'
        ? convertWordDocumentToCachedPdf(filePath, cachePath)
        : convertLibreOfficeDocumentToCachedPdf(filePath, cachePath);
    inFlightOfficeConversions.set(inFlightKey, conversion);
    try {
      const converted = await conversion;
      if (converted) return converted;
    } finally {
      inFlightOfficeConversions.delete(inFlightKey);
    }
  }

  return null;
}

function getOfficePreviewConverters(filePath: string, extension: string): OfficePreviewConverter[] {
  if (extension === 'docx' && wslMountPathToWindowsPath(filePath)) {
    return ['msword', 'libreoffice'];
  }
  return ['libreoffice'];
}

function createDocumentPreviewCacheKey(
  filePath: string,
  extension: string,
  size: number,
  mtimeMs: number,
  converter: OfficePreviewConverter
): string {
  return createHash('sha256')
    .update(JSON.stringify({ cacheVersion: 2, converter, filePath, extension, size, mtimeMs }))
    .digest('hex')
    .slice(0, 32);
}

function getOfficePreviewCachePath(filePath: string, cacheKey: string, converter: OfficePreviewConverter): string {
  if (converter === 'msword') {
    const windowsCacheDir = getWindowsUserTempCacheDir(filePath);
    if (windowsCacheDir) {
      return join(windowsCacheDir, `${cacheKey}.pdf`);
    }
  }

  return join(DOCUMENT_PREVIEW_CACHE_DIR, `${cacheKey}.pdf`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return typeof stat.isFile !== 'function' || stat.isFile();
  } catch {
    return false;
  }
}

async function convertWordDocumentToCachedPdf(filePath: string, cachePath: string): Promise<string | null> {
  const outputPath = wslMountPathToWindowsPath(cachePath);
  if (!outputPath) return null;

  let sourceCopyPath: string | undefined;

  try {
    await fs.mkdir(dirname(cachePath), { recursive: true });
    sourceCopyPath = join(dirname(cachePath), `${basename(cachePath, '.pdf')}.docx`);
    await fs.copyFile(filePath, sourceCopyPath);

    const sourcePath = wslMountPathToWindowsPath(sourceCopyPath);
    if (!sourcePath) return null;

    await runWithConversionLimit(() =>
      execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodePowerShellCommand(buildWordExportPdfScript(sourcePath, outputPath)),
        ],
        {
          timeout: OFFICE_CONVERSION_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        }
      )
    );

    if (await fileExists(cachePath)) {
      await pruneDocumentPreviewCache(dirname(cachePath));
      return cachePath;
    }

    console.warn(`[DocumentPreviewCache] Microsoft Word did not produce PDF output for ${filePath}`);
    return null;
  } catch (err) {
    console.warn(
      `[DocumentPreviewCache] Failed to convert DOCX with Microsoft Word (${filePath}):`,
      getCacheErrorMessage(err)
    );
    return null;
  } finally {
    if (sourceCopyPath) {
      await fs.rm(sourceCopyPath, { force: true }).catch(() => {});
    }
  }
}

async function convertLibreOfficeDocumentToCachedPdf(filePath: string, cachePath: string): Promise<string | null> {
  let workDir: string | undefined;
  try {
    await fs.mkdir(DOCUMENT_PREVIEW_CACHE_DIR, { recursive: true });
    const outDir = await fs.mkdtemp(join(DOCUMENT_PREVIEW_CACHE_DIR, 'work-'));
    workDir = outDir;
    const profileDir = join(outDir, 'profile');
    await fs.mkdir(profileDir, { recursive: true });

    await runWithConversionLimit(() =>
      execFileAsync(
        'soffice',
        [
          '--headless',
          '--nologo',
          '--nofirststartwizard',
          `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
          '--convert-to',
          'pdf',
          '--outdir',
          outDir,
          filePath,
        ],
        {
          timeout: OFFICE_CONVERSION_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        }
      )
    );

    const converted = (await fs.readdir(outDir)).find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!converted) return null;

    await fs.rename(join(workDir, converted), cachePath);
    await pruneDocumentPreviewCache(DOCUMENT_PREVIEW_CACHE_DIR);
    return cachePath;
  } catch (err) {
    console.warn(
      `[DocumentPreviewCache] Failed to convert Office file to PDF (${filePath}):`,
      getCacheErrorMessage(err)
    );
    return null;
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function wslMountPathToWindowsPath(filePath: string): string | null {
  const match = filePath.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return null;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
}

function getWindowsUserTempCacheDir(filePath: string): string | null {
  const match = filePath.match(/^\/mnt\/([a-zA-Z])\/Users\/([^/]+)\//);
  if (!match) return null;
  return `/mnt/${match[1].toLowerCase()}/Users/${match[2]}/AppData/Local/Temp/codeman-document-preview-cache`;
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function getPreviewPdfDownloadName(fileName: string, extension: string): string {
  return `${basename(fileName, extname(fileName) || `.${extension}`)}.pdf`;
}

function getCacheErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
