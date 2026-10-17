/**
 * @fileoverview Route coverage for the document preview/thumbnail endpoints
 * added in COD-38 (PR #120): the by-attachmentId routes
 * (/attachments/:id/preview|thumbnail) and the workspace-path routes
 * (/file-preview|/file-thumbnail). Converters are mocked, so no real
 * pdftoppm/LibreOffice is needed. Uses app.inject() — no real ports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => Buffer.from('%PDF-1.4 fake pdf bytes')),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, mtimeMs: 1 })),
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-preview-test'),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn((p: string) => p) };
});

// Mock the converters so the routes don't shell out to real binaries.
vi.mock('../../src/document-thumbnailer.js', () => ({
  generateFirstPageThumbnail: vi.fn(async () => ({ content: Buffer.from('\x89PNG fake'), contentType: 'image/png' })),
}));
vi.mock('../../src/document-preview-cache.js', () => ({
  getOfficePreviewPdfPath: vi.fn(async () => '/tmp/codeman-document-preview-cache/out.pdf'),
  getPreviewPdfDownloadName: vi.fn((name: string) => `${name.replace(/\.[^.]+$/, '')}.pdf`),
}));

import { generateFirstPageThumbnail } from '../../src/document-thumbnailer.js';
import { getOfficePreviewPdfPath } from '../../src/document-preview-cache.js';
import { attachmentRegistry, type AttachmentRecord } from '../../src/attachment-registry.js';

const SID = 'test-session-1';
const WORKDIR = '/tmp/test-workdir';

function makeRecord(over: Partial<AttachmentRecord>): AttachmentRecord {
  return {
    attachmentId: 'att_x',
    sessionId: SID,
    filePath: `${WORKDIR}/file`,
    fileName: 'file',
    extension: 'pdf',
    attachmentType: 'document',
    size: 100,
    mtimeMs: 1,
    timestamp: 1,
    source: 'detected',
    ...over,
  };
}

describe('file-routes preview/thumbnail (COD-38)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes, { sessionId: SID });
    vi.clearAllMocks();
    attachmentRegistry.clearSession(SID);
  });

  afterEach(async () => {
    await harness.app.close();
    attachmentRegistry.clearSession(SID);
  });

  // ---- workspace-path routes ----

  it('file-preview converts a workspace DOCX to an inline PDF', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/file-preview?path=deck.docx` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(getOfficePreviewPdfPath).toHaveBeenCalled();
  });

  it('file-preview redirects a non-Office workspace file (PDF) to the raw route', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/file-preview?path=report.pdf` });
    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toContain('/file-raw?path=report.pdf');
    expect(getOfficePreviewPdfPath).not.toHaveBeenCalled();
  });

  it('file-preview 400s for a missing path parameter', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/file-preview` });
    expect(res.statusCode).toBe(400);
  });

  it('file-thumbnail returns a PNG for a supported workspace file', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/file-thumbnail?path=deck.pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(generateFirstPageThumbnail).toHaveBeenCalled();
  });

  it('file-thumbnail 400s for an unsupported extension', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/file-thumbnail?path=notes.exe` });
    expect(res.statusCode).toBe(400);
    expect(generateFirstPageThumbnail).not.toHaveBeenCalled();
  });

  // ---- by-attachmentId routes ----

  it('by-id preview converts a registered DOCX attachment', async () => {
    attachmentRegistry.register(
      makeRecord({
        attachmentId: 'att_docx',
        filePath: `${WORKDIR}/deck.docx`,
        fileName: 'deck.docx',
        extension: 'docx',
      })
    );
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SID}/attachments/att_docx/preview`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('by-id preview redirects a non-Office attachment (PNG) to its raw route', async () => {
    attachmentRegistry.register(
      makeRecord({ attachmentId: 'att_png', filePath: `${WORKDIR}/shot.png`, fileName: 'shot.png', extension: 'png' })
    );
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SID}/attachments/att_png/preview`,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toContain('/attachments/att_png/raw');
  });

  it('by-id thumbnail returns a PNG for a registered attachment', async () => {
    attachmentRegistry.register(
      makeRecord({ attachmentId: 'att_pdf', filePath: `${WORKDIR}/deck.pdf`, fileName: 'deck.pdf', extension: 'pdf' })
    );
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SID}/attachments/att_pdf/thumbnail`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });
});
