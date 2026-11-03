/**
 * Reverie's own Codex hooks are trusted at launch by content hash, so a returned seat does not stop on "Hooks need
 * review"; any other or edited handler gets no trust and keeps Codex's prompt. The golden hashes were produced by the
 * real Codex 0.163 app-server (hooks/list currentHash) for the fixture below.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  codexHookHash,
  codexHookTrustArgument,
  reverieCodexHookHashes,
  reverieCodexHookTrust,
} from '../src/codex-hook-trust.js';
import { applyCodexTurnSummaryHooks, generateCodexTurnSummaryHooks } from '../src/hooks-config.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import { getCli } from '../src/config/cli-registry/registry.js';

let dir: string;
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codex-hook-trust-'))); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function writeHooks(root: string, hooks: unknown) {
  await fs.mkdir(join(root, '.codex'), { recursive: true });
  await fs.writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks }, null, 2) + '\n');
}

describe('Codex hook hash', () => {
  it('matches the hashes Codex 0.163 reports for each normalization case', () => {
    expect(codexHookHash('SessionStart', undefined, { type: 'command', command: 'echo start', timeout: 3 }))
      .toBe('sha256:6606ce665e137da2d6c6c01f3dab4407dfa6adde39bbbe9a0727d944f153dd65');
    // Matcher, shell quoting and the default 600 s timeout.
    expect(codexHookHash('PostToolUse', 'Bash', { type: 'command', command: 'echo \'it\'\'s\' "q"' }))
      .toBe('sha256:b3218cc4f9eb32eab4244548526d2a0f281ccedd8cb63e90ae2cc841b8db3232');
    expect(codexHookHash('PostToolUse', 'Bash', { type: 'command', command: 'echo two', async: true, statusMessage: 'Checking…' }))
      .toBe('sha256:05a86e34c84cc5e4099efdcb8cde136511301e20c6f41307268d85d4c01e8fab');
    // A zero timeout is raised to Codex's 1 s minimum.
    expect(codexHookHash('Stop', undefined, { type: 'command', command: 'echo stop', timeout: 0 }))
      .toBe('sha256:3948c5861dd1e074727de37cb8522c8d50c592a839aae2db6f8b7c1db3db2b03');
  });

  it('gives no hash for shapes it does not model, so they are never trusted', () => {
    for (const [event, handler] of [
      ['SessionStart', { type: 'mcp_tool', server: 's', tool: 't' }],
      ['SessionStart', { type: 'command', command: '  ' }],
      ['SessionStart', { type: 'command', command: 'x', commandWindows: 'y' }],
      ['SessionStart', { type: 'command', command: 'x', timeout: -1 }],
      ['SessionEnd', { type: 'command', command: 'x' }],
      ['NotAnEvent', { type: 'command', command: 'x' }],
    ] as const) expect(codexHookHash(event, undefined, handler)).toBeNull();
  });

  it('covers every handler Reverie installs', () => {
    const generated = generateCodexTurnSummaryHooks().hooks;
    const hashes = reverieCodexHookHashes();
    for (const [event, groups] of Object.entries(generated)) {
      expect(hashes.get(event)?.size).toBe((groups as Array<{ hooks: unknown[] }>).reduce((n, g) => n + g.hooks.length, 0));
    }
  });
});

describe('trust for the workspace hooks file', () => {
  it('trusts exactly the Reverie handlers Reverie wrote, keyed as Codex keys hook state', async () => {
    await applyCodexTurnSummaryHooks(dir, true);
    const trust = await reverieCodexHookTrust(dir);
    const file = join(dir, '.codex', 'hooks.json');
    expect(Object.keys(trust).sort()).toEqual([
      `${file}:post_tool_use:0:0`,
      `${file}:session_start:0:0`,
      `${file}:session_start:1:0`,
      `${file}:user_prompt_submit:0:0`,
    ]);
    for (const hash of Object.values(trust)) expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('leaves edited and foreign handlers untrusted, wherever they sit in the file', async () => {
    const ours = generateCodexTurnSummaryHooks().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const edited = structuredClone(ours.PostToolUse![0]!);
    edited.hooks[0]!.command += ' #changed';
    await writeHooks(dir, {
      ...ours,
      // A foreign group ahead of Reverie's shifts its index; the key follows the handler's real position.
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }, ...ours.UserPromptSubmit!],
      PostToolUse: [edited],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
    });
    const keys = Object.keys(await reverieCodexHookTrust(dir)).map((key) => key.slice(key.indexOf(':') + 1)).sort();
    expect(keys).toEqual(['session_start:0:0', 'session_start:1:0', 'user_prompt_submit:1:0']);
  });

  it('also keys the unresolved path when the working directory is a symlink', async () => {
    await applyCodexTurnSummaryHooks(dir, true);
    const link = `${dir}-link`;
    await fs.symlink(dir, link);
    try {
      const keys = Object.keys(await reverieCodexHookTrust(link));
      expect(keys.filter((key) => key.startsWith(`${link}/`))).toHaveLength(4);
      expect(keys.filter((key) => key.startsWith(`${dir}/`))).toHaveLength(4);
    } finally {
      await fs.rm(link);
    }
  });

  it('trusts nothing for a missing, symlinked or malformed hooks file, or a relative path', async () => {
    expect(await reverieCodexHookTrust(dir)).toEqual({});
    const elsewhere = await fs.mkdtemp(join(tmpdir(), 'codex-hook-trust-target-'));
    try {
      await applyCodexTurnSummaryHooks(elsewhere, true);
      await fs.mkdir(join(dir, '.codex'));
      await fs.symlink(join(elsewhere, '.codex', 'hooks.json'), join(dir, '.codex', 'hooks.json'));
      expect(await reverieCodexHookTrust(dir)).toEqual({});
      await fs.rm(join(dir, '.codex', 'hooks.json'));
      await fs.writeFile(join(dir, '.codex', 'hooks.json'), '{ not json');
      expect(await reverieCodexHookTrust(dir)).toEqual({});
      expect(await reverieCodexHookTrust('relative')).toEqual({});
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('launch argument', () => {
  const hash = 'sha256:' + 'a'.repeat(64);

  it('renders one shell-quoted inline hooks.state table', () => {
    const key = `/workspace/a.b/"q" 'single' $HOME/.codex/hooks.json:stop:0:0`;
    const argument = codexHookTrustArgument({ [key]: hash })!;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', `printf '%s' ${argument}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`hooks.state={${JSON.stringify(key)}={trusted_hash="${hash}"}}`);
  });

  it('renders nothing when there is nothing valid to trust', () => {
    expect(codexHookTrustArgument({})).toBeUndefined();
    expect(codexHookTrustArgument({ '/w/.codex/hooks.json:stop:0:0': 'sha256:short' })).toBeUndefined();
    expect(codexHookTrustArgument({ '/w/\n:stop:0:0': hash })).toBeUndefined();
  });

  it('is added to a Codex launch only alongside managed workspace trust', () => {
    const entry = getCli('codex')!;
    const codexHookTrust = codexHookTrustArgument({ '/w/.codex/hooks.json:stop:0:0': hash })!;
    const base = { mode: 'codex', sessionId: '00000000-0000-4000-8000-000000000000', codexHookTrust };
    expect(buildSpawnCommandFromRegistry(entry, { ...base, codexTrustWorkspace: '/w' })).toContain(`--config ${codexHookTrust}`);
    expect(buildSpawnCommandFromRegistry(entry, base)).not.toContain('hooks.state');
  });
});
