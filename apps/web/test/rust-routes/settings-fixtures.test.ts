/**
 * The two tables the Rust settings handler compiles in, checked against their single sources here:
 * the error-code table in types/api.ts, and what this Node prints for each inherited Object.prototype
 * name. A Node upgrade that changes those strings fails here before the Rust side can drift.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types/api.js';

// The Nix web derivation is flattened to apps/web, so package.nix copies the tables into test/fixtures.
const copied = resolve(import.meta.dirname, '../fixtures/settings-v1');
const source = resolve(import.meta.dirname, '../../../../crates/reverie-contracts/src/settings_v1');
const tables = existsSync(join(copied, 'error-status.json')) ? copied : source;
const read = (name: string) => JSON.parse(readFileSync(join(tables, name), 'utf8')) as Record<string, unknown>;

describe('settings handler tables', () => {
  it('error-status.json is exactly the ErrorStatus table', () => {
    const table = read('error-status.json');
    expect(Object.keys(table).sort()).toEqual(Object.values(ApiErrorCode).sort());
    for (const code of Object.values(ApiErrorCode)) expect(table[code], code).toBe(httpStatusForErrorCode(code));
  });

  it('inherited-error-codes.json is what this Node prints for every Object.prototype name', () => {
    const fixture = read('inherited-error-codes.json') as { nodeVersion: string; prefix: string; names: object };
    expect(fixture.nodeVersion).toBe(process.version);
    const names: Record<string, string> = {};
    for (const name of Object.getOwnPropertyNames(Object.prototype).sort())
      Object.defineProperty(names, name, {
        value: String(({} as Record<string, unknown>)[name]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    expect(Object.entries(fixture.names)).toEqual(Object.entries(names));
    // Each name really takes the inherited path: the lookup returns a non-number.
    for (const name of Object.keys(names))
      expect(typeof httpStatusForErrorCode(name as ApiErrorCode), name).not.toBe('number');
  });
});
