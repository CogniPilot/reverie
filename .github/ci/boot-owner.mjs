// Run inside a disposable office container. Credentials stay in this process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const origin = 'http://127.0.0.1:3000';
const username = 'ci-owner';
const data = process.env.REVERIE_DATA || '/instances/default';

async function check(label, expected, path, { body, jar, headers = {} } = {}) {
  const requestHeaders = new Headers({ Origin: origin, ...headers });
  if (body) requestHeaders.set('Content-Type', 'application/json');
  if (jar?.size) requestHeaders.set('Cookie', [...jar.values()].join('; '));
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  assert.equal(response.status, expected, label);
  if (jar) {
    for (const header of response.headers.getSetCookie()) {
      const [cookie] = header.split(';', 1);
      const name = cookie.slice(0, cookie.indexOf('='));
      jar.set(name, cookie);
    }
  }
  console.log(`${label}: ${response.status}`);
}

function resetPassword() {
  const result = spawnSync('reverie', ['owner', 'reset-password'], {
    env: { ...process.env, REVERIE_DATA_DIR: join(data, 'console') },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 32_768,
  });
  assert.equal(result.status, 0, 'owner recovery CLI exited successfully');
  assert.ok(/^Owner: ci-owner$/m.test(result.stdout), 'recovery preserved the chosen username');
  const password = /^One-time password: (\S+)$/m.exec(result.stdout)?.[1];
  assert.ok(password, 'recovery issued a one-time password');
  return password;
}

const password = randomBytes(24).toString('base64url');
const setup = { username, password, confirmation: password };
const initial = new Map();
await check('first-run account page', 200, '/owner/setup');
await check('create chosen owner account', 200, '/api/owner/setup', { body: setup, jar: initial });
await check('new owner session', 200, '/api/status', { jar: initial });
await check('second owner claim refused', 409, '/api/owner/setup', { body: setup });

const consoleSecret = readFileSync(join(data, 'owner-password'), 'utf8').trim();
const authorization = 'Basic ' + Buffer.from('owner:' + consoleSecret).toString('base64');
await check('console password alone refused', 401, '/api/status', { headers: { authorization } });

const current = resetPassword();
const jar = new Map();
await check('one-time sign-in', 200, '/api/owner/login', { body: { username, password: current }, jar });
await check('one-time session requires password change', 403, '/api/status', { jar });
const next = randomBytes(24).toString('base64url');
await check('password change', 200, '/api/owner/password', { body: { current, next }, jar });
await check('signed-in owner', 200, '/api/status', { jar });
await check('console password with agent header refused', 403, '/api/status', {
  headers: { authorization, 'x-reverie-parent-session': '0000002d-0035-4000-8000-000000000047' },
});
