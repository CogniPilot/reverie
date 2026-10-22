// Run inside a disposable image container AFTER its network has been disconnected.
// The pinned provider is installed at runtime, never added to a published image.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const consoleRoot = '/opt/reverie/console';
const { STOCK_CLIS } = await import(pathToFileURL(join(consoleRoot, 'dist/config/cli-registry/stock.js')));
const { buildSpawnCommandFromRegistry } = await import(pathToFileURL(join(consoleRoot, 'dist/session-cli-registry-bridge.js')));
const require = createRequire(join(consoleRoot, 'package.json'));
const pty = require('node-pty');
const data = process.env.REVERIE_DATA || '/instances/default';
const tools = join(data, 'tools');
const installed = JSON.parse(readFileSync(join(tools, '.install-codex.json'), 'utf8'));
assert.equal(installed.state, 'ready', 'Pinned Codex installation is not runnable');
const entry = STOCK_CLIS.find((cli) => cli.id === 'codex');
assert.ok(entry, 'Built application has no stock Codex entry');

const scratch = mkdtempSync(join(process.env.TMPDIR || '/scratch/tmp', 'codex-runtime-ci-'));
try {
  const home = join(scratch, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  // Construct rather than inherit: no API keys, provider logins, or user configuration.
  const env = { HOME: home, CODEX_HOME: join(home, '.codex'), TMPDIR: scratch,
    PATH: `${join(tools, 'bin')}:/bin`, TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  const run = (command) => spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
    cwd: scratch, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const version = run('exec codex --version');
  assert.equal(version.status, 0, 'Pinned Codex --version failed');
  assert.match(version.stdout, new RegExp(`\\b${installed.version.replaceAll('.', '\\.')}\\b`), 'Wrong Codex version');
  // Negative control: --help must still detect unknown options, or this smoke is ineffective.
  assert.notEqual(run('exec codex --reverie-ci-unknown-option --help').status, 0, 'CLI help ignored an unknown option');
  const variants = [
    {},
    { dangerouslyBypassApprovals: false, animations: false, model: 'gpt-5.3-codex', reasoningEffort: 'high' },
    { dangerouslyBypassApprovals: true, animations: true, model: 'gpt-5.3-codex', reasoningEffort: 'medium' },
    { resumeSessionId: '00000000-0000-4000-8000-000000000001', reasoningEffort: 'low' },
  ];
  const commands = variants.map((codexConfig) => buildSpawnCommandFromRegistry(entry, {
    mode: 'codex', sessionId: '00000000-0000-4000-8000-000000000001', codexConfig,
  }));
  for (const [index, command] of commands.entries()) {
    assert.ok(command?.startsWith('codex'), 'Application failed to render a Codex launch');
    assert.equal(run(`exec ${command} --help`).status, 0,
      `Generated stock Codex launch variant ${index} failed real CLI argument parsing: ${command}`);
  }

  // Open the real interactive CLI on a PTY, without sending a prompt or signing in.
  // An exit before the startup window is a failure even when argument help passed.
  await new Promise((resolve, reject) => {
    let output = '';
    let stopping = false;
    const terminal = pty.spawn('bash', ['--noprofile', '--norc', '-c', `exec ${commands[1]}`], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: scratch, env,
    });
    terminal.onData((text) => {
      output = (output + text).slice(-64 * 1024);
      // Answer only terminal capability probes, never application prompts.
      if (text.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      if (text.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    });
    const timer = setTimeout(() => {
      stopping = true;
      terminal.kill('SIGKILL');
      if (!output.trim() || /unexpected argument|unknown (?:option|flag)|unrecognized option|setlocale:.*cannot change locale/i.test(output)) {
        reject(new Error('Codex did not reach a clean interactive startup'));
      } else resolve();
    }, 5000);
    terminal.onExit(() => {
      if (stopping) return;
      clearTimeout(timer);
      reject(new Error('Codex exited before interactive startup completed'));
    });
  });
  console.log(`Pinned Codex ${installed.version}: generated launch arguments and isolated interactive startup passed.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
