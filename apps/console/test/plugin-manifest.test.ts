/**
 * @fileoverview Static guard for the Claude Code plugin the repo publishes about itself.
 *
 * `.claude-plugin/marketplace.json` at the repo root makes `/plugin marketplace add
 * Ark0N/Codeman` work; the one plugin it lists is `plugins/codeman/`, whose `skills/codeman`
 * is a MIRROR of the real `skills/codeman/` (see `scripts/sync-plugin.mjs` for why it is a
 * copy and not the source or a symlink). Pinned here:
 *
 * - the mirror is byte-identical to the source (edit the source, run the sync script);
 * - both manifests carry package.json's version, or `plugin update` never sees a release;
 * - the plugin root has NO `package.json`: a plugin root with one gets an npm install at
 *   install time, which for this repo meant 832 MB, 511 packages and the postinstall build
 *   on every installer's machine (measured 2026-09-14 with the repo root as plugin root);
 * - the plugin ships exactly one component, the skill, and nothing else that would ride
 *   along silently (`commands/`, `agents/`, `hooks/`, `.mcp.json`, `settings.json`);
 * - the skill's frontmatter names it, so the installed skill is `codeman:codeman` and not a
 *   versioned cache-directory name;
 * - the repo root `.claude-plugin/` holds only the marketplace manifest, so the repo itself
 *   never reads as a plugin again.
 *
 * Pure filesystem reads against the real tree. Port: N/A.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = join(ROOT, 'plugins/codeman');
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const pkg = readJson('package.json');
const plugin = readJson('plugins/codeman/.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');

describe('Claude Code plugin (plugins/codeman)', () => {
  it('mirrors skills/codeman byte for byte', () => {
    const source = join(ROOT, 'skills/codeman');
    const mirror = join(PLUGIN_DIR, 'skills/codeman');
    const srcFiles = walk(source).map((p) => relative(source, p));
    const dstFiles = walk(mirror).map((p) => relative(mirror, p));
    expect(dstFiles).toEqual(srcFiles);
    for (const rel of srcFiles) {
      expect(readFileSync(join(mirror, rel)).equals(readFileSync(join(source, rel))), `${rel} drifted`).toBe(true);
    }
  });

  it('plugin.json names the codeman plugin at the package version', () => {
    expect(plugin.name).toBe('codeman');
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe('MIT');
    expect(plugin.repository).toBe('https://github.com/Ark0N/Codeman');
  });

  it('marketplace.json lists exactly that plugin, sourced from plugins/codeman, at the same version', () => {
    expect(marketplace.name).toBe('codeman');
    expect(marketplace.owner?.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe('./plugins/codeman');
    expect(entry.version).toBe(pkg.version);
  });

  it('the plugin root carries no package.json (an npm-install trigger) and no component but the skill', () => {
    expect(existsSync(join(PLUGIN_DIR, 'package.json')), 'plugins/codeman/package.json').toBe(false);
    for (const rel of ['commands', 'agents', 'hooks', '.mcp.json', '.lsp.json', 'settings.json', 'monitors']) {
      expect(existsSync(join(PLUGIN_DIR, rel)), `plugins/codeman/${rel} would ship with the plugin`).toBe(false);
    }
    for (const key of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers']) {
      expect(plugin[key], `plugin.json "${key}" override`).toBeUndefined();
    }
    expect(readdirSync(join(PLUGIN_DIR, 'skills'))).toEqual(['codeman']);
  });

  it('the skill declares its own name, so the installed skill is codeman:codeman', () => {
    const skill = readFileSync(join(ROOT, 'skills/codeman/SKILL.md'), 'utf8');
    expect(skill.split('---')[1] ?? '').toMatch(/^name: codeman$/m);
  });

  it('the repo root .claude-plugin holds only the marketplace manifest', () => {
    expect(readdirSync(join(ROOT, '.claude-plugin'))).toEqual(['marketplace.json']);
  });
});
