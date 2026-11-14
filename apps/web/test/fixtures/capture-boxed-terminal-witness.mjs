/** Real browser keyboard -> actual synthetic provider receipt. Never starts a provider. */
import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import {
  loadVerifiedCanaryOwner,
  applyVerifiedOwnerCookie,
  verifyCanaryControl,
  inspectCanaryContainer,
  readPrivateCanaryJson,
  canaryGet,
  selectCanaryDebugChannel,
  verifyCanaryServedGui,
} from './boxed-canary-browser-proof.mjs';

const [proofFile, sourceProofFile, output, sessionName = 'owner-session-after-control1.json', contractFile] =
  process.argv.slice(2);
assert(
  proofFile && sourceProofFile && output && resolve(sourceProofFile) === sourceProofFile && resolve(output) === output
);
const canary = await loadVerifiedCanaryOwner(proofFile, sessionName, contractFile);
const fixture = canary.fixture;
const sourceProof = JSON.parse(await fs.readFile(sourceProofFile, 'utf8'));
assert(sourceProof.sourceCid === fixture.sourceCid && sourceProof.sourceImage === fixture.imageId);
assert(
  sourceProof.home.path === fixture.home.path &&
    sourceProof.home.dev === fixture.home.dev &&
    sourceProof.home.ino === fixture.home.ino
);
const home = sourceProof.home.path,
  receiptFile = join(home, 'boxed-canary-provider-input.json');
