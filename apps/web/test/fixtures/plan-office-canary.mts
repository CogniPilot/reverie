/** Explicit immutable-package baseline entry. Product imports see only this fresh private HOME. */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
if (process.argv.length !== 4 || process.argv[2] !== '--contract' || !process.argv[3])
  throw Error('Use --contract <private reviewed fixture JSON>');
assert.ok(process.getuid!() > 0 && process.getgid!() > 0);
const file = path.resolve(process.argv[3]),
  parent = path.dirname(file),
  directory = fs.lstatSync(parent);
assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
assert.equal(directory.uid, process.getuid!());
assert.equal(directory.mode & 0o777, 0o700);
const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
let instance: string;
try {
  const stat = fs.fstatSync(fd);
  assert.ok(stat.isFile());
  assert.equal(stat.uid, process.getuid!());
  assert.equal(stat.nlink, 1);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(stat.size > 0 && stat.size <= 65536);
  const bytes = fs.readFileSync(fd);
  assert.equal(bytes.length, stat.size);
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text).equals(bytes));
  instance = JSON.parse(text).instance;
  assert.match(instance, /^[a-f0-9]{32}$/);
} finally {
  fs.closeSync(fd);
}
const home = path.join(parent, 'driver-home-' + instance);
fs.mkdirSync(home, { mode: 0o700 });
fs.mkdirSync(path.join(home, 'data'), { mode: 0o700 });
fs.mkdirSync(path.join(home, 'tmp'), { mode: 0o700 });
// No inherited personal instance, vendor credential, module preload or application selector.
for (const key of Object.keys(process.env))
  if (!['PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key)) delete process.env[key];
process.env.HOME = home;
process.env.REVERIE_DATA_DIR = path.join(home, 'data');
process.env.TMPDIR = path.join(home, 'tmp');
const { runPlanOfficeBaseline } = await import('../helpers/plan-office-driver.js');
process.stdout.write(JSON.stringify(await runPlanOfficeBaseline(file)) + '\n');
