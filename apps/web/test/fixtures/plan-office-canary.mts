/** Explicit immutable-package entry. Product imports see only this fresh private HOME. */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { PlanOfficeStartupStage } from '../helpers/plan-office-startup-diagnostic.js';
// Both the source-only refusal test and emitted immutable entry use this one codec.
const { PLAN_OFFICE_STARTUP_PREFIX, planOfficeStartupDiagnostic } = await import(
  import.meta.url.endsWith('.mts')
    ? '../helpers/plan-office-startup-diagnostic.ts'
    : '../helpers/plan-office-startup-diagnostic.js'
);
let stage: PlanOfficeStartupStage = 'entry-arguments';
let instance: string | null = null;
try {
  let args = process.argv.slice(2);
  // Correlation DATA only. It never selects a backend or grants any operation.
  if (args.at(-2) === '--diagnostic-instance' && /^[a-f0-9]{32}$/.test(args.at(-1) ?? '')) {
    instance = args.at(-1)!;
    args = args.slice(0, -2);
  }
  const readyForce = args[2] === '--ready-owner-force',
    readySelf = args[2] === '--ready-self',
    checkImport = args[2] === '--check-import';
  if (args.length !== (readySelf || readyForce || checkImport ? 3 : 2) || args[0] !== '--contract' || !args[1])
    throw Error('Use --contract <private reviewed fixture JSON>');
  assert.ok(process.getuid!() > 0 && process.getgid!() > 0);
  stage = 'entry-contract';
  const file = path.resolve(args[1]),
    parent = path.dirname(file),
    directory = fs.lstatSync(parent);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(directory.uid, process.getuid!());
  assert.equal(directory.mode & 0o777, 0o700);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
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
    const contractInstance: unknown = JSON.parse(text).instance;
    assert.equal(typeof contractInstance, 'string');
    assert.match(contractInstance as string, /^[a-f0-9]{32}$/);
    if (instance !== null) assert.equal(contractInstance, instance);
    instance = contractInstance as string;
  } finally {
    fs.closeSync(fd);
  }
  stage = 'entry-private-home';
  const home = path.join(
    parent,
    (readyForce ? 'ready-owner-force-home-' : readySelf ? 'ready-self-home-' : 'driver-home-') + instance
  );
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(path.join(home, 'data'), { mode: 0o700 });
  fs.mkdirSync(path.join(home, 'tmp'), { mode: 0o700 });
  // No inherited personal instance, vendor credential, module preload or application selector.
  for (const key of Object.keys(process.env))
    if (!['PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key)) delete process.env[key];
  process.env.HOME = home;
  process.env.REVERIE_DATA_DIR = path.join(home, 'data');
  process.env.TMPDIR = path.join(home, 'tmp');
  stage = 'entry-driver-import';
  const driver = await import('../helpers/plan-office-driver.js');
  if (checkImport) {
    stage = 'entry-import-exports';
    assert.equal(typeof driver.runPlanOfficeBaseline, 'function');
    assert.equal(typeof driver.runPlanOfficeReadySelf, 'function');
    assert.equal(typeof driver.PlanOfficeDriverInput.parse, 'function');
    // Inert module qualification only; no Driver or server constructor is called.
    process.stdout.write(
      JSON.stringify({ version: 1, purpose: 'reverie-ci-plan-office-import-smoke-v1', instance, imported: true }) + '\n'
    );
  } else {
    const entered = (value: PlanOfficeStartupStage) => {
      stage = value;
    };
    process.stdout.write(
      JSON.stringify(
        await (readyForce
          ? driver.runPlanOfficeReadyOwnerForce(file, entered)
          : readySelf
            ? driver.runPlanOfficeReadySelf(file, entered)
            : driver.runPlanOfficeBaseline(file, entered))
      ) + '\n'
    );
  }
} catch (error) {
  process.stdout.write(
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(planOfficeStartupDiagnostic(stage, instance, error)) + '\n'
  );
  process.stderr.write(
    stage === 'entry-arguments'
      ? 'Use --contract <private reviewed fixture JSON>\n'
      : 'Plan office fixture failed; inspect the closed startup diagnostic.\n'
  );
  process.exitCode = 1;
}
