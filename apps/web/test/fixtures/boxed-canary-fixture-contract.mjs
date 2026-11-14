/** Closed synthetic fixture DATA. Never an authentication or native grant. */
import fs from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
const IMAGE = 'sha256:6d564413f4ce3128eb5a349ae419fca3925be99c7c6ab705ebd538aacdc35bce';
const LEGACY = Object.freeze({
  version: 1,
  purpose: 'synthetic-boxed-office-fixture-v1',
  employeeId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  generation: 1,
  providerThread: '44444444-4444-4444-8444-444444444444',
  operationId: '85c5b805-0b16-46e7-8fee-8870c9e39fcc',
  sourceCid: '4bb91b4a27c8f9a58f4ce03c342ce0c3d3fc79419b2aeaefa4b60437c41e9865',
  imageId: IMAGE,
  workdir: '/reverie_workspace/cases/boxed-canary',
  sourceTask: 'boxed-provider-source-fixture-20261113',
  sourceFixtureId: 'a5d23c5e66448c652ae99805aa2f0bcb',
  home: Object.freeze({
    path: '/tmp/reverie/tasks/boxed-provider-source-fixture-20261113/home',
    dev: '66308',
    ino: '93205240',
    uid: 1000,
    gid: 100,
    mode: '0700',
  }),
});
function keys(value, expected) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== expected.slice().sort().join(',')
  )
    throw Error('Closed synthetic fixture fields required');
}
function validateCanaryFixture(value) {
  keys(value, Object.keys(LEGACY));
  keys(value.home, Object.keys(LEGACY.home));
  const ids = [value.employeeId, value.sessionId, value.providerThread, value.operationId];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const task = /^(?:boxed-provider-source[0-9]*-fixture-[0-9]{8}|ci-agent-office-[A-Za-z0-9_-]{1,64})$/;
  if (
    !ids.every((v) => typeof v === 'string' && uuid.test(v)) ||
    new Set(ids).size !== ids.length ||
    value.version !== 1 ||
    value.purpose !== LEGACY.purpose ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageId) ||
    value.workdir !== LEGACY.workdir ||
    typeof value.sourceTask !== 'string' ||
    !task.test(value.sourceTask) ||
    typeof value.sourceFixtureId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.sourceFixtureId) ||
    typeof value.sourceCid !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sourceCid) ||
    value.home.path !== '/tmp/reverie/tasks/' + value.sourceTask + '/home' ||
    !Number.isSafeInteger(value.home.uid) ||
    value.home.uid < 0 ||
    !Number.isSafeInteger(value.home.gid) ||
    value.home.gid < 0 ||
    value.home.mode !== '0700' ||
    typeof value.home.dev !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value.home.dev) ||
    typeof value.home.ino !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value.home.ino)
  )
    throw Error('Synthetic fixture scope refused');
  return Object.freeze({ ...value, home: Object.freeze({ ...value.home }) });
}
function decodeCanaryFixture(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw Error('Fixture frame bound refused');
  const value = JSON.parse(raw);
  if (JSON.stringify(value) + '\n' !== raw) throw Error('Canonical fixture frame required');
  return validateCanaryFixture(value);
}
function stamp(s) {
  return [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
}
function loadCanaryFixtureContract(file) {
  if (file === undefined) return LEGACY;
  if (typeof file !== 'string' || resolve(file) !== file || !file.endsWith('/boxed-canary-contract.json'))
    throw Error('Explicit fixed fixture contract filename required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let result, failure;
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 4096 ||
      stamp(before) !== stamp(fs.lstatSync(file))
    )
      throw Error('Fixture contract custody refused');
    const bytes = Buffer.alloc(4097);
    let count = 0;
    for (;;) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      count += n;
      if (!n || count === bytes.length) break;
    }
    if (
      count !== before.size ||
      stamp(before) !== stamp(fs.fstatSync(fd)) ||
      stamp(before) !== stamp(fs.lstatSync(file))
    )
      throw Error('Fixture contract changed');
    const raw = bytes.subarray(0, count).toString('utf8');
    if (!Buffer.from(raw).equals(bytes.subarray(0, count))) throw Error('Fixture encoding refused');
    result = decodeCanaryFixture(raw);
  } catch (cause) {
    failure = cause;
  }
  try {
    fs.closeSync(fd);
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause], 'Fixture finalization failed');
  }
  if (failure !== undefined) throw failure;
  return result;
}
export { LEGACY, validateCanaryFixture, decodeCanaryFixture, loadCanaryFixtureContract };
