/** Narrow nonce-r2 regression controls using only owned synthetic files/children. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const storeId = '11111111-2222-4333-8444-555555555555';
const flockExecutable = fs.realpathSync(
  (process.env.PATH ?? '')
    .split(':')
    .map((part) => join(part, 'flock'))
    .find((file) => fs.existsSync(file))!
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function control(mode: string) {
  const root = fs.mkdtempSync(join(tmpdir(), 'nonce-successor-'));
  roots.push(root);
  const file = join(root, 'nonces.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, storeId, capacity: 4, revision: 0, clockFloor: 100_000, entries: [] })
  );
  fs.writeFileSync(file + '.lock', '');
  const result = await new Promise<Record<string, unknown>>((done, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'test/fixtures/goal-nonce-successor-child.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      timeout: 2500,
      killSignal: 'SIGKILL',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '--max-old-space-size=96', GOMAXPROCS: '1' },
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (bytes) => {
      output += bytes;
    });
    child.stderr.on('data', (bytes) => {
      errors += bytes;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal === 'SIGKILL') return reject(Error('synthetic bounded refusal timed out'));
      if (code !== 0) return reject(Error('synthetic child failed: ' + errors));
      try {
        done(JSON.parse(output));
      } catch {
        reject(Error('invalid synthetic child output'));
      }
    });
    child.stdin.end(JSON.stringify({ file, mode, storeId, flockExecutable }));
  });
  return { result, state: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
it.each(['key', 'epoch', 'generation', 'owner', 'employee', 'auth-only-custody'])(
  'composed auth refuses%s changed after real durable floor I/O',
  async (mode) => {
    const f = await control(mode);
    expect(f.result.fsyncs).toBe(1);
    expect(f.state().clockFloor).toBe(100_001);
    expect(f.result.refused).toBe(true);
  }
);
it.each([
  'backend-expiry',
  'backend-custody',
  'backend-clock-regression',
  'backend-clock-error',
  'replace-claim',
  'remove-ledger',
])('standalone backend refuses%s after its durable floor I/O', async (mode) => {
  const f = await control(mode);
  expect(f.result.fsyncs).toBe(1);
  expect(f.result.refused).toBe(true);
});
it.each(['claim-expiry', 'claim-custody'])(
  'claim refuses%s after durable commit while leaving its nonce burned',
  async (mode) => {
    const f = await control(mode);
    expect(f.result.fsyncs).toBe(1);
    expect(f.result.refused).toBe(true);
    expect(f.state().entries).toHaveLength(1);
  }
);
it.each([
  'special-character-ledger',
  'special-block-ledger',
  'special-socket-ledger',
  'special-character-lock',
  'special-block-lock',
  'special-socket-lock',
])('refuses synthetic%s metadata before any open; no actual device/socket used', async (mode) => {
  const f = await control(mode);
  expect(f.result.refused).toBe(true);
  expect(f.result.storageOpens).toBe(0);
});
it.each(['race-fifo-ledger', 'race-fifo-lock', 'race-inode-ledger', 'race-inode-lock'])(
  'refuses%s between preflight and open with bounded nofollow/nonblocking flags',
  async (mode) => {
    const f = await control(mode);
    expect(f.result.refused).toBe(true);
    expect(f.result.storageOpens).toBe(1);
    expect(f.result.noFollow).toBe(true);
    expect(f.result.nonblocking).toBe(true);
  }
);
