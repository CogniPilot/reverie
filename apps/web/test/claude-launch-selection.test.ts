import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderClaudeLaunch } from '../src/utils/claude-launch.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import { getCli, resolveRegistry } from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { claudeDockerPaneCommand } from '../src/tmux-manager.js';
import { nativeClaudeBackend as native } from './helpers/capture-claude-launch.js';

const SID = '00000008-0008-4000-8000-000000000008';
const OLD = '00000009-0009-4000-8000-000000000009';
const SEED = '00000010-0010-4000-8000-000000000010';
if (!native) throw new Error('Run Claude launch tests with the packaged reverie-backend on PATH');
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
let root: string, home: string, config: string, cwd: string, log: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-launch-'));
  home = join(root, 'home'); config = join(root, 'selected account'); cwd = join(root, 'work'); log = join(root, 'calls');
  for (const path of [home, config, cwd, join(root, 'bin')]) mkdirSync(path);
  symlinkSync(native, join(root, 'bin', 'reverie-backend'));
  const fake = join(root, 'bin', 'claude');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
setTimeout(() => {
  fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR}) + '\\n');
  if (process.env.FIXTURE_PID_LOG) fs.writeFileSync(process.env.FIXTURE_PID_LOG, String(process.pid));
  if (process.env.FIXTURE_SIGNAL) process.kill(process.pid, process.env.FIXTURE_SIGNAL);
  else process.exit(Number(process.env.FIXTURE_EXIT));
}, Number(process.env.FIXTURE_DELAY_MS ?? 0));
`, { mode: 0o700 });
});
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function transcript(id: string, dir = config) {
  const project = join(dir, 'projects', 'old-project-name'); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), 'owned fixture, never read');
}
function execute(command: string, exit = 0, overrides: Record<string, string> = {}) {
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd, encoding: 'utf8', timeout: 5000,
    env: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: join(root, 'bin'), FIXTURE_LOG: log, FIXTURE_EXIT: String(exit), ...overrides },
  });
  return { result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}
function command(ids = [OLD, SID]) {
  return renderClaudeLaunch(ids.map((id) => ({ id, command: `claude --resume ${quote(id)}` })), `claude --session-id ${quote(SID)}`);
}
describe('single launch in actual selected namespace', () => {
  for (const code of [0, 1, 137, 143]) {
    it(`preserves resume exit ${code} without invoking creation`, () => {
      transcript(OLD);
      const { result, calls } = execute(command(), code);
      expect(result.status).toBe(code); expect(result.signal).toBeNull();
      expect(calls).toEqual([{ args: ['--resume', OLD], cwd, config }]);
    });
  }
  for (const signal of ['SIGKILL', 'SIGTERM']) {
    it(`keeps the selected provider in the exec caller and preserves ${signal} without a second provider`, () => {
      transcript(OLD);
      const direct = execute(`exec claude --resume ${quote(OLD)}`, 0, { FIXTURE_SIGNAL: signal });
      rmSync(log);
      // Replace the fixture caller too. An extra non-exec outer shell may
      // legitimately translate child signals to 128+signal (dash vs bash).
      const pidFile = join(root, 'provider.pid');
      const wrapped = execute(`exec ${command()}`, 0, { FIXTURE_SIGNAL: signal, FIXTURE_PID_LOG: pidFile });
      expect([wrapped.result.status, wrapped.result.signal]).toEqual([direct.result.status, direct.result.signal]);
      expect(Number(readFileSync(pidFile, 'utf8'))).toBe(wrapped.result.pid);
      expect(wrapped.calls).toEqual([{ args: ['--resume', OLD], cwd, config }]);
    });
  }
  it('proven absence creates only the existing fresh SID once', () => {
    const { result, calls } = execute(command());
    expect(result.status).toBe(0); expect(calls[0].args).toEqual(['--session-id', SID]); expect(calls).toHaveLength(1);
  });
  it('a missing candidate does not collide with a present fresh SID transcript', () => {
    transcript(SID); const { result, calls } = execute(command());
    expect(result.status).toBe(0); expect(calls[0].args).toEqual(['--resume', SID]); expect(calls).toHaveLength(1);
  });
  it('keeps ordered chain/seed candidates and accepts a one-line transcript under an old project name', () => {
    transcript(SEED); const { calls } = execute(command([OLD, SEED, SID]));
    expect(calls[0].args).toEqual(['--resume', SEED]); expect(calls).toHaveLength(1);
  });
  it('uses the selected account rather than a transcript in an unrelated HOME', () => {
    transcript(OLD, join(home, '.claude')); const { calls } = execute(command());
    expect(calls[0].args).toEqual(['--session-id', SID]);
  });
  it('uses the actual HOME only when CLAUDE_CONFIG_DIR is unset/empty', () => {
    transcript(OLD, join(home, '.claude')); const { calls } = execute(command(), 0, { CLAUDE_CONFIG_DIR: '' });
    expect(calls[0].args).toEqual(['--resume', OLD]);
  });
  it('resolves a relative account directory against unchanged actual cwd', () => {
    const relative = join(cwd, 'account'); transcript(OLD, relative);
    const { calls } = execute(command(), 0, { CLAUDE_CONFIG_DIR: 'account' });
    expect(calls).toEqual([{ args: ['--resume', OLD], cwd, config: 'account' }]);
  });
  for (const kind of ['unreadable-projects', 'unsearchable-project', 'dangling-config', 'dangling-transcript', 'wrong-transcript-type']) {
    it(`refuses unknown metadata (${kind}) before any provider`, () => {
      if (kind === 'dangling-config') { rmSync(config, { recursive: true }); symlinkSync(join(root, 'missing'), config); }
      else {
        transcript(OLD);
        if (kind === 'unreadable-projects') chmodSync(join(config, 'projects'), 0o000);
        if (kind === 'unsearchable-project') chmodSync(join(config, 'projects', 'old-project-name'), 0o600);
        if (kind === 'dangling-transcript') {
          const path = join(config, 'projects', 'old-project-name', `${OLD}.jsonl`);
          rmSync(path);
          symlinkSync(join(root, 'missing'), path);
        }
        if (kind === 'wrong-transcript-type') { rmSync(join(config, 'projects', 'old-project-name', `${OLD}.jsonl`)); mkdirSync(join(config, 'projects', 'old-project-name', `${OLD}.jsonl`)); }
      }
      try {
        const { result, calls } = execute(command());
        expect(result.status).toBe(78); expect(result.stderr).toBe('Reverie: Claude transcript metadata unavailable; launch withheld.\n'); expect(calls).toEqual([]);
      } finally {
        if (kind === 'unreadable-projects') chmodSync(join(config, 'projects'), 0o700);
        if (kind === 'unsearchable-project') chmodSync(join(config, 'projects', 'old-project-name'), 0o700);
      }
    });
  }
  it('bounds actual transcript layout traversal and launches nothing on overflow', () => {
    const projects = join(config, 'projects'); mkdirSync(projects);
    for (let i = 0; i < 4100; i++) writeFileSync(join(projects, String(i)), '');
    const { result, calls } = execute(command());
    expect(result.status).toBe(78); expect(calls).toEqual([]);
  });
  it('refuses excess conversation candidates rather than dropping the fresh SID check', () => {
    const { result, calls } = execute(command([OLD, SEED, 'extra-id', SID]));
    expect(result.status).toBe(78); expect(calls).toEqual([]);
  });
  it('selects and executes with a PATH free of Python', () => {
    transcript(OLD);
    const { result, calls } = execute(command());
    expect(result.status).toBe(0); expect(calls).toHaveLength(1);
  });
  it('refuses before launch when the runtime lacks the native selector', () => {
    rmSync(join(root, 'bin', 'reverie-backend'));
    const { result, calls } = execute(command());
    expect(result.status).toBe(78); expect(calls).toEqual([]);
    expect(result.stderr).toBe('Reverie: native Claude transcript selector unavailable; launch withheld.\n');
  });
  it('never times out the provider after selection', () => {
    transcript(OLD);
    const { result, calls } = execute(command(), 143, { FIXTURE_DELAY_MS: '2250' });
    expect(result.status).toBe(143); expect(result.signal).toBeNull();
    expect(calls).toEqual([{ args: ['--resume', OLD], cwd, config }]);
  });
  it('preserves launch failure exit codes without selecting fresh', () => {
    transcript(OLD);
    const provider = join(root, 'bin', 'claude');
    chmodSync(provider, 0o600);
    expect(execute(command()).result.status).toBe(126);
    rmSync(provider);
    expect(execute(command()).result.status).toBe(127);
    expect(existsSync(log)).toBe(false);
  });
});

describe('stock registry integration', () => {
  it('preserves an explicit Docker command leg and its own shell expansion', () => {
    transcript(OLD);
    const ownerCommand = `exec /bin/sh -c 'exec claude --model "$FIXTURE_MODEL" "$@"' shim`;
    const { result, calls } = execute(claudeDockerPaneCommand(ownerCommand, SID, OLD, undefined, true), 143, { FIXTURE_MODEL: 'owned-model' });
    expect(result.status).toBe(143); expect(calls).toEqual([{ args: ['--model', 'owned-model', '--resume', OLD], cwd, config }]);
  });
  it('reproduces the old broad fallback with owned providers and removes its second launch', () => {
    transcript(OLD);
    const entry = getCli('claude')!;
    const options = { mode: 'claude', sessionId: SID, resumeSessionId: OLD, claudeCliVersion: null };
    const legacy = { ...entry, launch: { ...entry.launch, resumeSelection: undefined } };
    const before = execute(buildSpawnCommandFromRegistry(legacy, options)!, 137);
    expect(before.calls.map((row) => row.args.slice(-2))).toEqual([['--resume', OLD], ['--session-id', SID]]);
    rmSync(log);
    const after = execute(buildSpawnCommandFromRegistry(entry, options)!, 137);
    expect(after.result.status).toBe(137); expect(after.calls).toHaveLength(1);
    expect(after.calls[0].args.slice(-2)).toEqual(['--resume', OLD]);
  });
  it('preserves provider flags/model/effort and explicit current account/cwd', () => {
    transcript(OLD); const entry = getCli('claude')!;
    const rendered = buildSpawnCommandFromRegistry(entry, { mode: 'claude', sessionId: SID, resumeSessionId: OLD, claudeMode: 'auto', model: 'claude-sonnet-4-6', effort: 'high', claudeCliVersion: null })!;
    const { result, calls } = execute(rendered, 137);
    expect(result.status).toBe(137); expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ args: ['--permission-mode', 'auto', '--resume', OLD, '--model', 'claude-sonnet-4-6', '--effort', 'high'], cwd, config });
  });
  it('preserves nested settings quotes and shell metacharacters as literal provider argv', () => {
    transcript(OLD);
    const statusLineCommand = `printf '%s' "$FIXTURE_LITERAL"; echo \`false\``;
    const rendered = buildSpawnCommandFromRegistry(getCli('claude')!, { mode: 'claude', sessionId: SID, resumeSessionId: OLD, effort: 'ultracode', statusLineCommand, claudeCliVersion: null })!;
    const { result, calls } = execute(rendered);
    expect(result.status).toBe(0); expect(calls).toHaveLength(1);
    const args = calls[0].args as string[];
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ ultracode: true, statusLine: { type: 'command', command: statusLineCommand } });
  });
  it('passes the ordered internal candidates through the stock renderer', () => {
    transcript(SEED); const entry = getCli('claude')!;
    const rendered = buildSpawnCommandFromRegistry(entry, { mode: 'claude', sessionId: SID, resumeSessionId: OLD, claudeResumeCandidates: [OLD, SEED, SID], claudeCliVersion: null })!;
    expect(execute(rendered).calls[0].args).toContain(SEED);
  });
  it('refuses an unknown profile in registry validation', () => {
    const entry = structuredClone(getCli('claude')!);
    (entry.launch as unknown as Record<string, unknown>).resumeSelection = 'arbitrary-command';
    expect(CliEntrySchema.safeParse(entry).success).toBe(false);
  });
  it('preserves explicitly replaced custom variant arrays and their legacy contract', () => {
    const entry = structuredClone(getCli('claude')!);
    const variants = [{ id: 'custom', args: [{ lit: 'custom-claude' }] }];
    const warnings: string[] = [];
    const { entries } = resolveRegistry([entry], { schemaVersion: 1, clis: { claude: { launch: { variants } } } }, warnings);
    expect(warnings).toEqual([]); expect(entries[0].launch.resumeSelection).toBeUndefined();
    expect(buildSpawnCommandFromRegistry(entries[0], { mode: 'claude', sessionId: SID, claudeCliVersion: null })).toBe('custom-claude');
    expect(entry.launch.resumeSelection).toBe('claude-transcript'); // stock not mutated
  });
});
