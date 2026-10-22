import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from '../src/web/server.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function subject() {
  return Object.assign(Object.create(WebServer.prototype), { _assetVersionMemo: new Map() }) as {
    assetVersion(path: string): string | null;
  };
}
function asset() { const dir = mkdtempSync(join(tmpdir(), 'asset-version-')); dirs.push(dir); return join(dir, 'voice-chat.js'); }
describe('asset content versions for reproducible builds', () => {
  it('changes for same-length replacement bytes even when both mtimes are epoch zero', () => {
    const path = asset(), server = subject(); let now = 10000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    writeFileSync(path, 'old speech'); utimesSync(path, 0, 0);
    const before = server.assetVersion(path);
    expect(before).toMatch(/^[a-f0-9]{16}$/);
    writeFileSync(path, 'new speech'); utimesSync(path, 0, 0); now += 1001;
    expect(server.assetVersion(path)).not.toBe(before);
  });
  it('keeps identical bytes stable across timestamps and independent server instances', () => {
    const path = asset(); writeFileSync(path, 'same speech'); utimesSync(path, 0, 0);
    const before = subject().assetVersion(path); utimesSync(path, 42, 42);
    expect(subject().assetVersion(path)).toBe(before);
  });
  it('returns null for missing assets and refreshes after the bounded memo interval', () => {
    const path = asset(), server = subject(); let now = 10000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect(server.assetVersion(path)).toBeNull();
    writeFileSync(path, 'old'); const before = server.assetVersion(path);
    writeFileSync(path, 'new'); expect(server.assetVersion(path)).toBe(before);
    now += 1001; expect(server.assetVersion(path)).not.toBe(before);
  });
});
