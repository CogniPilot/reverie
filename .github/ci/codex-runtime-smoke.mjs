// Run inside a disposable image container AFTER its network has been disconnected.
// The pinned provider is installed at runtime, never added to a published image.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const consoleRoot = '/opt/reverie/console';
const { STOCK_CLIS } = await import(pathToFileURL(join(consoleRoot, 'dist/config/cli-registry/stock.js')));
const { buildSpawnCommandFromRegistry } = await import(pathToFileURL(join(consoleRoot, 'dist/session-cli-registry-bridge.js')));
const require = createRequire(join(consoleRoot, 'package.json'));
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
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
  // A synthetic known update must never intercept the expert's first message.
  // No account is needed and the container has no network connection.
  writeFileSync(join(home, '.codex', 'version.json'), JSON.stringify({
    latest_version: '999.0.0', last_checked_at: new Date().toISOString(), dismissed_version: null,
  }));
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
    { dangerouslyBypassApprovals: false, animations: false, model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    { dangerouslyBypassApprovals: true, animations: true, model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
    { resumeSessionId: '00000000-0000-4000-8000-000000000001', reasoningEffort: 'low' },
  ];
  const commands = variants.map((codexConfig, index) => buildSpawnCommandFromRegistry(entry, {
    mode: 'codex', sessionId: '00000000-0000-4000-8000-000000000001', codexConfig,
    ...(index === 3 ? { codexTrustWorkspace: scratch } : {}),
  }));
  for (const [index, command] of commands.entries()) {
    assert.ok(command?.startsWith('codex'), 'Application failed to render a Codex launch');
    assert.ok(command.includes('--config check_for_update_on_startup=false'), 'Managed Codex launch permits an interactive updater');
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
      const plain = stripVTControlCharacters(output);
      if (!plain.trim() || /unexpected argument|unknown (?:option|flag)|unrecognized option|setlocale:.*cannot change locale|update available|update now/i.test(plain)) {
        reject(new Error('Codex did not reach a clean interactive startup'));
      } else resolve();
    }, 20_000);
    terminal.onExit(() => {
      if (stopping) return;
      clearTimeout(timer);
      reject(new Error('Codex exited before interactive startup completed'));
    });
  });
  // No real credentials: a fake local key gets past login so this fixture can
  // distinguish directory trust from authentication. Network remains disconnected;
  // no application input or inference is sent. The baseline must show the dialog.
  const trustStartup = async (trusted) => {
    const root = join(scratch, trusted ? 'trusted' : 'untrusted');
    const fixtureHome = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(fixtureHome, '.codex'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    assert.equal(spawnSync('git', ['init', '--quiet', cwd], { env }).status, 0, 'Trust fixture is not a Git project');
    // An empty new directory can open without a trust gate in current Codex.
    // Explicit saved distrust exercises the gate; the managed override must bypass it without changing this file.
    const trustConfig = `[projects.${JSON.stringify(cwd)}]\ntrust_level = "untrusted"\n`;
    writeFileSync(join(fixtureHome, '.codex/config.toml'), trustConfig);
    writeFileSync(join(fixtureHome, '.codex/auth.json'), JSON.stringify({
      auth_mode: 'apikey', OPENAI_API_KEY: 'ci-synthetic-not-a-real-api-key',
    }), { mode: 0o600 });
    const command = buildSpawnCommandFromRegistry(entry, {
      mode: 'codex', sessionId: '00000000-0000-4000-8000-000000000002',
      // Keep the negative control in ordinary approval mode; the managed launch must retain full access.
      codexConfig: { dangerouslyBypassApprovals: trusted },
      ...(trusted ? { codexTrustWorkspace: cwd } : {}),
    });
    await new Promise((resolve, reject) => {
      const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
      let stopping = false;
      const terminal = pty.spawn('bash', ['--noprofile', '--norc', '-c', `exec ${command}`], {
        name: 'xterm-256color', cols: 100, rows: 30, cwd,
        env: { ...env, HOME: fixtureHome, CODEX_HOME: join(fixtureHome, '.codex'), COLORTERM: 'truecolor' },
      });
      terminal.onData((text) => {
        screen.write(text);
        if (text.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
        if (text.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
        if (text.includes('\x1b]11;?')) terminal.write('\x1b]11;rgb:0000/0000/0000\x07');
      });
      const timer = setTimeout(() => {
        stopping = true;
        terminal.kill('SIGKILL');
        screen.write('', () => {
          try {
            const lines = [];
            for (let i = 0; i < screen.buffer.active.length; i++) lines.push(screen.buffer.active.getLine(i).translateToString(true));
            const text = lines.join('\n');
            const trustDialog = /Do you trust the contents of this directory|Folder access[\s\S]*Open restricted/i.test(text);
            if (trusted) {
              assert.equal(trustDialog, false, 'Managed Codex still asks for workspace trust');
              assert.match(text, /OpenAI Codex/, 'Managed Codex did not reach its composer');
              assert.match(text, /YOLO mode/, 'Managed Codex did not retain full access');
              assert.match(text, /^›\s+\S/m, 'Managed Codex has no composer');
            } else assert.equal(trustDialog, true, 'Trust regression fixture failed to reproduce the startup dialog');
            assert.equal(readFileSync(join(fixtureHome, '.codex/config.toml'), 'utf8'), trustConfig, 'Startup changed saved trust');
            resolve();
          } catch (error) { reject(error); }
          finally { screen.dispose(); }
        });
      }, 20_000);
      terminal.onExit(() => {
        if (stopping) return;
        clearTimeout(timer); screen.dispose();
        reject(new Error('Codex exited before workspace-trust startup completed'));
      });
    });
  };
  await Promise.all([trustStartup(false), trustStartup(true)]);
  console.log(`Pinned Codex ${installed.version}: generated launch arguments and isolated interactive startup passed.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
