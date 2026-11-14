/** Disposable canary only: real owner API, no cookie construction, Engine or continuation dispatch. */
import { randomBytes } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCanaryFixtureContract, type CanaryFixture } from '../fixtures/boxed-canary-fixture-contract.mjs';

export const CANARY_EMPLOYEE = '11111111-1111-4111-8111-111111111111';
export const CANARY_SESSION = '22222222-2222-4222-8222-222222222222';
export const CANARY_GENERATION = 1;
type Json = Record<string, unknown>;
type RecordedRequest = { method: string; path: string; status: number };
function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Canary response object refused');
  return value as Json;
}
function target(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.port === '3000' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error('Use the exact disposable loopback mapped port, never the office port');
  return url;
}
async function privateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (
    resolve(directory) !== directory ||
    (await fs.realpath(directory)) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw Error('Canary private context directory refused');
}
async function privateRecord(directory: string, name: string, value: unknown): Promise<string> {
  const path = join(directory, name);
  const file = await fs.open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw Error('Canary empty response refused');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw Error('Canary response bound exceeded');
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks);
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes)) throw Error('Canary response encoding refused');
  return JSON.parse(raw);
}
function client(url: URL, requests: RecordedRequest[]) {
  return async (path: string, method = 'GET', body?: Json, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(path, url), {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { origin: url.origin, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requests.push({ method, path, status: response.status });
    return response;
  };
}
async function success(response: Response): Promise<Json> {
  if (response.status !== 200) throw Error('Canary API refused or outcome unconfirmed');
  const envelope = record(await boundedJson(response));
  if (envelope.success !== true) throw Error('Canary success envelope absent');
  return record(envelope.data);
}
function ownerCookie(response: Response): string {
  const cookies = response.headers.getSetCookie().filter((value) => value.startsWith('reverie_owner='));
  if (cookies.length !== 1) throw Error('Actual owner login cookie absent');
  return cookies[0].split(';')[0];
}
async function authenticate(
  request: ReturnType<typeof client>,
  directory: string
): Promise<{ cookie: string; sessionFile: string }> {
  const status = await success(await request('/api/owner/status'));
  if (status.configured !== false || status.setupAvailable !== true || status.signedIn !== false)
    throw Error('Canary site is not pristine; no setup/reset attempted');
  const username = 'canary-owner';
  const password = randomBytes(32).toString('base64url');
  await privateRecord(directory, 'owner-enrollment-intent.json', { username, password });
  await success(await request('/api/owner/setup', 'POST', { username, password, confirmation: password }));
  return signIn(request, directory, username, password, 'owner-session.json');
}
async function signIn(
  request: ReturnType<typeof client>,
  directory: string,
  username: string,
  password: string,
  sessionName: string
): Promise<{ cookie: string; sessionFile: string }> {
  const login = await request('/api/owner/login', 'POST', { username, password });
  const cookie = ownerCookie(login);
  const result = await success(login);
  if (result.next !== 'done') throw Error('Canary owner login is not complete');
  const sessionFile = await privateRecord(directory, sessionName, { cookie });
  const current = await success(await request('/api/owner/status', 'GET', undefined, { cookie }));
  if (current.configured !== true || current.signedIn !== true || current.policy !== 'enforce')
    throw Error('Actual owner session currentness refused');
  return { cookie, sessionFile };
}
async function verifyFixture(
  request: ReturnType<typeof client>,
  cookie: string,
  fixture: CanaryFixture
): Promise<void> {
  const company = await success(await request('/api/company', 'GET', undefined, { cookie }));
  if (!Array.isArray(company.employees) || company.employees.length !== 1)
    throw Error('Expected exactly one synthetic canary employee');
  const employee = record(company.employees[0]);
  if (
    employee.id !== fixture.employeeId ||
    employee.sessionId !== fixture.sessionId ||
    employee.sessionGeneration !== fixture.generation
  )
    throw Error('Synthetic canary employee binding differs');
}
async function refusalControls(
  request: ReturnType<typeof client>,
  cookie: string,
  fixture: CanaryFixture
): Promise<void> {
  const requests: Array<Parameters<typeof request>> = [
    ['/api/company', 'GET', undefined, { 'x-reverie-parent-session': fixture.sessionId }],
    ['/api/company', 'GET', undefined, { cookie, 'x-reverie-parent-session': fixture.sessionId }],
    ['/api/company', 'GET', undefined, { cookie, 'x-reverie-worker-identity': 'malformed' }],
    ['/api/hook-event', 'POST', { sessionId: fixture.sessionId, event: 'stop', data: {} }, { cookie }],
    ['/api/status-telemetry', 'POST', { sessionId: fixture.sessionId, data: {} }, { cookie }],
  ];
  for (const args of requests) {
    const response = await request(...args);
    if (response.status !== 403) throw Error('Boxed machine-proof refusal control failed');
    await response.body?.cancel();
  }
}
/** Caller must freshly verify the actual disposable Docker control CID, mapped
 * loopback port and owned fixture labels before calling. These HTTP checks do
 * not establish that native identity or authorize any production request. */
export async function enrollDockerCanaryOwner(endpoint: string, directory: string, contractFile?: string) {
  const fixture = loadCanaryFixtureContract(contractFile);
  const url = target(endpoint);
  await privateDirectory(directory);
  const requests: RecordedRequest[] = [];
  const request = client(url, requests);
  const owner = await authenticate(request, directory);
  await verifyFixture(request, owner.cookie, fixture);
  await refusalControls(request, owner.cookie, fixture);
  const policy = await success(
    await request('/api/company/employees/' + fixture.employeeId + '/docker-policy', 'GET', undefined, {
      cookie: owner.cookie,
    })
  );
  const report = {
    version: 1,
    purpose: 'reverie-disposable-owner-http-canary-v1',
    endpoint: url.origin,
    employeeId: fixture.employeeId,
    sessionId: fixture.sessionId,
    sessionGeneration: fixture.generation,
    ownerAuthenticated: true,
    ownerNoParentPolicyRead: true,
    canApprovePolicy: policy.canApprovePolicy,
    requests,
    noContinuationDispatched: true,
    limitation: 'Synthetic owner/Company fixture only; no provider, Engine or production readiness claim.',
  };
  await privateRecord(directory, 'owner-http-report.json', report);
  return { report, ownerSessionFile: owner.sessionFile };
}

function credentialStamp(value: Stats): string {
  return [
    value.dev,
    value.ino,
    value.uid,
    value.gid,
    value.mode,
    value.nlink,
    value.size,
    value.mtimeMs,
    value.ctimeMs,
  ].join(':');
}
async function privateSavedObject(directory: string, name: string): Promise<Json> {
  const path = join(directory, name);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let failure: unknown, value: Json | undefined;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 4096 ||
      credentialStamp(before) !== credentialStamp(await fs.lstat(path))
    )
      throw Error('Saved synthetic credential custody refused');
    const bytes = Buffer.alloc(4097);
    let count = 0;
    for (;;) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      count += read.bytesRead;
      if (!read.bytesRead || count === bytes.length) break;
    }
    if (
      count !== before.size ||
      credentialStamp(before) !== credentialStamp(await file.stat()) ||
      credentialStamp(before) !== credentialStamp(await fs.lstat(path))
    )
      throw Error('Saved synthetic credential changed');
    const raw = bytes.subarray(0, count).toString('utf8');
    if (!Buffer.from(raw).equals(bytes.subarray(0, count))) throw Error('Saved credential encoding refused');
    try {
      value = record(JSON.parse(raw));
    } catch {
      throw Error('Saved canary JSON refused');
    }
  } catch (cause) {
    failure = cause;
  }
  try {
    await file.close();
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause], 'Saved credential close failed');
  }
  if (failure !== undefined) throw failure;
  if (!value) throw Error('Saved enrollment absent');
  return value;
}
export function validCanaryCookieName(name: string): boolean {
  return (
    ['owner-session.json', 'owner-session-after-control1.json'].includes(name) ||
    /^owner-session-control-[a-f0-9]{64}\.json$/.test(name)
  );
}
async function savedEnrollment(directory: string): Promise<{ username: string; password: string }> {
  const decoded = await privateSavedObject(directory, 'owner-enrollment-intent.json');
  if (
    Object.keys(decoded).sort().join(',') !== 'password,username' ||
    decoded.username !== 'canary-owner' ||
    typeof decoded.password !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(decoded.password)
  )
    throw Error('Saved synthetic enrollment differs');
  return { username: decoded.username, password: decoded.password };
}
/** Caller must freshly verify this exact disposable control CID, endpoint and SAME
 * data/key. A previously issued immutable cookie is reused only after actual
 * signedIn/enforce owner proof. Only explicit signedIn:false permits one login.
 * No setup, reset, policy selection, observation or continuation is called. */
