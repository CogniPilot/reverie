import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function recoveryLedgerBinary(): string {
  const root = resolve(import.meta.dirname, '../../../../');
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
  const binary = process.env.NIX_TEST_RECOVERY_LEDGER ?? resolve(target, 'debug/reverie-recovery-ledger');
  if (!existsSync(binary)) {
    throw new Error('Build the native recovery ledger with cargo build -p reverie-store --bin reverie-recovery-ledger');
  }
  return binary;
}
