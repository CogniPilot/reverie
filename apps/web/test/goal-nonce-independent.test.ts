/** Fresh independent nonce review controls; owned synthetic files/processes only. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { GoalNonceStore } from '../src/goal-nonce-store.js';

const storeId = '11111111-2222-4333-8444-555555555555';
const flockExecutable = fs.realpathSync((process.env.PATH ?? '').split(':').map(part => join(part, 'flock'))
  .find(file => fs.existsSync(file))!);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'nonce-independent-')); roots.push(root);
  const file = join(root, 'nonces.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, storeId, capacity: 4, revision: 0, clockFloor: 100_000, entries: [] }));
  fs.writeFileSync(file + '.lock', '');
  return { root, file };
}
async function child(file: string, mode: string): Promise<Record<string, unknown>> {
  return new Promise((done, reject) => {
    const process = spawn('node', ['--import', 'tsx', 'test/fixtures/goal-nonce-independent-child.ts'], {
      cwd: resolve(import.meta.dirname, '..'), timeout: 2500, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME,
        NODE_OPTIONS: '--max-old-space-size=96', GOMAXPROCS: '1' },
    });
    let output = '', error = '';
    process.stdout.on('data', bytes => { output += bytes; });
    process.stderr.on('data', bytes => { error += bytes; });
    process.once('error', reject);
    process.once('close', (code, signal) => {
      if (signal === 'SIGKILL') return done({ timedOut: true });
      if (code !== 0) return reject(Error('Synthetic child failed: ' + error));
      try { done(JSON.parse(output)); } catch { reject(Error('Invalid synthetic child output')); }
    });
    process.stdin.end(JSON.stringify({ file, mode, storeId, flockExecutable }));
  });
}
it.each(['expiry', 'custody', 'issuer', 'binding'])('composed commit-time current check refuses%s lost during real durable floor persistence', async mode => {
  const f = fixture();
  const result = await child(f.file, mode);
  expect(result.persistedClockFloor).toBe(100_001);
  if (mode === 'expiry') expect(result.now).toBe(110_000);
  if (mode === 'custody') expect(result.custody).toBe(false);
  if (mode === 'issuer') expect(result.issuerAvailable).toBe(false);
  if (mode === 'binding') expect(result.bindingAvailable).toBe(false);
  expect(result.refused, JSON.stringify(result)).toBe(true);
});
it('refuses a nonregular FIFO ledger boundedly instead of hanging before fstat', async () => {
  const f = fixture();
  fs.unlinkSync(f.file);
  expect(spawnSync('mkfifo', [f.file], { timeout: 1000 }).status).toBe(0);
  expect(await child(f.file, 'fifo')).toEqual({ refused: true });
});
it.each(['ledger', 'lock'])('refuses a hardlinked%s under correct synthetic custody', async mode => {
  const f = fixture();
  fs.linkSync(mode === 'ledger' ? f.file : f.file + '.lock', join(f.root, 'hardlink'));
  const store = new GoalNonceStore({ file: f.file, storeId, capacity: 4, flockExecutable,
    authorityNamespace: f.root + '/authority', now: () => 100_000, assertPrivateCustody: () => {} });
  await expect(store.claim({ issuer: 'test-broker', epoch: 'test-epoch', nonce: 'a'.repeat(32), expiresAt: 110_000 }))
    .rejects.toThrow('Private durable Goal nonce storage unavailable');
});
