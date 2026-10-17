import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { clearDocumentPreviewCache, getOfficePreviewPdfPath } from '../src/document-preview-cache.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd, _args, _options, callback) => {
    setTimeout(() => callback(null, { stdout: '', stderr: '' }), 1);
    return {};
  }),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-document-preview-cache/work-test'),
    readdir: vi.fn(async () => ['deck.pdf']),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

const mockedExecFile = vi.mocked(execFile);
const mockedStat = vi.mocked(fs.stat);
const mockedRename = vi.mocked(fs.rename);

describe('document-preview-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDocumentPreviewCache();

    let cachedPdfExists = false;
    mockedStat.mockImplementation(async (path) => {
      const pathText = String(path);
      if (pathText.includes('codeman-document-preview-cache') && pathText.endsWith('.pdf')) {
        if (!cachedPdfExists) throw new Error('ENOENT');
        return { size: 4096, isFile: () => true } as never;
      }

      return { size: 1845494, mtimeMs: 12345, isFile: () => true } as never;
    });
    mockedRename.mockImplementation(async () => {
      cachedPdfExists = true;
    });
    mockedExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === 'powershell.exe') {
        cachedPdfExists = true;
      }

      setTimeout(() => callback(null, { stdout: '', stderr: '' }), 1);
      return {} as never;
    });
  });

  it('deduplicates concurrent Office preview conversions and reuses the cached PDF', async () => {
    const [firstPath, secondPath] = await Promise.all([
      getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx'),
      getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx'),
    ]);
    const thirdPath = await getOfficePreviewPdfPath('/tmp/deck.pptx', 'pptx');

    expect(firstPath).toBeTruthy();
    expect(secondPath).toBe(firstPath);
    expect(thirdPath).toBe(firstPath);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile).toHaveBeenCalledWith(
      'soffice',
      expect.arrayContaining([
        '--headless',
        '--convert-to',
        'pdf',
        expect.stringMatching(/^-env:UserInstallation=file:/),
      ]),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('prefers Microsoft Word for DOCX files on Windows-mounted paths', async () => {
    const result = await getOfficePreviewPdfPath(
      '/mnt/c/Users/aakhter/Documents/codeman-inline-viewer-test.docx',
      'docx'
    );

    expect(result).toContain('/mnt/c/Users/aakhter/AppData/Local/Temp/codeman-document-preview-cache/');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']),
      expect.any(Object),
      expect.any(Function)
    );
    const powerShellCall = mockedExecFile.mock.calls.find(([cmd]) => cmd === 'powershell.exe');
    const encodedCommand = powerShellCall?.[1]?.at(-1);
    const decodedCommand = Buffer.from(String(encodedCommand), 'base64').toString('utf16le');
    expect(decodedCommand).toContain('$source = ');
    expect(decodedCommand).toContain('C:\\Users\\aakhter\\AppData\\Local\\Temp\\codeman-document-preview-cache\\');
    expect(decodedCommand).toContain('.docx');
    expect(decodedCommand).toContain('$output = ');
    expect(decodedCommand).toContain('.pdf');
    expect(mockedExecFile).not.toHaveBeenCalledWith(
      'soffice',
      expect.any(Array),
      expect.any(Object),
      expect.any(Function)
    );
  });
});
