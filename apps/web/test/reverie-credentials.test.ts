/**
 * @fileoverview The one credential reader `reverie attach`, `reverie tui` and
 * `reverie agent` share: env first, the data dir's `.env` as the fallback.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicAuthHeader, readReverieCredentials, readReverieEnvFile } from '../src/reverie-credentials.js';

describe('readReverieCredentials', () => {
  let dir: string;
  const saved = { user: process.env.REVERIE_USERNAME, pass: process.env.REVERIE_PASSWORD };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reverie-cred-'));
    delete process.env.REVERIE_USERNAME;
    delete process.env.REVERIE_PASSWORD;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.user === undefined) delete process.env.REVERIE_USERNAME;
    else process.env.REVERIE_USERNAME = saved.user;
    if (saved.pass === undefined) delete process.env.REVERIE_PASSWORD;
    else process.env.REVERIE_PASSWORD = saved.pass;
  });

  it('falls back to the .env file, quotes and an export prefix stripped, default user admin', () => {
    const env = join(dir, '.env');
    writeFileSync(env, '# a comment\nnot an assignment\nexport REVERIE_PASSWORD="hunter2"\n');
    expect(readReverieCredentials(env)).toEqual({ username: 'admin', password: 'hunter2' });
  });

  it('prefers the environment over the file', () => {
    const env = join(dir, '.env');
    writeFileSync(env, 'REVERIE_USERNAME=file\nREVERIE_PASSWORD=file-pass\n');
    process.env.REVERIE_USERNAME = 'envuser';
    process.env.REVERIE_PASSWORD = 'env-pass';
    expect(readReverieCredentials(env)).toEqual({ username: 'envuser', password: 'env-pass' });
  });

  it('an absent file means no password, and no header to send', () => {
    const creds = readReverieCredentials(join(dir, 'missing'));
    expect(creds).toEqual({ username: 'admin' });
    expect(basicAuthHeader(creds)).toBeUndefined();
    expect(readReverieEnvFile(join(dir, 'missing'))).toEqual({});
  });

  it('takes an explicit environment, field by field', () => {
    const env = join(dir, '.env');
    writeFileSync(env, 'REVERIE_USERNAME=joe\n');
    expect(readReverieCredentials(env, { REVERIE_PASSWORD: 'pw' })).toEqual({ username: 'joe', password: 'pw' });
  });

  it('builds a Basic header from a password', () => {
    expect(basicAuthHeader({ username: 'joe', password: 'pw' })).toBe(
      `Basic ${Buffer.from('joe:pw').toString('base64')}`
    );
  });
});
