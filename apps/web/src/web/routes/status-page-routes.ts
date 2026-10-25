/**
 * @fileoverview Stable, bookmarkable names for generated status pages.
 *
 * Routes:
 * - `GET /status/:name` (owner only: the owner policy classifies it 'owner', so agents, services,
 *   limited logins and Basic auth alone are refused; a signed-out browser is sent to login and
 *   back, see isAppPage; no HEAD route): looks `name` up in the
 *   `statusPages` setting, mints (or reuses) an html-view capability for that page's
 *   directory, and redirects to `/html-view/<cap>/<entry>`.
 *
 * An html-view URL carries an in-memory capability that a server restart or the TTL
 * ends, so it cannot be bookmarked. This route is the stable name: every visit gets a
 * live capability, and the page itself is served by html-view-routes.ts with all its
 * protections (sandbox CSP in an opaque origin, its own directory only, the asset
 * allowlist, no dotfiles, the attachment guard re-checked per request).
 *
 * The pages are configuration, not code: `settings.json` → `statusPages` maps a name
 * to `{ dir, entry }`, e.g. `{ "drive-cleanup": { "dir": "/srv/status/drive-cleanup",
 * "entry": "index.html" } }`. A directory is admitted like an out-of-workspace html-view
 * page: it must resolve to a real directory that is not hidden and not a broad root,
 * and the attachment guard must allow it (workspace confinement refuses every page).
 */

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { isBlockedAttachmentPath, isUnderTree, loadAttachmentGuardConfig } from '../../config/attachment-guard.js';
import { HTML_VIEW_PREFIX, htmlViewCapabilities } from '../../html-view-capabilities.js';
import { ownerFor, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { isBroadHtmlViewRoot } from './html-view-routes.js';
import { STATUS_PAGE_ROUTE } from '../../owner-auth/policy.js';

/** The setting that names the status pages. */
export const STATUS_PAGES_SETTING = 'statusPages';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface StatusPage {
  dir: string;
  entry: string;
}

/** `statusPages` from settings.json, keeping only well-formed entries. */
export async function loadStatusPages(): Promise<Record<string, StatusPage>> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  const raw = settings[STATUS_PAGES_SETTING];
  const pages: Record<string, StatusPage> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return pages;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const page = value as Partial<StatusPage> | null;
    if (!NAME.test(name) || !page || typeof page.dir !== 'string' || typeof page.entry !== 'string') continue;
    pages[name] = { dir: page.dir, entry: page.entry };
  }
  return pages;
}

export function registerStatusPageRoutes(
  app: FastifyInstance,
  loadPages: () => Promise<Record<string, StatusPage>> = loadStatusPages
): void {
  // GET only: no automatic HEAD route. The owner policy classifies this route 'owner' for every method, before
  // any handler runs, so only a signed-in owner reaches the settings lookup and the mint.
  app.get(STATUS_PAGE_ROUTE, { exposeHeadRoute: false }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const refuse = (code: number, text: string) =>
      reply.code(code).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(text);
    const page = NAME.test(name) ? (await loadPages())[name] : undefined;
    if (!page) return refuse(404, 'No status page with that name');

    // The entry is one plain HTML file name, never a path.
    if (!isAbsolute(page.dir) || page.entry !== basename(page.entry) || page.entry.startsWith('.') ||
        !['.html', '.htm'].includes(extname(page.entry).toLowerCase())) {
      return refuse(500, 'This status page is misconfigured');
    }
    let dir: string;
    try {
      dir = await fs.realpath(page.dir);
    } catch {
      return refuse(404, 'This status page has not been generated yet');
    }
    // Same admission as an out-of-workspace html-view page, decided on the directory BEFORE anything inside it is
    // looked at, so a refused directory is never probed for files.
    if (dir.split(sep).some((segment) => segment.startsWith('.')) || isBroadHtmlViewRoot(dir)) {
      return refuse(403, 'This status page directory cannot be served');
    }
    const guard = await loadAttachmentGuardConfig();
    if (guard.confineToWorkspace || isBlockedAttachmentPath(dir, guard.blockedTrees)) {
      return refuse(403, 'This status page directory is blocked');
    }
    const entry = await fs.realpath(join(dir, page.entry)).catch(() => null);
    const stat = entry ? await fs.stat(entry).catch(() => null) : null;
    // Where the entry LANDS must be an HTML file directly in the page's directory (the redirect names it by its
    // base name under the capability root): a link out of the directory, or into a subdirectory, is refused.
    if (!entry || !stat?.isFile() || !isUnderTree(entry, dir) || dirname(entry) !== dir ||
        !['.html', '.htm'].includes(extname(entry).toLowerCase())) {
      return refuse(404, 'This status page has not been generated yet');
    }

    const cap = htmlViewCapabilities.mint(dir, ownerFor(req), true);
    // Relative, so it resolves under whatever base path the console is served at (<base>/status/x -> <base>/html-view/...).
    const target = `..${HTML_VIEW_PREFIX}/${cap}/${encodeURIComponent(basename(entry))}`;
    return reply.header('Cache-Control', 'no-store').redirect(target, 302);
  });
}
