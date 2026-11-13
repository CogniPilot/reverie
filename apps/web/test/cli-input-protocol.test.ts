import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cliInputProtocol } from '../src/cli-input-protocol.js';
import { pastesInsteadOfKeys, CODEX_KEY_BURST_MAX_CHARS } from '../src/submit-settle.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import * as registry from '../src/config/cli-registry/registry.js';
import { Session } from '../src/session.js';
import type { SessionMode } from '../src/types.js';

let directory: string;
const sessions: Session[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'input-protocol-'));
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  registry.reloadCliRegistry();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.unstubAllEnvs();
  registry.reloadCliRegistry();
  await rm(directory, { recursive: true, force: true });
});
async function customProtocol(source: string, id: string) {
  const clone = structuredClone(registry.getCli(source)!);
  const path = registry.registryFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, clis: { [id]: { ...clone, id, stock: true } } }), { mode: 0o600 });
  registry.reloadCliRegistry();
  expect(registry.getCli(id)?.stock).toBe(false);
}
async function replaceCustomInput(id: string, terminalInput: Record<string, unknown>, label?: string) {
  const entry = structuredClone(registry.getCli(id)!);
  const path = registry.registryFilePath();
  await writeFile(path, JSON.stringify({ schemaVersion: 1, clis: {
    [id]: { ...entry, ...(label ? { label } : {}), capabilities: { ...entry.capabilities, terminalInput } },
  } }), { mode: 0o600 });
  registry.reloadCliRegistry();
}
it('keeps the measured stock protocols independent and defaults undeclared runtimes to plain input', () => {
  expect(cliInputProtocol('codex')).toEqual({ requiresEmptyComposer: true, shellKeyGuard: false, keyBurstMaxChars: 1000 });
  expect(cliInputProtocol('opencode')).toEqual({ requiresEmptyComposer: false, shellKeyGuard: true });
  for (const mode of ['claude', 'shell', 'unknown-agent'])
    expect(cliInputProtocol(mode)).toEqual({ requiresEmptyComposer: false, shellKeyGuard: false });
  expect(Object.isFrozen(cliInputProtocol('codex'))).toBe(true);
});
it('uses the declared protocol on an actual custom registry entry without borrowing stock identity', async () => {
  await customProtocol('codex', 'custom-owned');
  expect(cliInputProtocol('custom-owned')).toEqual(cliInputProtocol('codex'));
  expect(pastesInsteadOfKeys('custom-owned', 'a'.repeat(1001))).toBe(true);
  const session = new Session({ id: 'custom-owned-session', mode: 'custom-owned' as SessionMode, workingDir: directory, useMux: false });
  sessions.push(session);
  expect(session.canAcceptChatInput()).toBe(false); // No readable composer is no empty-composer proof.
});
it('selects the shell-key guard by an actual declared custom profile rather than its identifier', async () => {
  await customProtocol('opencode', 'custom-bang');
  expect(cliInputProtocol('custom-bang').shellKeyGuard).toBe(true);
  expect(pastesInsteadOfKeys('custom-bang', 'a'.repeat(1001))).toBe(false);
});
it('preserves the exact paste threshold and leaves control-key sequences on the key path', () => {
  expect(CODEX_KEY_BURST_MAX_CHARS).toBe(1000);
  expect(pastesInsteadOfKeys('codex', 'a'.repeat(1000))).toBe(false);
  expect(pastesInsteadOfKeys('codex', 'a'.repeat(1001))).toBe(true);
  for (const control of ['\r', '\n', '\x1b', '\x7f', '\x85'])
    expect(pastesInsteadOfKeys('codex', 'a'.repeat(1001) + control)).toBe(false);
  expect(pastesInsteadOfKeys('claude', 'a'.repeat(1001))).toBe(false);
});
it('rejects unknown guards and invalid burst limits at the actual schema boundary', () => {
  const entry = structuredClone(registry.getCli('codex')!);
  for (const terminalInput of [{ shellKeyGuard: 'unimplemented' }, { keyBurstMaxChars: 0 },
    { keyBurstMaxChars: 1.5 }, { keyBurstMaxChars: 1_048_577 }, { unexpected: true }])
    expect(CliEntrySchema.safeParse({ ...entry, capabilities: { ...entry.capabilities, terminalInput } }).success).toBe(false);
});
it('binds actual Session input admission to original protocol values across reload and observed ABA', async () => {
  await customProtocol('opencode', 'custom-bang');
  const session = new Session({ id: 'custom-bang-session', mode: 'custom-bang' as SessionMode, workingDir: directory, useMux: false });
  sessions.push(session);
  const admitted = session.captureInputAdmission();
  expect(admitted()).toBe(true);
  await replaceCustomInput('custom-bang', { shellKeyGuard: 'bang-shell' }, 'Renamed display');
  expect(admitted()).toBe(true); // Cosmetic reload does not revoke a physical protocol.
  await replaceCustomInput('custom-bang', {});
  expect(admitted()).toBe(false);
  expect(session.captureInputAdmission()()).toBe(true);
  await replaceCustomInput('custom-bang', { shellKeyGuard: 'bang-shell' });
  expect(admitted()).toBe(false); // Restoring bytes cannot revive an already revoked write.
  expect(session.captureInputAdmission()()).toBe(true);
});
