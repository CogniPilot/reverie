import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Execute the real selector and shell quoting with a synthetic provider only. */
export function captureClaudeLaunch(command: string, transcriptId?: string): string[] {
  const root = mkdtempSync(join(tmpdir(), 'capture-claude-'));
  try {
    const home = join(root, 'home');
    const config = join(root, 'account');
    const bin = join(root, 'bin');
    const log = join(root, 'calls.jsonl');
    for (const directory of [home, config, bin]) mkdirSync(directory);
    const python = execFileSync('python3', ['-I', '-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8',
    }).trim();
    symlinkSync(python, join(bin, 'python3'));
    const provider = join(bin, 'claude');
    writeFileSync(
      provider,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');`
    );
    chmodSync(provider, 0o700);
    if (transcriptId !== undefined) {
      if (!/^[A-Za-z0-9._-]+$/.test(transcriptId)) throw Error('Invalid synthetic transcript identity');
      const project = join(config, 'projects', 'synthetic-project');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, transcriptId + '.jsonl'), 'synthetic transcript, metadata only');
    }
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: home,
      encoding: 'utf8',
      timeout: 5000,
      env: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: bin, FIXTURE_CALLS: log },
    });
    if (result.error || result.status !== 0 || result.stdout || result.stderr)
      throw Error('Synthetic launch did not complete cleanly');
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    if (calls.length !== 1 || !Array.isArray(calls[0]) || calls[0].some((value) => typeof value !== 'string')) {
      throw Error('Synthetic launch must invoke exactly one provider');
    }
    return calls[0];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
