/**
 * Build-version check: the server fingerprints the frontend it serves, and a page
 * that sees a different fingerprint on a later SSE `init` offers a reload.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeFrontendBuildId } from '../src/web/frontend-build-id.js';

describe('computeFrontendBuildId', () => {
  it('changes when a served file changes, and only then', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-id-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    writeFileSync(join(dir, 'app.js'), 'one');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const first = computeFrontendBuildId(dir);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(computeFrontendBuildId(dir)).toBe(first);
    writeFileSync(join(dir, 'notes.txt'), 'still ignored');
    expect(computeFrontendBuildId(dir)).toBe(first);
    writeFileSync(join(dir, 'app.js'), 'two');
    expect(computeFrontendBuildId(dir)).not.toBe(first);
  });

  it('covers the vendor and font files the page loads, but not other subdirectories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-id-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    for (const sub of ['vendor', 'fonts', 'gesture']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'vendor', 'xterm.min.js'), 'v1');
    writeFileSync(join(dir, 'fonts', 'mono.woff2'), 'f1');
    writeFileSync(join(dir, 'gesture', 'model.task'), 'g1');
    const first = computeFrontendBuildId(dir);
    writeFileSync(join(dir, 'gesture', 'model.task'), 'g2');
    expect(computeFrontendBuildId(dir)).toBe(first);
    writeFileSync(join(dir, 'vendor', 'xterm.min.js'), 'v2');
    const second = computeFrontendBuildId(dir);
    expect(second).not.toBe(first);
    writeFileSync(join(dir, 'fonts', 'mono.woff2'), 'f2');
    expect(computeFrontendBuildId(dir)).not.toBe(second);
  });

  it('answers "unknown" for a missing directory instead of throwing', () => {
    expect(computeFrontendBuildId(join(tmpdir(), 'does-not-exist-reverie'))).toBe('unknown');
  });
});

function loadNotice() {
  const body: unknown[] = [];
  const byId = new Map<string, { remove(): void }>();
  const makeEl = () => {
    const el: Record<string, unknown> & { children: unknown[] } = {
      children: [],
      setAttribute() {},
      append(...kids: unknown[]) {
        el.children.push(...kids);
      },
      remove() {
        byId.delete(el.id as string);
        body.splice(body.indexOf(el), 1);
      },
    };
    return el;
  };
  const reloads: number[] = [];
  class App {}
  const context = vm.createContext({
    ReverieApp: App,
    location: { reload: () => reloads.push(1) },
    document: {
      createElement: makeEl,
      getElementById: (id: string) => byId.get(id) ?? null,
      body: {
        append(el: { id?: string; remove(): void }) {
          body.push(el);
          if (el.id) byId.set(el.id, el);
        },
      },
    },
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/update-notice.js'), 'utf8'), context);
  return { app: new App() as { noteServerBuild(id?: string): boolean }, body, reloads };
}

describe('update notice', () => {
  it('stays quiet for the build the page loaded with, and for unknown ids', () => {
    const { app, body } = loadNotice();
    expect(app.noteServerBuild('aaaa')).toBe(false);
    expect(app.noteServerBuild('aaaa')).toBe(false);
    expect(app.noteServerBuild(undefined)).toBe(false);
    expect(app.noteServerBuild('unknown')).toBe(false);
    expect(body).toHaveLength(0);
  });

  it('shows one notice when a reconnect reports a new build, reloads on click, and respects a dismissal', () => {
    const { app, body, reloads } = loadNotice();
    app.noteServerBuild('aaaa');
    expect(app.noteServerBuild('bbbb')).toBe(true);
    // Already showing: not shown again, and the return value says so.
    expect(app.noteServerBuild('bbbb')).toBe(false);
    expect(body).toHaveLength(1);
    const notice = body[0] as { children: Array<{ textContent?: string; onclick?: () => void }> };
    expect(notice.children[0].textContent).toBe('Reverie was updated.');
    notice.children[1].onclick?.();
    expect(reloads).toHaveLength(1);
    notice.children[2].onclick?.();
    expect(body).toHaveLength(0);
    expect(app.noteServerBuild('bbbb')).toBe(false);
    expect(app.noteServerBuild('cccc')).toBe(true);
    (body[0] as { children: Array<{ onclick?: () => void }> }).children[2].onclick?.();
    // A rollback to a build dismissed earlier stays quiet.
    expect(app.noteServerBuild('bbbb')).toBe(false);
    expect(body).toHaveLength(0);
  });
});
