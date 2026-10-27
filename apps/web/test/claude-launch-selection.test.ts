import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_METADATA_SELECTOR, renderClaudeLaunch } from '../src/utils/claude-launch.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import { getCli, resolveRegistry } from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { claudeDockerPaneCommand } from '../src/tmux-manager.js';

const SID = '00000008-0008-4000-8000-000000000008';
const OLD = '00000009-0009-4000-8000-000000000009';
const SEED = '00000010-0010-4000-8000-000000000010';
const PYTHON = execFileSync('python3', ['-I', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
let root: string, home: string, config: string, cwd: string, log: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-launch-'));
  home = join(root, 'home'); config = join(root, 'selected account'); cwd = join(root, 'work'); log = join(root, 'calls');
  for (const path of [home, config, cwd, join(root, 'bin')]) mkdirSync(path);
  symlinkSync(PYTHON, join(root, 'bin', 'python3'));
  const provider = join(root, 'provider.cjs');
  writeFileSync(provider, `const fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR})+'\\n');if(process.env.FIXTURE_SIGNAL)process.kill(process.pid,process.env.FIXTURE_SIGNAL);else process.exit(Number(process.env.FIXTURE_EXIT));`);
  const fake = join(root, 'bin', 'claude');
  writeFileSync(fake, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(provider)} "$@"\n`); chmodSync(fake, 0o700);
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
    it(`preserves actual ${signal} outcome without a second provider`, () => {
      transcript(OLD);
      const direct = execute(`exec claude --resume ${quote(OLD)}`, 0, { FIXTURE_SIGNAL: signal });
      rmSync(log);
      const wrapped = execute(command(), 0, { FIXTURE_SIGNAL: signal });
      expect([wrapped.result.status, wrapped.result.signal]).toEqual([direct.result.status, direct.result.signal]);
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
  for (const kind of ['unreadable-projects', 'unsearchable-project', 'dangling-config', 'wrong-transcript-type']) {
    it(`refuses unknown metadata (${kind}) before any provider`, () => {
      if (kind === 'dangling-config') { rmSync(config, { recursive: true }); symlinkSync(join(root, 'missing'), config); }
      else {
        transcript(OLD);
        if (kind === 'unreadable-projects') chmodSync(join(config, 'projects'), 0o000);
        if (kind === 'unsearchable-project') chmodSync(join(config, 'projects', 'old-project-name'), 0o600);
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
  it('uses only the existing isolated Python runtime, with no full Reverie CLI helper', () => {
    transcript(OLD); const { result, calls } = execute(command());
    expect(result.status).toBe(0); expect(calls).toHaveLength(1);
  });
  it('refuses before launch when the runtime has no Python3', () => {
    rmSync(join(root, 'bin', 'python3'));
    const { result, calls } = execute(command());
    expect(result.status).toBe(78); expect(calls).toEqual([]);
    expect(result.stderr).toBe('Reverie: Python3 is required to select the Claude transcript; launch withheld.\n');
  });
  for (const port of ['scandir', 'observe']) {
    it(`keeps injected EIO distinct from proven absence (${port})`, () => {
      transcript(OLD);
      const harness = `import errno,sys\nns={'__name__':'owned_fixture'}\nexec(sys.argv[1],ns)\ndef broken(*a,**kw): raise OSError(errno.EIO,'owned metadata fault')\ntry: ns['_select'](sys.argv[2],[sys.argv[3]],**{sys.argv[4]:broken})\nexcept ns['MetadataUnknown']: print('UNKNOWN');sys.exit(0)\nraise SystemExit('fault was misclassified')\n`;
      const result = spawnSync(PYTHON, ['-I', '-c', harness, CLAUDE_METADATA_SELECTOR, config, OLD, port], { encoding: 'utf8', timeout: 5000, env: { HOME: home, PATH: join(root, 'bin') } });
      expect(result.status).toBe(0); expect(result.stdout).toBe('UNKNOWN\n'); expect(existsSync(log)).toBe(false);
    });
  }
});

describe('selection-only metadata deadline', () => {
  function harness(body: string) {
    return spawnSync(PYTHON, ['-I', '-c', `import sys,json,signal,time,os,stat\nns={'__name__':'owned_fixture'}\nexec(sys.argv[1],ns)\n${body}`, CLAUDE_METADATA_SELECTOR, config, OLD, JSON.stringify({ resumes: [{ id: OLD, command: 'claude --resume ' + OLD }], fresh: 'claude --session-id ' + SID })], {
      cwd, encoding: 'utf8', timeout: 5000,
      env: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: join(root, 'bin'), FIXTURE_LOG: log, FIXTURE_EXIT: '0' },
    });
  }
  it('real two-second guard turns an interruptible stalled scan into exit78 with no provider', () => {
    const result = harness(`original=ns['_select_bounded']\ndef slow(*a,**kw): time.sleep(10)\nns['_select_bounded']=lambda c,ids: original(c,ids,scandir=slow)\nsys.argv=['selector',sys.argv[4]]\nsys.exit(ns['main']())`);
    expect(result.status).toBe(78); expect(result.signal).toBeNull();
    expect(result.stderr).toBe('Reverie: Claude transcript metadata unavailable; launch withheld.\n');
    expect(existsSync(log)).toBe(false);
  });
  it('also refuses elapsed metadata when a callback catches the alarm exception', () => {
    transcript(OLD);
    const result = harness(`original=os.stat\ndef late(path):\n try: time.sleep(1)\n except ns['MetadataUnknown']: pass\n return original(path)\ntry: ns['_select_bounded'](sys.argv[2],[sys.argv[3]],seconds=.03,observe=late)\nexcept ns['MetadataUnknown']: print('UNKNOWN');sys.exit(0)\nraise SystemExit('late result was promoted')`);
    expect(result.status).toBe(0); expect(result.stdout).toBe('UNKNOWN\n'); expect(existsSync(log)).toBe(false);
  });
  for (const outcome of ['present', 'absent', 'timeout', 'error']) {
    it(`disarms its timer and restores an existing handler on ${outcome}`, () => {
      if (outcome === 'present') transcript(OLD);
      const result = harness(`def prior(*a): pass\nsignal.signal(signal.SIGALRM,prior)\ndef port(*a,**kw):\n ${outcome === 'timeout' ? 'time.sleep(1)' : "raise OSError('owned failure')"}\ntry: ns['_select_bounded'](sys.argv[2],[sys.argv[3]],seconds=.03${outcome === 'timeout' || outcome === 'error' ? ',scandir=port' : ''})\nexcept ns['MetadataUnknown']: pass\nassert signal.getitimer(signal.ITIMER_REAL)==(0.,0.)\nassert signal.getsignal(signal.SIGALRM) is prior\nprint('RESTORED')`);
      expect(result.status).toBe(0); expect(result.stdout).toBe('RESTORED\n'); expect(existsSync(log)).toBe(false);
    });
  }
  it('restores signal state before the one exec call, rather than afterward', () => {
    transcript(OLD);
    const result = harness(`def prior(*a): pass\nsignal.signal(signal.SIGALRM,prior)\ndef execvp(*a):\n assert signal.getsignal(signal.SIGALRM) is prior\n assert signal.getitimer(signal.ITIMER_REAL)==(0.,0.)\n print('BEFORE_EXEC');raise SystemExit(73)\nos.execvp=execvp\nsys.argv=['selector',sys.argv[4]]\nsys.exit(ns['main']())`);
    expect(result.status).toBe(73); expect(result.stdout).toBe('BEFORE_EXEC\n'); expect(existsSync(log)).toBe(false);
  });
  it('does not replace an inherited timer or a blocked alarm', () => {
    const result = harness(`signal.setitimer(signal.ITIMER_REAL,10)\ntry:\n try: ns['_select_bounded'](sys.argv[2],[sys.argv[3]])\n except ns['MetadataUnknown']: pass\n else: raise AssertionError('active timer accepted')\n assert 9<signal.getitimer(signal.ITIMER_REAL)[0]<=10\nfinally: signal.setitimer(signal.ITIMER_REAL,0)\nprior=signal.pthread_sigmask(signal.SIG_BLOCK,[signal.SIGALRM])\ntry:\n try: ns['_select_bounded'](sys.argv[2],[sys.argv[3]])\n except ns['MetadataUnknown']: pass\n else: raise AssertionError('blocked alarm accepted')\n assert signal.SIGALRM in signal.pthread_sigmask(signal.SIG_BLOCK,[])\nfinally: signal.pthread_sigmask(signal.SIG_SETMASK,prior)\nprint('PRESERVED')`);
    expect(result.status).toBe(0); expect(result.stdout).toBe('PRESERVED\n'); expect(existsSync(log)).toBe(false);
  });
  it('refuses a runtime without the required POSIX timer without launching', () => {
    const result = harness(`del signal.setitimer\nsys.argv=['selector',sys.argv[4]]\nsys.exit(ns['main']())`);
    expect(result.status).toBe(78); expect(existsSync(log)).toBe(false);
  });
  it('drains an alarm queued at disarm, refuses78 and restores the original mask/handler', () => {
    transcript(OLD);
    const result = harness(`prior_mask=signal.pthread_sigmask(signal.SIG_BLOCK,[])\nprior_handler=signal.getsignal(signal.SIGALRM)\noriginal=signal.setitimer\ndef queued(which,seconds,*args):\n result=original(which,seconds,*args)\n if seconds==0: os.kill(os.getpid(),signal.SIGALRM)\n return result\nsignal.setitimer=queued\nsys.argv=['selector',sys.argv[4]]\ncode=ns['main']()\nassert code==78\nassert signal.SIGALRM not in signal.sigpending()\nassert signal.getsignal(signal.SIGALRM)==prior_handler\nassert signal.pthread_sigmask(signal.SIG_BLOCK,[])==prior_mask\nassert signal.getitimer(signal.ITIMER_REAL)==(0.,0.)\nprint('DRAINED_AND_RESTORED');sys.exit(code)`);
    expect(result.status).toBe(78); expect(result.signal).toBeNull();
    expect(result.stdout).toBe('DRAINED_AND_RESTORED\n'); expect(existsSync(log)).toBe(false);
  });
  it('a pending alarm during metadata is expiry, not a provider signal or fresh-launch choice', () => {
    transcript(OLD);
    const result = harness(`original=os.stat\ndef pending(path):\n signal.pthread_sigmask(signal.SIG_BLOCK,[signal.SIGALRM])\n os.kill(os.getpid(),signal.SIGALRM)\n return original(path)\ntry: ns['_select_bounded'](sys.argv[2],[sys.argv[3]],observe=pending)\nexcept ns['MetadataUnknown']: pass\nelse: raise AssertionError('pending alarm accepted')\nassert signal.SIGALRM not in signal.sigpending()\nassert signal.SIGALRM not in signal.pthread_sigmask(signal.SIG_BLOCK,[])\nprint('UNKNOWN_WITHOUT_PENDING')`);
    expect(result.status).toBe(0); expect(result.stdout).toBe('UNKNOWN_WITHOUT_PENDING\n'); expect(existsSync(log)).toBe(false);
  });
  it('actual exec has no timer and a provider survives beyond the selection deadline', () => {
    transcript(OLD);
    const provider = join(root, 'provider.py');
    writeFileSync(provider, `import os,json,signal,sys,time\nassert signal.getitimer(signal.ITIMER_REAL)==(0.,0.)\nassert signal.SIGALRM not in signal.sigpending()\nassert signal.SIGALRM not in signal.pthread_sigmask(signal.SIG_BLOCK,[])\ntime.sleep(2.25)\nwith open(os.environ['FIXTURE_LOG'],'w') as f: json.dump({'args':sys.argv[1:],'timer':signal.getitimer(signal.ITIMER_REAL)},f)\nsys.exit(143)\n`);
    writeFileSync(join(root, 'bin', 'claude'), `#!/bin/sh\nexec ${quote(PYTHON)} -I ${quote(provider)} "$@"\n`);
    const { result, calls } = execute(command());
    expect(result.status).toBe(143); expect(result.signal).toBeNull();
    expect(calls).toEqual([{ args: ['--resume', OLD], timer: [0, 0] }]);
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