export async function loginDockerCanaryOwner(
  endpoint: string,
  directory: string,
  controlId: string,
  previousSessionName: string,
  contractFile?: string
) {
  const fixture = loadCanaryFixtureContract(contractFile);
  if (!/^[a-f0-9]{64}$/.test(controlId) || !validCanaryCookieName(previousSessionName))
    throw Error('Exact control CID and closed prior cookie filename required');
  const url = target(endpoint);
  await privateDirectory(directory);
  const requests: RecordedRequest[] = [];
  const request = client(url, requests);
  await privateRecord(directory, 'owner-control-' + controlId + '-intent.json', {
    controlId,
    endpoint: url.origin,
    previousSessionName,
    at: new Date().toISOString(),
  });
  const previous = await privateSavedObject(directory, previousSessionName);
  if (
    Object.keys(previous).join(',') !== 'cookie' ||
    typeof previous.cookie !== 'string' ||
    !/^reverie_owner=[^;\r\n]+$/.test(previous.cookie)
  )
    throw Error('Prior cookie frame refused');
  const status = await success(await request('/api/owner/status', 'GET', undefined, { cookie: previous.cookie }));
  if (
    status.configured !== true ||
    status.setupAvailable !== false ||
    status.policy !== 'enforce' ||
    typeof status.signedIn !== 'boolean'
  )
    throw Error('Existing enforced canary owner account required');
  let owner: { cookie: string; sessionFile: string },
    loginIssued = false;
  if (status.signedIn) {
    if (
      status.mustChange !== false ||
      status.username !== 'canary-owner' ||
      record(status.identity).role !== 'owner' ||
      record(status.identity).primary !== true
    )
      throw Error('Prior session is not the unrestricted expected owner');
    owner = { cookie: previous.cookie, sessionFile: join(directory, previousSessionName) };
  } else {
    const saved = await savedEnrollment(directory);
    loginIssued = true;
    owner = await signIn(
      request,
      directory,
      saved.username,
      saved.password,
      'owner-session-control-' + controlId + '.json'
    );
  }
  await verifyFixture(request, owner.cookie, fixture);
  await refusalControls(request, owner.cookie, fixture);
  const report = {
    version: 2,
    purpose: 'reverie-disposable-owner-current-or-login-v2',
    controlId,
    endpoint: url.origin,
    employeeId: fixture.employeeId,
    sessionId: fixture.sessionId,
    sessionGeneration: fixture.generation,
    ownerAuthenticated: true,
    loginIssued,
    previousCookieReused: !loginIssued,
    requests,
    noSetupResetOrContinuation: true,
  };
  await privateRecord(directory, 'owner-control-' + controlId + '-report.json', report);
  return { report, ownerSessionFile: owner.sessionFile };
}
