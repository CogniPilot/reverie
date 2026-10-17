/**
 * @fileoverview Route tests for file READ routes in a remote (SSH) case (#415).
 *
 * The mirror image of `test/routes/file-routes.test.ts`: every request here resolves
 * against a path that exists only on another host, so the local `fs` layer must never
 * be the thing that answers. The ssh layer (`src/remote-files.ts`) is mocked — a test
 * never opens a connection — but the REAL module is kept alongside the mocks so
 * `RemoteFileAccessError` and the command builders stay authentic.
 *
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { attachmentRegistry } from '../../src/attachment-registry.js';
import { RemoteFileAccessError } from '../../src/remote-files.js';
import type { RemoteProbe } from '../../src/remote-files.js';
import type { SessionRemote } from '../../src/types/session.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_FILE_DOWNLOAD_BYTES } from '../../src/config/buffer-limits.js';

// Keep the pure builders + the error class real; replace only the IO.
vi.mock('../../src/remote-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-files.js')>();
  return {
    ...actual,
    remoteProbePaths: vi.fn(),
    remoteReadFile: vi.fn(),
    remoteCreateReadStream: vi.fn(),
  };
});

import { remoteProbePaths, remoteReadFile, remoteCreateReadStream } from '../../src/remote-files.js';

const mockedProbePaths = vi.mocked(remoteProbePaths);
const mockedReadFile = vi.mocked(remoteReadFile);
const mockedCreateReadStream = vi.mocked(remoteCreateReadStream);

const REMOTE_DIR = '/srv/remote/case';
const remote: SessionRemote = {
  hostId: 'host-1',
  label: 'testhost',
  host: '192.0.2.10',
  username: 'j',
  remotePath: REMOTE_DIR,
};

function fileProbe(realPath: string, size: number): RemoteProbe {
  return { realPath, kind: 'file', size, mtimeMs: 1_700_000_000_000 };
}

const dirProbe: RemoteProbe = { realPath: REMOTE_DIR, kind: 'directory', size: 0, mtimeMs: 0 };

describe('file routes in a remote (SSH) case', () => {
  let harness: RouteTestHarness;
  let sessionId: string;
  let closeSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    sessionId = harness.ctx._sessionId;
    harness.ctx._session.attachmentHistory = [];
    // The whole point of the fixture: the workspace is a path on ANOTHER host.
    harness.ctx._session.workingDir = REMOTE_DIR;
    harness.ctx._session.remote = { ...remote };

    closeSpy = vi.fn();
    mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/img.png`, 9), dirProbe]);
    mockedReadFile.mockResolvedValue(Buffer.from('remote text'));
    mockedCreateReadStream.mockReturnValue({
      stream: Readable.from([Buffer.from('remote bytes')]),
      close: closeSpy,
    } as never);
  });

  afterEach(() => {
    // The registry is process-global: a record left behind would leak into the next
    // test's by-id requests.
    attachmentRegistry.clearSession(sessionId);
    vi.clearAllMocks();
  });

  describe('GET /api/sessions/:id/file-raw', () => {
    it('streams the remote file and probes the path AND the workspace in one call', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=img.png`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.body).toBe('remote bytes');
      // Both paths in one ssh round trip: the workspace root is needed to check
      // containment against a REMOTELY canonicalized root.
      expect(mockedProbePaths).toHaveBeenCalledWith(expect.objectContaining({ host: '192.0.2.10' }), [
        `${REMOTE_DIR}/img.png`,
        REMOTE_DIR,
      ]);
      expect(mockedCreateReadStream).toHaveBeenCalledWith(
        expect.objectContaining({ host: '192.0.2.10' }),
        `${REMOTE_DIR}/img.png`,
        undefined
      );
    });

    it('serves a byte range as a 206 from the remote host', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/clip.mp4`, 100), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=clip.mp4`,
        headers: { range: 'bytes=10-19' },
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 10-19/100');
      expect(res.headers['content-length']).toBe('10');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(mockedCreateReadStream).toHaveBeenCalledWith(expect.anything(), `${REMOTE_DIR}/clip.mp4`, {
        start: 10,
        end: 19,
      });
    });

    it('reaps the ssh stream when the response is done', async () => {
      await harness.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/file-raw?path=img.png` });
      // The cleanup is registered on the raw response's lifecycle; without it an
      // aborted download would leave the ssh child running.
      expect(closeSpy).toHaveBeenCalled();
    });

    it('refuses a path that escapes the workspace lexically, without connecting', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=../../etc/shadow`,
      });

      expect(res.statusCode).toBe(404);
      expect(mockedProbePaths).not.toHaveBeenCalled();
    });

    it('refuses a symlink that resolves outside the workspace on the remote host', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe('/etc/shadow', 10), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=innocent.png`,
      });

      expect(res.statusCode).toBe(404);
      expect(mockedCreateReadStream).not.toHaveBeenCalled();
    });

    it('accepts a workspace reached through a remote symlink (both sides canonicalized)', async () => {
      // remotePath is a symlinked mount: the file's realpath is genuinely inside the
      // workspace's realpath, so refusing it would break the whole case.
      harness.ctx._session.workingDir = '/mnt/link/case';
      mockedProbePaths.mockResolvedValue([
        fileProbe('/srv/real/case/img.png', 3),
        { realPath: '/srv/real/case', kind: 'directory', size: 0, mtimeMs: 0 },
      ]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=img.png`,
      });

      expect(res.statusCode).toBe(200);
    });

    it('404s a file that does not exist on the remote host', async () => {
      mockedProbePaths.mockResolvedValue([null, dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=gone.png`,
      });

      expect(res.statusCode).toBe(404);
      expect(mockedCreateReadStream).not.toHaveBeenCalled();
    });

    it('reports an unreachable host as a gateway failure, not a 404 or a 500', async () => {
      mockedProbePaths.mockRejectedValue(
        new RemoteFileAccessError('remote host testhost unreachable: Connection refused')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=img.png`,
      });

      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).error).toContain('Connection refused');
    });

    it('applies the size cap to the REMOTE size, before reading', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/huge.mp4`, MAX_FILE_DOWNLOAD_BYTES + 1), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=huge.mp4`,
      });

      expect(res.statusCode).toBe(413);
      expect(mockedCreateReadStream).not.toHaveBeenCalled();
    });

    it('refuses a directory', async () => {
      mockedProbePaths.mockResolvedValue([dirProbe, dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=.`,
      });

      expect(res.statusCode).toBe(400);
    });

    it('does not touch the ssh layer for a local session', async () => {
      delete harness.ctx._session.remote;

      await harness.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/file-raw?path=img.png` });

      expect(mockedProbePaths).not.toHaveBeenCalled();
      expect(mockedCreateReadStream).not.toHaveBeenCalled();
    });

    describe('when a path with the same absolute name ALSO exists on this host', () => {
      // The case that really happens in practice: the remote tree is mounted on the
      // Codeman host at the identical absolute path (an sshfs mount, which is the
      // documented stop-gap workaround for this very bug). The remote host stays the
      // source of truth: there is deliberately no local fallback, because a fallback
      // would silently serve the OTHER filesystem's bytes under the same path.
      let shadowRoot: string;
      let shadowFile: string;

      beforeEach(() => {
        shadowRoot = mkdtempSync(join(tmpdir(), 'codeman-remote-shadow-'));
        shadowFile = join(shadowRoot, 'img.png');
        writeFileSync(shadowFile, 'LOCAL BYTES');
        harness.ctx._session.workingDir = shadowRoot;
        harness.ctx._session.remote = { ...remote, remotePath: shadowRoot };
        mockedProbePaths.mockResolvedValue([fileProbe(shadowFile, 12), { ...dirProbe, realPath: shadowRoot }]);
      });

      afterEach(() => {
        rmSync(shadowRoot, { recursive: true, force: true });
      });

      it('serves the REMOTE bytes, never the local copy at the same path', async () => {
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/file-raw?path=img.png`,
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('remote bytes');
        expect(res.body).not.toBe('LOCAL BYTES');
        // The local file is untouched, proving the local side was never the source.
        expect(readFileSync(shadowFile, 'utf8')).toBe('LOCAL BYTES');
      });

      it('still 404s when the remote host does not have the file, even though a local one exists', async () => {
        mockedProbePaths.mockResolvedValue([null, { ...dirProbe, realPath: shadowRoot }]);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/file-raw?path=img.png`,
        });

        expect(res.statusCode).toBe(404);
        expect(mockedCreateReadStream).not.toHaveBeenCalled();
      });

      it('reads text from the remote host, not from the local twin', async () => {
        const localText = join(shadowRoot, 'notes.txt');
        writeFileSync(localText, 'local text');
        mockedProbePaths.mockResolvedValue([fileProbe(localText, 11), { ...dirProbe, realPath: shadowRoot }]);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/file-content?path=notes.txt`,
        });

        expect(JSON.parse(res.body).data.content).toBe('remote text');
        expect(mockedReadFile).toHaveBeenCalledWith(expect.anything(), localText, expect.any(Number));
        expect(readFileSync(localText, 'utf8')).toBe('local text');
      });
    });
  });

  describe('GET /api/sessions/:id/file-content', () => {
    it('returns remote text content and never advertises the editor', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/notes.txt`, 11), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=notes.txt`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toBe('remote text');
      expect(body.data.editable).toBe(false);
      expect(mockedReadFile).toHaveBeenCalledWith(expect.anything(), `${REMOTE_DIR}/notes.txt`, expect.any(Number));
    });

    it('classifies remote media by extension without reading it', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/logo.png`, 1024), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=logo.png`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.type).toBe('image');
      expect(body.data.url).toContain('file-raw');
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('turns an edit request into an explicit 400 instead of a misleading 404', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/notes.txt`, 11), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=notes.txt&edit=1`,
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not supported for files in a remote');
    });

    it('reports an unreachable host as a real 502 with the remote reason', async () => {
      mockedProbePaths.mockRejectedValue(new RemoteFileAccessError('remote host testhost unreachable: timed out'));

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=notes.txt`,
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('timed out');
    });

    it('rejects a path that escapes the workspace', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-content?path=../../../etc/passwd`,
      });

      expect(JSON.parse(res.body).success).toBe(false);
      expect(mockedProbePaths).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/sessions/:id/file-preview and file-thumbnail', () => {
    it('redirects a non-office remote file to file-raw', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-preview?path=scan.pdf`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('/file-raw');
    });

    it('says office previews are unavailable rather than 404-ing', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/doc.docx`, 10), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-preview?path=doc.docx`,
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('not available for files in a remote');
    });

    it('says thumbnails are unavailable for a remote file', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(`${REMOTE_DIR}/doc.pdf`, 10), dirProbe]);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-thumbnail?path=doc.pdf`,
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('not available for files in a remote');
    });

    it('reports an unreachable host for previews too', async () => {
      mockedProbePaths.mockRejectedValue(new RemoteFileAccessError('remote host testhost unreachable: no route'));

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-preview?path=doc.docx`,
      });

      expect(res.statusCode).toBe(502);
    });
  });
  describe('attachments — a file click OUTSIDE the case directory (#415)', () => {
    const outsidePath = '/tmp/agent-output/shot.png';

    async function publish(path: string): Promise<{ statusCode: number; body: unknown }> {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/attachments`,
        payload: { path, notify: false },
      });
      return { statusCode: res.statusCode, body: JSON.parse(res.body) };
    }

    it('registers an out-of-workspace remote path by probing the remote host', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(outsidePath, 42), dirProbe]);

      const res = await publish(outsidePath);

      expect(res.statusCode).toBe(200);
      const data = (res.body as { data: { attachmentId: string; size: number; fileName: string } }).data;
      expect(data.attachmentId).toMatch(/^att_/);
      expect(data.fileName).toBe('shot.png');
      expect(data.size).toBe(42);
      // The path is outside the workspace, so a workspace-relative resolution could
      // never have found it — the probe is what makes this work at all.
      expect(mockedProbePaths).toHaveBeenCalledWith(expect.objectContaining({ host: '192.0.2.10' }), [
        outsidePath,
        REMOTE_DIR,
      ]);
    });

    it("serves the registered remote attachment's bytes by id, with range support", async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(outsidePath, 42), dirProbe]);
      const published = await publish(outsidePath);
      const attachmentId = (published.body as { data: { attachmentId: string } }).data.attachmentId;

      // The by-id route re-probes (guard defense-in-depth) before streaming.
      mockedProbePaths.mockResolvedValue([fileProbe(outsidePath, 42), dirProbe]);
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/attachments/${attachmentId}/raw`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.body).toBe('remote bytes');
      expect(mockedCreateReadStream).toHaveBeenCalledWith(expect.anything(), outsidePath, undefined);

      const ranged = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/attachments/${attachmentId}/raw`,
        headers: { range: 'bytes=1-3' },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['content-range']).toBe('bytes 1-3/42');
    });

    it('reports the remote size in the attachment metadata poll', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe(outsidePath, 42), dirProbe]);
      const published = await publish(outsidePath);
      const attachmentId = (published.body as { data: { attachmentId: string } }).data.attachmentId;

      mockedProbePaths.mockResolvedValue([fileProbe(outsidePath, 84), dirProbe]);
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/attachments/${attachmentId}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.size).toBe(84);
    });

    it('404s a remote path that does not exist instead of reporting it as unreadable', async () => {
      mockedProbePaths.mockResolvedValue([null, dirProbe]);

      const res = await publish('/tmp/agent-output/gone.png');

      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.body)).toContain('Attachment file not found');
    });

    it('reports an unreachable host as 502 for the click path too', async () => {
      mockedProbePaths.mockRejectedValue(new RemoteFileAccessError('remote host testhost unreachable: timed out'));

      const res = await publish(outsidePath);

      expect(res.statusCode).toBe(502);
    });

    it('still refuses a blocked remote path (the blocklist is host-agnostic)', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe('/etc/shadow', 10), dirProbe]);

      const res = await publish('/etc/shadow');

      // 403 from the guard (the same answer the local path gives for a blocked tree).
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/blocked/i);
    });

    it('does not offer office previews or thumbnails for a remote attachment', async () => {
      mockedProbePaths.mockResolvedValue([fileProbe('/tmp/agent-output/report.docx', 10), dirProbe]);
      const published = await publish('/tmp/agent-output/report.docx');
      const attachmentId = (published.body as { data: { attachmentId: string } }).data.attachmentId;

      mockedProbePaths.mockResolvedValue([fileProbe('/tmp/agent-output/report.docx', 10), dirProbe]);
      const preview = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/attachments/${attachmentId}/preview`,
      });
      const thumbnail = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/attachments/${attachmentId}/thumbnail`,
      });

      expect(preview.statusCode).toBe(400);
      expect(thumbnail.statusCode).toBe(400);
    });

    it('lists an out-of-workspace remote history entry without marking it missing', async () => {
      harness.ctx._session.attachmentHistory = [
        {
          id: 'hist-1',
          sessionId,
          fileName: 'shot.png',
          extension: 'png',
          attachmentType: 'image',
          size: 1,
          mtimeMs: 1,
          timestamp: 1,
          source: 'external',
          externalPath: outsidePath,
        },
      ];
      mockedProbePaths.mockImplementation(async (_remote, paths) =>
        paths.map((path) => (path === outsidePath ? fileProbe(outsidePath, 42) : path === REMOTE_DIR ? dirProbe : null))
      );

      const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/attachments` });

      expect(res.statusCode).toBe(200);
      const [item] = JSON.parse(res.body).data.items;
      expect(item.missing).toBe(false);
      expect(item.size).toBe(42);
      expect(item.attachmentId).toBeTruthy();
    });

    it('resolves a workspace-relative history entry over ssh', async () => {
      harness.ctx._session.attachmentHistory = [
        {
          id: 'hist-2',
          sessionId,
          fileName: 'out.png',
          extension: 'png',
          attachmentType: 'image',
          size: 1,
          mtimeMs: 1,
          timestamp: 1,
          source: 'detected',
          relativePath: 'out.png',
        },
      ];
      mockedProbePaths.mockImplementation(async (_remote, paths) =>
        paths.map((path) =>
          path === `${REMOTE_DIR}/out.png`
            ? fileProbe(`${REMOTE_DIR}/out.png`, 7)
            : path === REMOTE_DIR
              ? dirProbe
              : null
        )
      );

      const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/attachments` });

      const [item] = JSON.parse(res.body).data.items;
      expect(item.missing).toBe(false);
      expect(item.size).toBe(7);
      expect(item.rawUrl).toContain('file-raw');
    });

    describe('the history list probes the whole history in ONE ssh round trip', () => {
      // One connection per entry (up to ATTACHMENT_HISTORY_LIMIT, re-run on every
      // attachment:detected while the drawer is open) tripped OpenSSH's default
      // MaxStartups 10:30:100, which drops most of a burst that size.
      const history = () => [
        {
          id: 'hist-a',
          sessionId,
          fileName: 'out.png',
          extension: 'png',
          attachmentType: 'image' as const,
          size: 1,
          mtimeMs: 1,
          timestamp: 1,
          source: 'detected' as const,
          relativePath: 'out.png',
        },
        {
          id: 'hist-b',
          sessionId,
          fileName: 'shot.png',
          extension: 'png',
          attachmentType: 'image' as const,
          size: 1,
          mtimeMs: 1,
          timestamp: 1,
          source: 'external' as const,
          externalPath: outsidePath,
        },
        {
          id: 'hist-c',
          sessionId,
          fileName: 'gone.png',
          extension: 'png',
          attachmentType: 'image' as const,
          size: 1,
          mtimeMs: 1,
          timestamp: 1,
          source: 'detected' as const,
          relativePath: 'gone.png',
        },
      ];

      it('issues a single batched probe covering every entry plus the workspace root', async () => {
        harness.ctx._session.attachmentHistory = history();
        mockedProbePaths.mockImplementation(async (_remote, paths) =>
          paths.map((path) =>
            path === `${REMOTE_DIR}/out.png`
              ? fileProbe(path, 7)
              : path === outsidePath
                ? fileProbe(outsidePath, 42)
                : path === REMOTE_DIR
                  ? dirProbe
                  : null
          )
        );

        const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/attachments` });

        expect(res.statusCode).toBe(200);
        expect(mockedProbePaths).toHaveBeenCalledTimes(1);
        const [, probed] = mockedProbePaths.mock.calls[0];
        expect([...probed].sort()).toEqual(
          [REMOTE_DIR, `${REMOTE_DIR}/gone.png`, `${REMOTE_DIR}/out.png`, outsidePath].sort()
        );
        // (ids are re-minted for external entries by the sanitizer, so key on the name)
        const items = JSON.parse(res.body).data.items as Array<{ fileName: string; missing: boolean; size: number }>;
        expect(items.map((item) => [item.fileName, item.missing, item.size])).toEqual([
          ['out.png', false, 7],
          ['shot.png', false, 42],
          ['gone.png', true, 1],
        ]);
      });

      it('reports every entry as unknown (missing: false), detected AND external alike, when the host is unreachable', async () => {
        harness.ctx._session.attachmentHistory = history();
        mockedProbePaths.mockRejectedValue(new RemoteFileAccessError('remote host testhost unreachable: timed out'));

        const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/attachments` });

        expect(res.statusCode).toBe(200);
        const items = JSON.parse(res.body).data.items as Array<{ id: string; missing: boolean }>;
        // The two branches used to disagree here: detected kept missing:false while
        // external's 502 was folded into missing:true.
        expect(items.map((item) => item.missing)).toEqual([false, false, false]);
      });
    });
  });

  describe('PUT /api/sessions/:id/file-content', () => {
    // The remote guard has to come BEFORE the local path validation: with a
    // directory of the same absolute name on this host (an sshfs mount of the remote
    // tree, the documented stop-gap for #415) the write would land on the local twin
    // while the viewer believes it edited the remote file.
    let shadowRoot: string;
    let shadowFile: string;

    beforeEach(() => {
      shadowRoot = mkdtempSync(join(tmpdir(), 'codeman-remote-put-'));
      shadowFile = join(shadowRoot, 'notes.txt');
      writeFileSync(shadowFile, 'LOCAL TEXT');
      harness.ctx._session.workingDir = shadowRoot;
      harness.ctx._session.remote = { ...remote, remotePath: shadowRoot };
    });

    afterEach(() => {
      rmSync(shadowRoot, { recursive: true, force: true });
    });

    it('answers 400 for a remote case and never touches the local file of the same name', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${sessionId}/file-content`,
        payload: { path: 'notes.txt', content: 'OVERWRITTEN', baseHash: 'whatever', force: true },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/not supported for files in a remote/);
      expect(readFileSync(shadowFile, 'utf8')).toBe('LOCAL TEXT');
      expect(mockedProbePaths).not.toHaveBeenCalled();
    });
  });

  describe('a client that gives up during the guard probe', () => {
    it('still has its ssh body child reaped', async () => {
      // The probe is an ssh round trip; a client that aborted during it has already
      // closed the response, so a `close` listener attached afterwards never fires.
      const controller = new AbortController();
      mockedProbePaths.mockImplementation(async () => {
        controller.abort();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        return [fileProbe(`${REMOTE_DIR}/img.png`, 9), dirProbe];
      });

      await harness.app
        .inject({ method: 'GET', url: `/api/sessions/${sessionId}/file-raw?path=img.png`, signal: controller.signal })
        .catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

      // The body WAS opened (the route ran to completion against an already-closed
      // response), which is exactly the window the guard covers.
      expect(mockedCreateReadStream).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalled();
    });
  });
});