const report = {
  version: 1,
  purpose: 'real-browser-synthetic-terminal-witness-v1',
  control: canary.proof.cid,
  endpoint: canary.endpoint.origin,
  operationId: fixture.operationId,
  sessionId: fixture.sessionId,
  keyboardIssued: false,
  passed: false,
  network: [],
  pageErrors: [],
  limitations: [
    'Fake external provider with the fixture image only; no real Claude/production readiness claim.',
    'Ready is required from the actual API and fresh Engine facts; no mock transport or synthetic ready response.',
    'Runtime integration only; final baked Console image qualification remains a separate mandatory gate.',
  ],
};
await fs.mkdir(output, { mode: 0o700 });
async function readiness() {
  verifyCanaryControl(canary);
  const source = inspectCanaryContainer(sourceProof.sourceCid);
  assert(source.State.Running === false && source.Image === sourceProof.sourceImage);
  assert(
    source.Config.Labels['reverie.task'] === fixture.sourceTask &&
      source.Config.Labels['reverie.disposable'] === fixture.sourceFixtureId &&
      source.Config.Labels['reverie.employee'] === fixture.employeeId &&
      source.Config.Labels['reverie.session'] === fixture.sessionId
  );
  const sourceHome = source.Mounts.filter((m) => m.Destination === '/home/agent');
  assert(sourceHome.length === 1 && sourceHome[0].Source === home && sourceHome[0].RW === true);
  const selection = await canaryGet(canary, '/api/company/employees/' + fixture.employeeId + '/docker-policy');
  assert(
    selection.sessionId === fixture.sessionId &&
      selection.sessionGeneration === fixture.generation &&
      selection.operationId === fixture.operationId
  );
  assert(
    selection.operation?.state === 'ready' && selection.operation?.phase === 'ready',
    'Actual operation is not genuinely ready'
  );
  const selected = execFileSync(
    'docker',
    [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'label=reverie.boxed.operation=' + fixture.operationId,
      '--filter',
      'label=reverie.boxed.employee=' + fixture.employeeId,
      '--filter',
      'label=reverie.boxed.session=' + fixture.sessionId,
      '--filter',
      'label=reverie.boxed.source=' + sourceProof.sourceCid,
      '--format',
      '{{.ID}}',
    ],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }
  ).trim();
  assert(/^[a-f0-9]{64}$/.test(selected), 'Exactly one retained destination required');
  const destination = inspectCanaryContainer(selected);
  assert(
    destination.State.Running === true &&
      !destination.State.Paused &&
      !destination.State.Restarting &&
      !destination.State.Dead
  );
  assert(
    destination.Image === selection.destinationImageId &&
      destination.Config.Labels['reverie.boxed.generation'] === String(fixture.generation)
  );
  const mounts = destination.Mounts.filter((m) => m.Destination === '/home/agent');
  assert(mounts.length === 1 && mounts[0].RW === true && mounts[0].Source === home);
  const current = await fs.stat(home, { bigint: true });
  assert(String(current.dev) === sourceProof.home.dev && String(current.ino) === sourceProof.home.ino);
  assert(
    current.uid === BigInt(fixture.home.uid) &&
      current.gid === BigInt(fixture.home.gid) &&
      (current.mode & 0o777n) === 0o700n
  );
  const marker = await readPrivateCanaryJson(join(home, 'boxed-canary-provider-start.json'), fixture.home.uid);
  assert(
    marker.version === 2 &&
      marker.completed === true &&
      marker.sessionId === fixture.sessionId &&
      marker.resumeThread === fixture.providerThread
  );
  assert(
    marker.capabilityIdentity?.sessionId === fixture.sessionId &&
      marker.hookTransportAcknowledged === true &&
      marker.statusTransportAcknowledged === true
  );
  assert(marker.probes.length === 4 && marker.probes.every((p) => p.exitCode === 0 && !p.signal && !p.errorCode));
  report.destination = selected;
  report.providerPid = marker.pid;
  return marker;
}
function terminalText({ needle, sid }) {
  const terminal = globalThis.app?.terminal,
    buffer = terminal?.buffer?.active;
  if (!buffer || globalThis.app.activeSessionId !== sid) return '';
  const lines = [];
  for (let i = Math.max(0, buffer.length - 200); i < buffer.length; i++)
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  const text = lines.join('\n');
  return typeof needle === 'string' ? text.includes(needle) : text;
}
let browser, context, page;
try {
  const marker = await readiness();
  try {
    await fs.lstat(receiptFile);
    throw Error('Prior input receipt exists; no input attempted');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  browser = await chromium.launch({
    executablePath: process.env.REVERIE_BROWSER_EXECUTABLE || '/run/current-system/sw/bin/microsoft-edge',
    headless: true,
    chromiumSandbox: true,
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await applyVerifiedOwnerCookie(context, canary);
  page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(error.message.slice(0, 1024)));
  page.on('response', (response) => {
    if (report.network.length < 1000)
      report.network.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  await page.goto(canary.endpoint.origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.reverieChat?.built === true);
  const onboarding = page.getByRole('dialog', { name: 'Your name', exact: true });
  if (
    await onboarding.waitFor({ state: 'visible', timeout: 5000 }).then(
      () => true,
      () => false
    )
  ) {
    await onboarding.getByRole('button', { name: 'Cancel', exact: true }).click();
    await onboarding.waitFor({ state: 'hidden' });
  }
  report.gui = await verifyCanaryServedGui(page, canary);
  await selectCanaryDebugChannel(page);
  const member = page.locator('[data-key="member:' + fixture.sessionId + '"]');
  if (!(await member.isVisible())) {
    const toggle = page.locator('[aria-controls="ca-members-list"]');
    if (await toggle.isVisible()) await toggle.click();
  }
  await member.click({ button: 'right', timeout: 10000 });
  await page.locator('.ca-member-menu').getByText('Debug terminal', { exact: true }).click();
  await page.waitForFunction(
    (sid) =>
      globalThis.app?.activeSessionId === sid && globalThis.document.documentElement.dataset.reverieView === 'debug',
    fixture.sessionId
  );
  const input = page.locator('#terminalContainer .xterm-helper-textarea');
  await input.focus();
  assert(await input.evaluate((element) => element === globalThis.document.activeElement));
  await readiness();
  const uuid = randomUUID(),
    challenge = 'BOXED_CANARY_INPUT_' + uuid,
    ack = 'BOXED_CANARY_ACK_' + uuid;
  const intent = await fs.open(
    join(output, 'terminal-input-intent.json'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await intent.writeFile(
      JSON.stringify({
        challenge,
        ack,
        operationId: fixture.operationId,
        destination: report.destination,
        at: new Date().toISOString(),
      }) + '\n'
    );
    await intent.sync();
  } finally {
    await intent.close();
  }
  const directory = await fs.open(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  report.challenge = challenge;
  report.keyboardIssued = true;
  await page.keyboard.type(challenge);
  await page.keyboard.press('Enter');
  await page.waitForFunction(terminalText, { needle: ack, sid: fixture.sessionId }, { timeout: 20000 });
  const receipt = await readPrivateCanaryJson(receiptFile, fixture.home.uid);
  assert(receipt.version === 1 && receipt.purpose === 'synthetic-boxed-provider-input-v1');
  assert(
    receipt.challenge === challenge &&
      receipt.sessionId === fixture.sessionId &&
      receipt.providerThread === fixture.providerThread &&
      receipt.pid === marker.pid
  );
  report.receipt = receipt;
  report.receiptSha256 = createHash('sha256')
    .update(await fs.readFile(receiptFile))
    .digest('hex');
  report.acknowledged = true;
  assert.deepEqual(report.pageErrors, [], 'Unexpected real browser errors');
  await page.screenshot({ path: join(output, 'terminal-witness.png'), fullPage: true });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.message).slice(0, 2048);
  if (page) {
    await fs
      .writeFile(join(output, 'failure-dom.html'), (await page.content()).slice(0, 1024 * 1024), {
        mode: 0o600,
        flag: 'wx',
      })
      .catch(() => {});
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await fs
      .writeFile(join(output, 'terminal-buffer.txt'), await page.evaluate(terminalText, { sid: fixture.sessionId }), {
        mode: 0o600,
        flag: 'wx',
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  await fs.writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
