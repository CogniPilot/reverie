/** Filesystem/socket fixture only: no Docker, broker, provider or Office authority. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, lstatSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { nativeHookCaseDirectory } from '../scripts/lib/native-hook-case.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')(
  'keeps the late native hook Office socket bindable under the actual CI root length',
  async () => {
    // An owned short base keeps this kernel pathname test independent of Vitest's
    // own deep TMPDIR. It does not bypass any runtime custody boundary.
    const base = mkdtempSync('/tmp/rhb-');
    roots.push(base);
    const ciRootBytes = Buffer.byteLength('/home/runner/work/_temp/nix-shell.ibXukL/rnh-lFHpYG');
    const root = join(base, 'p'.repeat(ciRootBytes - Buffer.byteLength(base) - 1));
    mkdirSync(root, { mode: 0o700 });
    const old = join(root, 'original-permission-after-refused-restart', 'office', 'office.sock');
    expect(Buffer.byteLength(old)).toBe(112);
    const directory = nativeHookCaseDirectory(root, 5);
    const office = join(directory, 'office');
    mkdirSync(office, { recursive: true, mode: 0o700 });
    const socket = join(office, 'office.sock');
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(107);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    try {
      expect(lstatSync(socket).isSocket()).toBe(true);
      expect(nativeHookCaseDirectory(root, 6)).not.toBe(directory);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
);

it('refuses an excessive byte budget and invalid case before any native helper dispatch', () => {
  expect(() => nativeHookCaseDirectory('/' + 'é'.repeat(50), 0)).toThrow('socket path budget');
  for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
    expect(() => nativeHookCaseDirectory('/owned', index)).toThrow('case selection');
  expect(() => nativeHookCaseDirectory('relative', 0)).toThrow('case selection');
});
