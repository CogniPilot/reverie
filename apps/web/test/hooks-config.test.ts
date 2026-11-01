/**
 * @fileoverview Tests for hooks config generation
 *
 * Tests the generation of .claude/settings.local.json with Claude Code
 * hook definitions for desktop notifications.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { renderTurnSummary } from '../src/chatroom-turn-summary.js';
import { MEMORY_BRIEF_NO_CLI, MEMORY_BRIEF_UNREADABLE } from '../src/memory-brief.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import { tmpdir, homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  applyCodexTurnSummaryHooks,
  generateCodexTurnSummaryHooks,
  generateTurnSummaryScript,
  generateMemoryBriefScript,
  applyStatusLineConfig,
  ensureReverieHooks,
  ensureStatusLineExporterScript,
  findEffectiveUserStatusLineCommand,
  generateBackgroundWakeScript,
  generateHooksConfig,
  generateStatusLineCommand,
  generateSubagentStopGuardScript,
  readPlanUsageTelemetryEnabled,
  refreshStaleReverieHooks,
  resolveStatusLineCliCommand,
  settingsWriteBlocker,
  stripCaseEnvKeys,
  updateCaseEnvVars,
  updateCaseModel,
  writeHooksConfig,
} from '../src/hooks-config.js';

describe('generateHooksConfig', () => {
  it('should return an object with hooks key', () => {
    const config = generateHooksConfig();
    expect(config).toHaveProperty('hooks');
  });

  it('should have Notification hooks array', () => {
    const config = generateHooksConfig();
    expect(config.hooks.Notification).toBeInstanceOf(Array);
    expect(config.hooks.Notification).toHaveLength(5);
  });

  it('should have Stop hooks array', () => {
    const config = generateHooksConfig();
    expect(config.hooks.Stop).toBeInstanceOf(Array);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('reports the live conversation id on every prompt, with stdout discarded', () => {
    const config = generateHooksConfig();
    expect(config.hooks.UserPromptSubmit).toBeInstanceOf(Array);
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    const command = (config.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command;
    expect(command).toContain('"event":"prompt_submitted"');
    expect(command).toContain('$REVERIE_SESSION_ID');
    // ⚠️ Claude Code injects a UserPromptSubmit hook's stdout into the model's
    // context ("Exit code 0 - stdout shown to Claude"), so without this the API
    // envelope is pasted into the user's own prompt on every turn. Every other
    // event's stdout is harmless (it feeds SSE).
    // ⚠️ Assert curl's OWN flag, not a trailing redirect: the command already
    // ends `… 2>/dev/null || true`, and in `pipeline || true >/dev/null` the
    // shell binds the redirect to `true`, which never runs on the success path.
    // A `endsWith('>/dev/null')` assertion passes on exactly that broken form.
    expect(command).toContain('curl -sk -o /dev/null -X POST');
    expect(command.trimEnd().endsWith('>/dev/null')).toBe(false);
  });

  it("leaves every other hook event's command text byte-identical", () => {
    // The opt-in discard exists so the five SSE-fed events do not change shape:
    // rewriting their command churns every workspace's settings.local.json.
    const config = generateHooksConfig();
    const stop = (config.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command;
    expect(stop).toContain('curl -sk -X POST');
    expect(stop).not.toContain('-o /dev/null');
  });

  it('should guard subagent stops while their background work is active', () => {
    const config = generateHooksConfig();
    const subagentHooks = config.hooks.SubagentStop as Array<{
      hooks: Array<{ type: string; command: string; args: string[]; timeout: number }>;
    }>;

    expect(subagentHooks).toHaveLength(1);
    expect(subagentHooks[0].hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['-e', generateSubagentStopGuardScript()],
    });
  });

  it('should configure a self-contained Bash background-task rewake hook', () => {
    const config = generateHooksConfig();
    const postToolHooks = config.hooks.PostToolUse as Array<{
      matcher: string;
      hooks: Array<{
        type: string;
        command: string;
        args: string[];
        asyncRewake: boolean;
        timeout: number;
      }>;
    }>;

    expect(postToolHooks).toHaveLength(2);
    expect(postToolHooks[1].matcher).toBe('Bash');
    expect(postToolHooks[1].hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      asyncRewake: true,
    });
    expect(postToolHooks[1].hooks[0].args).toEqual(['-e', generateBackgroundWakeScript()]);
    expect(postToolHooks[1].hooks[0].timeout).toBeGreaterThanOrEqual(3600);
  });

  it('should configure idle_prompt matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const idleHook = notifHooks.find((h) => h.matcher === 'idle_prompt');
    expect(idleHook).toBeDefined();
  });

  it('should configure permission_prompt matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const permHook = notifHooks.find((h) => h.matcher === 'permission_prompt');
    expect(permHook).toBeDefined();
  });

  it('should configure elicitation_dialog matcher', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const elicitHook = notifHooks.find((h) => h.matcher === 'elicitation_dialog');
    expect(elicitHook).toBeDefined();
  });

  it('should use env vars in curl commands (not hardcoded URLs)', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('$REVERIE_API_URL');
    expect(cmd).toContain('$REVERIE_SESSION_ID');
    expect(cmd).not.toContain('localhost');
  });

  it('should include || true for silent failure', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    expect(notifHooks[0].hooks[0].command).toContain('|| true');
  });

  // On --https/tailscale installs REVERIE_API_URL is HTTPS with a self-signed cert.
  // A `-k`-less hook curl exits 60 there, the `|| true` swallows it, and every hook
  // event (stop, permission_prompt, elicitation_dialog, idle_prompt, teammate_idle,
  // task_completed) dies silently — killing respawn's idle signals and the wait
  // endpoints' stop/blocked. The statusline exporter always carried -k; the hooks must too.
  it('every hook curl tolerates a self-signed HTTPS API (curl -sk)', () => {
    const serialized = JSON.stringify(generateHooksConfig());
    expect(serialized).toContain('curl -sk -X POST');
    expect(serialized).not.toContain('curl -s -X POST');
  });

  it('should set timeout to 10 seconds (hook timeout fields are seconds)', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ timeout: number }> }>;
    expect(notifHooks[0].hooks[0].timeout).toBe(10);
  });

  it('should include correct event names in curl payloads', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    expect(notifHooks[0].hooks[0].command).toContain('idle_prompt');
    expect(notifHooks[1].hooks[0].command).toContain('permission_prompt');
    expect(notifHooks[2].hooks[0].command).toContain('elicitation_dialog');
    const stopHooks = config.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopHooks[0].hooks[0].command).toContain('stop');
  });

  it('should read stdin and forward as data field', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    // Should capture stdin via cat and include as $HOOK_DATA
    expect(notifHooks[0].hooks[0].command).toContain('HOOK_DATA=$(cat');
    expect(notifHooks[0].hooks[0].command).toContain('$HOOK_DATA');
  });

  it('should set hook type to command', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ type: string }> }>;
    expect(notifHooks[0].hooks[0].type).toBe('command');
    const stopHooks = config.hooks.Stop as Array<{ hooks: Array<{ type: string }> }>;
    expect(stopHooks[0].hooks[0].type).toBe('command');
  });
});

describe('writeHooksConfig', () => {
  const testDir = join(tmpdir(), 'reverie-hooks-test-' + Date.now());

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should create .claude directory if it does not exist', async () => {
    await writeHooksConfig(testDir);
    expect(existsSync(join(testDir, '.claude'))).toBe(true);
  });

  it('should create settings.local.json', async () => {
    await writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('should write valid JSON', async () => {
    await writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const content = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toHaveProperty('hooks');
    expect(parsed.hooks).toHaveProperty('Notification');
    expect(parsed.hooks).toHaveProperty('Stop');
  });

  it('should include hooks config in output', async () => {
    await writeHooksConfig(testDir);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.Notification).toHaveLength(5);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it('refuses to write through a symlinked .claude directory (#251 review)', async () => {
    // Case contents can be foreign (a freshly cloned repository): a symlinked
    // .claude would redirect the scaffold write outside the case.
    const outside = join(testDir, 'outside-target');
    mkdirSync(outside);
    const caseDir = join(testDir, 'case');
    mkdirSync(caseDir);
    symlinkSync(outside, join(caseDir, '.claude'));
    expect(await settingsWriteBlocker(caseDir)).toMatch(/symlink/);
    await writeHooksConfig(caseDir);
    expect(existsSync(join(outside, 'settings.local.json'))).toBe(false);
  });

  it('refuses to write through a symlinked settings.local.json (#251 review)', async () => {
    const outsideFile = join(testDir, 'victim-settings.json');
    writeFileSync(outsideFile, '{"model":"precious"}\n');
    const caseDir = join(testDir, 'case2');
    mkdirSync(join(caseDir, '.claude'), { recursive: true });
    symlinkSync(outsideFile, join(caseDir, '.claude', 'settings.local.json'));
    expect(await settingsWriteBlocker(caseDir)).toMatch(/symlink/);
    await writeHooksConfig(caseDir);
    // The link target is untouched: no hooks were merged into it.
    expect(readFileSync(outsideFile, 'utf-8')).toBe('{"model":"precious"}\n');
  });

  it('reports a real, confined .claude as safe', async () => {
    const caseDir = join(testDir, 'case3');
    mkdirSync(join(caseDir, '.claude'), { recursive: true });
    expect(await settingsWriteBlocker(caseDir)).toBeNull();
  });

  it('EVERY settings writer refuses a symlinked settings.local.json (#251 review round 2)', async () => {
    // Round 1 guarded only writeHooksConfig/updateCaseModel; the reviewer
    // demonstrated applyStatusLineConfig writing through the link. All
    // writers now share one safe-write gate, so pin all of them at once.
    const outsideFile = join(testDir, 'victim-all-writers.json');
    const precious =
      '{"env":{"CLAUDE_CODE_KEEP":"me"},"hooks":{"Stop":[{"hooks":[{"command":"curl /api/hook-event"}]}]}}\n';
    writeFileSync(outsideFile, precious);
    const caseDir = join(testDir, 'case-writers');
    mkdirSync(join(caseDir, '.claude'), { recursive: true });
    symlinkSync(outsideFile, join(caseDir, '.claude', 'settings.local.json'));

    await writeHooksConfig(caseDir);
    await ensureReverieHooks(caseDir);
    await refreshStaleReverieHooks(caseDir);
    await updateCaseModel(caseDir, 'opus');
    await updateCaseEnvVars(caseDir, { CLAUDE_CODE_NEW: 'value' });
    await stripCaseEnvKeys(caseDir, ['CLAUDE_CODE_KEEP']);
    await applyStatusLineConfig(caseDir, true);
    await applyStatusLineConfig(caseDir, false);

    // The link target is byte-identical: none of the writers went through it.
    expect(readFileSync(outsideFile, 'utf-8')).toBe(precious);
  });

  it('should merge with existing settings.local.json', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ existingKey: 'existingValue', permissions: { allow: ['Read'] } }, null, 2)
    );

    await writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.existingKey).toBe('existingValue');
    expect(parsed.permissions).toEqual({ allow: ['Read'] });
    expect(parsed.hooks).toBeDefined();
  });

  it('should upgrade Reverie-owned hooks that predate background rewake', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const oldHooks = generateHooksConfig().hooks;
    delete oldHooks.PostToolUse;
    writeFileSync(settingsPath, JSON.stringify({ hooks: oldHooks }, null, 2));

    await refreshStaleReverieHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(JSON.stringify(parsed.hooks.PostToolUse)).toContain('REVERIE_BACKGROUND_REWAKE_V3');
    expect(JSON.stringify(parsed.hooks.SubagentStop)).toContain('REVERIE_SUBAGENT_STOP_GUARD_V1');
  });

  it('should replace an older rewake script version without duplicating it', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    // Simulate a case healed by the previous release: current curls (secret present)
    // plus a V1 rewake handler. The version bump must swap the handler in place.
    const hooks = generateHooksConfig().hooks;
    hooks.PostToolUse = [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: 'node',
            args: ['-e', 'const REVERIE_BACKGROUND_REWAKE_V1 = true; process.exit(0);'],
            asyncRewake: true,
            timeout: 21600,
          },
        ],
      },
    ];
    writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));

    await refreshStaleReverieHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const serialized = JSON.stringify(parsed.hooks.PostToolUse);
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(parsed.hooks.PostToolUse[0].hooks).toHaveLength(1);
    expect(serialized).toContain('REVERIE_BACKGROUND_REWAKE_V3');
    expect(serialized).not.toContain('REVERIE_BACKGROUND_REWAKE_V1');
  });

  it('reports a context compaction start (PreCompact) and end (SessionStart compact), stdout discarded', () => {
    const hooks = generateHooksConfig().hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    const start = hooks.PreCompact[0].hooks[0].command;
    expect(start).toContain('compact_started');
    expect(start).toContain('-o /dev/null');
    const end = hooks.SessionStart.find((entry) => entry.matcher === 'compact')!.hooks[0].command;
    expect(end).toContain('compact_finished');
    expect(end).toContain('-o /dev/null');
  });

  it('heals a hooks block written before compaction reporting existed, once', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const oldHooks = generateHooksConfig().hooks as Record<string, unknown[]>;
    delete oldHooks.PreCompact;
    oldHooks.SessionStart = oldHooks.SessionStart.slice(0, 1);
    writeFileSync(settingsPath, JSON.stringify({ hooks: oldHooks }, null, 2));
    await refreshStaleReverieHooks(testDir);
    const healed = readFileSync(settingsPath, 'utf-8');
    expect(healed).toContain('compact_started');
    expect(healed).toContain('compact_finished');
    await refreshStaleReverieHooks(testDir);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(healed); // current hooks are not rewritten again
  });

  it('heals a hooks block written before UserPromptSubmit existed', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    // An otherwise-current block from the previous release: the pane would keep
    // guessing its conversation from ~/.claude/history.jsonl forever.
    const hooks = generateHooksConfig().hooks;
    delete hooks.UserPromptSubmit;
    writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));

    await refreshStaleReverieHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(JSON.stringify(parsed.hooks.UserPromptSubmit)).toContain('prompt_submitted');
  });

  it('leaves an already-current hooks block untouched', async () => {
    // ⚠️ The staleness gate reads a JSON.stringify'd blob, so a marker written
    // with surrounding quotes never matches and the gate is permanently false —
    // which rewrites every workspace's settings.local.json on every Claude
    // spawn instead of never. This asserts the no-op, which is the property a
    // quoted needle silently breaks.
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: generateHooksConfig().hooks }, null, 2));
    const before = readFileSync(settingsPath, 'utf-8');

    await refreshStaleReverieHooks(testDir);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  it('replaces the V2 background hook without duplicating it', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const oldSettings = JSON.stringify({ hooks: generateHooksConfig().hooks }, null, 2).replaceAll(
      'REVERIE_BACKGROUND_REWAKE_V3',
      'REVERIE_BACKGROUND_REWAKE_V2'
    );
    writeFileSync(settingsPath, oldSettings);

    await refreshStaleReverieHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const postToolUse = JSON.stringify(parsed.hooks.PostToolUse);
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(postToolUse).toContain('REVERIE_BACKGROUND_REWAKE_V3');
    expect(postToolUse).not.toContain('REVERIE_BACKGROUND_REWAKE_V2');
  });

  it('should not add rewake hooks to a user-owned hook configuration', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const userHooks = {
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: './format.sh' }],
        },
      ],
    };
    writeFileSync(settingsPath, JSON.stringify({ hooks: userHooks }, null, 2));

    await refreshStaleReverieHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.hooks).toEqual(userHooks);
  });

  it('should preserve user hook events while installing Reverie hooks', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({ hooks: { oldHook: [] } }, null, 2));

    await writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.hooks.oldHook).toEqual([]);
    expect(parsed.hooks.Notification).toBeDefined();
  });

  it('should safely add Reverie hooks to an existing managed-case settings file', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    const userHooks = {
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: './format.sh' }] }],
    };
    writeFileSync(settingsPath, JSON.stringify({ hooks: userHooks, permissions: { allow: ['Read'] } }, null, 2));

    await ensureReverieHooks(testDir);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.permissions).toEqual({ allow: ['Read'] });
    expect(parsed.hooks.PostToolUse).toEqual(expect.arrayContaining(userHooks.PostToolUse));
    expect(JSON.stringify(parsed.hooks)).toContain('REVERIE_BACKGROUND_REWAKE_V3');
    expect(JSON.stringify(parsed.hooks)).toContain('REVERIE_SUBAGENT_STOP_GUARD_V1');
  });

  it('should not replace a malformed managed-case settings file', async () => {
    const claudeDir = join(testDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, '{ malformed');

    await ensureReverieHooks(testDir);

    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ malformed');
  });

  it('should handle malformed existing settings.local.json', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), 'not valid json{{{');

    await writeHooksConfig(testDir);

    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.hooks).toBeDefined();
  });

  it('should end file with newline', async () => {
    await writeHooksConfig(testDir);
    const content = readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('background task rewake helper', () => {
  const testDir = join(tmpdir(), 'reverie-background-rewake-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runHelper(input: Record<string, unknown>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', generateBackgroundWakeScript()], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('background rewake helper timed out'));
      }, 5000);

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stderr });
      });
      child.stdin.end(JSON.stringify(input));
    });
  }

  it('exits without waiting for an ordinary Bash result', async () => {
    const result = await runHelper({
      transcript_path: join(testDir, 'transcript.jsonl'),
      tool_response: { stdout: 'ordinary command completed' },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 2 when the matching background command completes', async () => {
    const transcriptPath = join(testDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, '');

    const resultPromise = runHelper({
      transcript_path: transcriptPath,
      tool_response: {
        stdout: 'Command running in background with ID: bg-test-1. Output is being written to: /tmp/bg-test-1.output.',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>bg-test-1</task-id>\n<status>completed</status>\n' +
          '<output-file>/tmp/bg-test-1.output</output-file>\n</task-notification>',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('bg-test-1');
    expect(result.stderr).toContain('completed');
    expect(result.stderr).toContain('/tmp/bg-test-1.output');
  });

  it('rewakes a subagent when Claude queues completion in the parent transcript', async () => {
    const sessionId = '0000001f-0025-4000-8000-000000000031';
    const sessionDir = join(testDir, sessionId);
    const subagentDir = join(sessionDir, 'subagents');
    const parentTranscriptPath = `${sessionDir}.jsonl`;
    const subagentTranscriptPath = join(subagentDir, 'agent-afacts-class2.jsonl');
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(parentTranscriptPath, '');
    writeFileSync(subagentTranscriptPath, '');

    const resultPromise = runHelper({
      session_id: sessionId,
      agent_id: 'afacts-class2',
      transcript_path: subagentTranscriptPath,
      tool_response: {
        backgroundTaskId: 'bg-subagent-1',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      parentTranscriptPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>bg-subagent-1</task-id>\n<status>completed</status>\n' +
          '<output-file>/tmp/bg-subagent-1.output</output-file>\n</task-notification>',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('bg-subagent-1');
    expect(result.stderr).toContain('/tmp/bg-subagent-1.output');
  });

  it('includes a marked background report in the wake feedback', async () => {
    const transcriptPath = join(testDir, 'transcript.jsonl');
    const tasksDir = join(testDir, 'tasks');
    const outputPath = join(tasksDir, 'bg-report-1.output');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(transcriptPath, '');
    writeFileSync(
      outputPath,
      [
        'launcher output',
        '=== REVERIE_RESULT_BEGIN ===',
        'Summary line',
        'Detail after the old 30-line preview boundary',
        '=== REVERIE_RESULT_END ===',
      ].join('\n')
    );

    const resultPromise = runHelper({
      transcript_path: transcriptPath,
      tool_response: {
        stdout: `Command running in background with ID: bg-report-1. Output is being written to: ${outputPath}.`,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>bg-report-1</task-id>\n<status>completed</status>\n' +
          `<output-file>${outputPath}</output-file>\n</task-notification>`,
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('<reverie-background-result>');
    expect(result.stderr).toContain('Summary line');
    expect(result.stderr).toContain('Detail after the old 30-line preview boundary');
  });
});

describe('subagent stop guard helper', () => {
  const testDir = join(tmpdir(), 'reverie-subagent-stop-guard-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runGuard(transcriptLines: unknown[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const transcriptPath = join(testDir, 'agent-test.jsonl');
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', generateSubagentStopGuardScript()], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ agent_transcript_path: transcriptPath }));
    });
  }

  async function withLiveTask<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const tasksDir = join(testDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const outputFd = openSync(join(tasksDir, `${taskId}.output`), 'a');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: ['ignore', outputFd, outputFd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    closeSync(outputFd);

    try {
      return await action();
    } finally {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill();
      await closed;
    }
  }

  const monitorResult = (taskId: string) => ({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          content: `Monitor started (task ${taskId}, pid 123).`,
        },
      ],
    },
  });

  const completion = (taskId: string) => ({
    type: 'user',
    message: {
      content:
        `<task-notification>\n<task-id>${taskId}</task-id>\n` + '<status>completed</status>\n</task-notification>',
    },
  });

  it('blocks an intermediate subagent stop while a sibling monitor is active', async () => {
    const result = await withLiveTask('monitor-still-live', () =>
      runGuard([monitorResult('monitor-first'), monitorResult('monitor-still-live'), completion('monitor-first')])
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' });
    expect(result.stdout).toContain('monitor-still-live');
    expect(result.stdout).not.toContain('monitor-first,');
  });

  it('allows a subagent to stop after all of its monitored work finishes', async () => {
    const result = await runGuard([
      monitorResult('monitor-first'),
      monitorResult('monitor-second'),
      completion('monitor-first'),
      completion('monitor-second'),
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('also recognizes background Bash task ownership', async () => {
    const result = await withLiveTask('bash-live-1', () =>
      runGuard([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                content: 'Command running in background with ID: bash-live-1. Output is being written to a task file.',
              },
            ],
          },
        },
      ])
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' });
    expect(result.stdout).toContain('bash-live-1');
  });
});

// ========== Hook Event API Integration Tests ==========
// Hooks integration tests use an ephemeral port

import { WebServer } from '../src/web/server.js';

describe('Hook Event API', () => {
  let server: WebServer;
  let baseUrl: string;
  let testSessionId: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;

    // Create a test session
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createData = await createRes.json();
    testSessionId = createData.data.session.id;
  });

  afterAll(async () => {
    // Clean up the test session
    if (testSessionId) {
      await fetch(`${baseUrl}/api/sessions/${testSessionId}`, {
        method: 'DELETE',
      });
    }
    await server.stop();
  }, 60000);

  describe('Valid Hook Events', () => {
    it('should accept idle_prompt event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'idle_prompt',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept permission_prompt event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'permission_prompt',
          sessionId: testSessionId,
          data: { tool_name: 'Bash' },
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept elicitation_dialog event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'elicitation_dialog',
          sessionId: testSessionId,
          data: { question: 'What is your name?' },
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept stop event', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'stop',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept event with tool_input data', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'permission_prompt',
          sessionId: testSessionId,
          data: {
            tool_name: 'Bash',
            tool_input: {
              command: 'ls -la',
              description: 'List files',
            },
          },
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('Invalid Hook Events', () => {
    it('should reject invalid event types', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'invalid_event',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });

    it('should reject missing event field', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });

    it('should reject empty event field', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: '',
          sessionId: testSessionId,
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });

    it('should reject non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'idle_prompt',
          sessionId: 'fake-session-id-12345',
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('NOT_FOUND');
    });

    it('should reject missing sessionId', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'idle_prompt',
        }),
      });
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.errorCode).toBe('INVALID_INPUT');
    });
  });
});

describe('Hook Data Sanitization', () => {
  let server: WebServer;
  let baseUrl: string;
  let testSessionId: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;

    // Create a test session
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createData = await createRes.json();
    testSessionId = createData.data.session.id;
  });

  afterAll(async () => {
    if (testSessionId) {
      await fetch(`${baseUrl}/api/sessions/${testSessionId}`, {
        method: 'DELETE',
      });
    }
    await server.stop();
  }, 60000);

  it('should truncate long command in tool_input (verified via API)', async () => {
    const longCommand = 'a'.repeat(1000);

    // The sanitizeHookData function truncates command to 500 chars.
    // We verify by checking that the API accepts it (the truncation happens
    // server-side before broadcast). To fully verify truncation, we'd need
    // to inspect the SSE output, but SSE testing in Node.js requires more setup.
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Bash',
          tool_input: { command: longCommand },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate long file_path in tool_input', async () => {
    const longPath = '/path/' + 'a'.repeat(1000);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Read',
          tool_input: { file_path: longPath },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should only allow safe fields through', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Bash',
          secret_field: 'should-be-stripped',
          malicious_data: { nested: 'value' },
          hook_event_name: 'permission_prompt',
          cwd: '/home/user/project',
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should handle empty data gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'idle_prompt',
        sessionId: testSessionId,
        data: {},
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should handle null data gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'idle_prompt',
        sessionId: testSessionId,
        data: null,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should handle undefined data gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'stop',
        sessionId: testSessionId,
        // data field omitted
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate description field to 200 chars', async () => {
    const longDescription = 'x'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Edit',
          tool_input: { description: longDescription },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate query field to 200 chars', async () => {
    const longQuery = 'q'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Grep',
          tool_input: { query: longQuery },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate url field to 500 chars', async () => {
    const longUrl = 'https://example.com/' + 'u'.repeat(1000);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'WebFetch',
          tool_input: { url: longUrl },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate pattern field to 200 chars', async () => {
    const longPattern = 'p'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Grep',
          tool_input: { pattern: longPattern },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('should truncate prompt field to 200 chars', async () => {
    const longPrompt = 'm'.repeat(500);

    const res = await fetch(`${baseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId: testSessionId,
        data: {
          tool_name: 'Task',
          tool_input: { prompt: longPrompt },
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

describe('Hook Config Generation - Extended', () => {
  it('should generate valid JSON structure', () => {
    const config = generateHooksConfig();
    expect(config.hooks).toBeDefined();
    expect(config.hooks.Notification).toHaveLength(5);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('should include all event types', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher?: string }>;
    const matchers = notifHooks.map((n) => n.matcher);
    expect(matchers).toContain('idle_prompt');
    expect(matchers).toContain('permission_prompt');
    expect(matchers).toContain('elicitation_dialog');
    // Approvals Inbox resolution signals (dialog answered in the terminal).
    expect(matchers).toContain('elicitation_complete');
    expect(matchers).toContain('elicitation_response');
  });

  it('should use environment variable placeholders', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('$REVERIE_API_URL');
    expect(cmd).toContain('$REVERIE_SESSION_ID');
  });

  it('should generate POST curl commands', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('curl');
    expect(cmd).toContain('-X POST');
    expect(cmd).toContain('Content-Type: application/json');
  });

  it('should forward event name in curl payload', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ matcher: string; hooks: Array<{ command: string }> }>;

    for (const hook of notifHooks) {
      const cmd = hook.hooks[0].command;
      // The printf format string contains the event name baked in
      expect(cmd).toContain(`"event":"${hook.matcher}"`);
    }
  });

  it('should use 2>/dev/null for curl errors', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('2>/dev/null');
  });

  it('should handle stdin capture for hook data', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    expect(cmd).toContain('HOOK_DATA=$(cat');
    // Data is piped to curl via stdin (--data @-) to prevent shell injection
    expect(cmd).toContain('$HOOK_DATA');
    expect(cmd).toContain('--data @-');
  });

  it('should have consistent structure across all notification hooks', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string; timeout: number }>;
    }>;

    for (const hook of notifHooks) {
      expect(hook.matcher).toBeDefined();
      expect(hook.hooks).toHaveLength(1);
      expect(hook.hooks[0].type).toBe('command');
      expect(hook.hooks[0].timeout).toBe(10);
      expect(hook.hooks[0].command).toBeTruthy();
    }
  });

  it('should pipe data to curl via stdin to prevent shell injection', () => {
    const config = generateHooksConfig();
    const notifHooks = config.hooks.Notification as Array<{ hooks: Array<{ command: string }> }>;
    const cmd = notifHooks[0].hooks[0].command;
    // HOOK_DATA must NOT be embedded unquoted in a -d "..." argument (shell injection vector)
    expect(cmd).not.toMatch(/-d\s+"[^"]*\$HOOK_DATA/);
    // Instead, data should be piped to curl via stdin
    expect(cmd).toContain('printf');
    expect(cmd).toContain('| curl');
    expect(cmd).toContain('--data @-');
  });

  it('should have stop hook without matcher (catches all)', () => {
    const config = generateHooksConfig();
    const stopHooks = config.hooks.Stop as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;

    expect(stopHooks).toHaveLength(1);
    expect(stopHooks[0].matcher).toBeUndefined();
    expect(stopHooks[0].hooks[0].command).toContain('stop');
  });
});

describe('readPlanUsageTelemetryEnabled', () => {
  const backup = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, 'utf-8') : null;

  afterEach(() => {
    if (backup !== null) {
      writeFileSync(SETTINGS_PATH, backup);
    } else {
      rmSync(SETTINGS_PATH, { force: true });
    }
  });

  it('reads true fresh from the persisted showPlanUsageLimits setting', async () => {
    mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ showPlanUsageLimits: true }));
    expect(await readPlanUsageTelemetryEnabled()).toBe(true);
  });

  it('reads false when the setting is explicitly false', async () => {
    mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ showPlanUsageLimits: false }));
    expect(await readPlanUsageTelemetryEnabled()).toBe(false);
  });

  it('defaults to true when the setting is absent or the file is missing (mirrors readWorkspaceHooksEnabled)', async () => {
    // The desktop chip shows as ON for an install that never touched the
    // setting, so collection must agree with it. Resolving the default HERE
    // is what keeps GET /api/settings a plain read (see its route test).
    rmSync(SETTINGS_PATH, { force: true });
    expect(await readPlanUsageTelemetryEnabled()).toBe(true);

    mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ someOtherSetting: true }));
    expect(await readPlanUsageTelemetryEnabled()).toBe(true);
  });

  it('only an explicit false turns collection off; junk values read as on', async () => {
    mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ showPlanUsageLimits: 'no' }));
    expect(await readPlanUsageTelemetryEnabled()).toBe(true);
  });

  it('never caches — a change on disk is visible on the very next call', async () => {
    mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ showPlanUsageLimits: false }));
    expect(await readPlanUsageTelemetryEnabled()).toBe(false);

    writeFileSync(SETTINGS_PATH, JSON.stringify({ showPlanUsageLimits: true }));
    expect(await readPlanUsageTelemetryEnabled()).toBe(true);
  });
});

describe('resolveStatusLineCliCommand', () => {
  const testDir = join(tmpdir(), 'reverie-statusline-cli-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns undefined when telemetry was not requested', async () => {
    expect(await resolveStatusLineCliCommand(testDir, false)).toBeUndefined();
  });

  it('returns a bare exporter SCRIPT PATH (never the inline command) when requested', async () => {
    // A bare path has no `$`, quotes, or pipes for any intermediate shell
    // layer to mangle — see ensureStatusLineExporterScript's doc comment for
    // the real bug this guards against.
    const cmd = await resolveStatusLineCliCommand(testDir, true);
    expect(cmd).toBeDefined();
    expect(cmd).not.toContain('$');
    expect(cmd).not.toContain("'");
    expect(cmd).toMatch(/^\/.*statusline-exporter\.sh$/);
    expect(existsSync(cmd!)).toBe(true);
    const stat = statSync(cmd!);
    expect(stat.mode & 0o111).not.toBe(0); // executable
    expect(readFileSync(cmd!, 'utf-8')).toContain('REVERIE_STATUSLINE_EXPORTER_V');
  });

  it('refreshes a stale exporter script atomically: executable on arrival, no temp file left behind', async () => {
    const scriptPath = (await resolveStatusLineCliCommand(testDir, true))!;
    // Simulate a script an older build wrote (different marker suffix).
    writeFileSync(scriptPath, '#!/bin/sh\n# REVERIE_STATUSLINE_EXPORTER_V0\necho stale\n');
    chmodSync(scriptPath, 0o644);

    const again = await resolveStatusLineCliCommand(testDir, true);
    expect(again).toBe(scriptPath);
    expect(readFileSync(scriptPath, 'utf-8')).not.toContain('echo stale');
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
    const siblings = readdirSync(join(scriptPath, '..')).filter((f) => f.startsWith('statusline-exporter.sh.'));
    expect(siblings).toEqual([]);
  });

  it('survives concurrent refreshes in the same millisecond (sessions created at once)', async () => {
    const scriptPath = (await resolveStatusLineCliCommand(testDir, true))!;
    writeFileSync(scriptPath, '#!/bin/sh\n# REVERIE_STATUSLINE_EXPORTER_V0\necho stale\n');
    // A frozen clock makes every writer agree on the timestamp, which is what two
    // session creates in one millisecond do. A temp name built from pid + Date.now()
    // is then shared: the first rename consumes it, every later rename fails ENOENT,
    // and that session's tmux create fell back to a direct PTY.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const paths = await Promise.all(Array.from({ length: 8 }, () => ensureStatusLineExporterScript()));
      expect(new Set(paths)).toEqual(new Set([scriptPath]));
    } finally {
      clock.mockRestore();
    }
    expect(readFileSync(scriptPath, 'utf-8')).not.toContain('echo stale');
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
    const siblings = readdirSync(join(scriptPath, '..')).filter((f) => f.startsWith('statusline-exporter.sh.'));
    expect(siblings).toEqual([]);
  });

  it('never overrides a real, hand-authored statusLine', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo my-own-prompt' } }, null, 2)
    );

    expect(await resolveStatusLineCliCommand(testDir, true)).toBeUndefined();

    // The user's own config is untouched — this is a read-only decision, not a write.
    const parsed = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(parsed.statusLine.command).toBe('echo my-own-prompt');
  });

  it('self-heals: strips a legacy disk-written exporter from an older Reverie build', async () => {
    // Simulate a workspace touched by the pre-fix applyStatusLineConfig(dir, true).
    await applyStatusLineConfig(testDir, true);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeDefined();

    const cmd = await resolveStatusLineCliCommand(testDir, true);

    // Cleaned off disk...
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeUndefined();
    // ...and telemetry still flows, via the ephemeral CLI flag instead.
    expect(cmd).toMatch(/statusline-exporter\.sh$/);
  });

  it('does not resurrect the legacy exporter when telemetry is off during cleanup', async () => {
    await applyStatusLineConfig(testDir, true);
    const settingsPath = join(testDir, '.claude', 'settings.local.json');

    const cmd = await resolveStatusLineCliCommand(testDir, false);

    expect(cmd).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeUndefined();
  });
});

describe('statusline exporter script (real shell execution)', () => {
  const testDir = join(tmpdir(), 'reverie-statusline-script-exec-test-' + Date.now());
  const binDir = join(tmpdir(), 'reverie-statusline-script-exec-bin-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  // A stand-in for the real `curl` binary, placed FIRST on PATH — same technique
  // the exporter's own review used ("an arg-echoing stand-in"). It ignores every
  // arg curl would have received; only its own scripted behavior matters here.
  function writeFakeCurl(script: string): void {
    const curlPath = join(binDir, 'curl');
    writeFileSync(curlPath, `#!/bin/sh\n${script}\n`);
    chmodSync(curlPath, 0o755);
  }

  function runExporter(
    env: Record<string, string>
  ): Promise<{ code: number | null; stdout: string; durationMs: number }> {
    return resolveStatusLineCliCommand(testDir, true).then(
      (scriptPath) =>
        new Promise((resolve, reject) => {
          const start = Date.now();
          const child = spawn('sh', [scriptPath!], {
            env: { ...env, PATH: `${binDir}:${process.env.PATH}` },
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          let stdout = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stdout, durationMs: Date.now() - start }));
          child.stdin.end('{}');
        })
    );
  }

  const baseEnv = {
    REVERIE_SESSION_ID: 'x',
    REVERIE_API_URL: 'http://127.0.0.1:1',
    REVERIE_HOOK_SECRET_FILE: '/dev/null',
  };

  it('no-user-statusline branch: the POST runs in the foreground and its OWN stdout becomes the footer', async () => {
    writeFakeCurl(`echo 'model: opus | 42% used'`);
    const result = await runExporter(baseEnv);
    expect(result.stdout.trim()).toBe('model: opus | 42% used');
  });

  it('no-user-statusline branch: prints NOTHING when curl fails (never a bare brand word)', async () => {
    writeFakeCurl(`exit 1`);
    const result = await runExporter(baseEnv);
    expect(result.stdout).toBe('');
    expect(result.code).toBe(0);
  });

  it('asks curl to fail on HTTP errors (-f) so an error body never becomes the footer', async () => {
    const scriptPath = await resolveStatusLineCliCommand(testDir, true);
    expect(readFileSync(scriptPath!, 'utf-8')).toContain('curl -sfk');
    expect(readFileSync(scriptPath!, 'utf-8')).not.toContain('echo reverie');
  });

  it('wrap branch: never blocks a reader-to-EOF on a slow/hung curl (background subshell closes stdin too)', async () => {
    writeFakeCurl(`sleep 3`);
    const result = await runExporter({ ...baseEnv, REVERIE_USER_STATUSLINE_CMD: 'echo my-own-statusline' });
    expect(result.stdout.trim()).toBe('my-own-statusline');
    expect(result.durationMs).toBeLessThan(1000);
  }, 10000);

  it('curl is bounded with --max-time so a HUNG (not just refused) Reverie cannot wedge the render', async () => {
    const scriptPath = await resolveStatusLineCliCommand(testDir, true);
    expect(readFileSync(scriptPath!, 'utf-8')).toContain('--max-time');
  });
});

describe('findEffectiveUserStatusLineCommand', () => {
  const testDir = join(tmpdir(), 'reverie-statusline-precedence-test-' + Date.now());
  const userSettingsPath = join(homedir(), '.claude', 'settings.json');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(userSettingsPath, { force: true }); // don't leak into other tests sharing this HOME
  });

  it('returns undefined when nothing is configured anywhere', async () => {
    expect(await findEffectiveUserStatusLineCommand(testDir)).toBeUndefined();
  });

  it('finds the user global ~/.claude/settings.json when nothing else is set', async () => {
    const userClaudeDir = join(homedir(), '.claude');
    mkdirSync(userClaudeDir, { recursive: true });
    writeFileSync(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo user-global' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo user-global');
  });

  it('project-SHARED settings.json wins over user-global', async () => {
    const userClaudeDir = join(homedir(), '.claude');
    mkdirSync(userClaudeDir, { recursive: true });
    writeFileSync(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo user-global' } })
    );
    const projectClaudeDir = join(testDir, '.claude');
    mkdirSync(projectClaudeDir, { recursive: true });
    writeFileSync(
      join(projectClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-shared' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo project-shared');
  });

  it('project-LOCAL settings.local.json wins over everything', async () => {
    const projectClaudeDir = join(testDir, '.claude');
    mkdirSync(projectClaudeDir, { recursive: true });
    writeFileSync(
      join(projectClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-shared' } })
    );
    writeFileSync(
      join(projectClaudeDir, 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-local' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo project-local');
  });

  it('skips a legacy Reverie-marked entry in project settings.local.json and falls through', async () => {
    await applyStatusLineConfig(testDir, true); // simulates a pre-fix disk-written exporter
    const projectClaudeDir = join(testDir, '.claude');
    writeFileSync(
      join(projectClaudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo project-shared' } })
    );

    expect(await findEffectiveUserStatusLineCommand(testDir)).toBe('echo project-shared');
  });
});

describe('per-turn message summary hooks', () => {
  it('registers startup, prompt and every tool continuation for both harnesses', () => {
    for (const config of [generateHooksConfig(), generateCodexTurnSummaryHooks()]) {
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
        const entries = config.hooks[event] as Array<{
          matcher?: string;
          hooks: Array<{ command: string; timeout: number }>;
        }>;
        const entry = entries.find((item) =>
          item.hooks.some((hook) => hook.command.includes('REVERIE_TURN_SUMMARY_V2'))
        )!;
        expect(entry).toBeDefined();
        expect(entry.matcher).toBeUndefined();
        const handler = entry.hooks.find((hook) => hook.command.includes('REVERIE_TURN_SUMMARY_V2'))!;
        expect(handler.timeout).toBe(3);
        expect(handler.command).toContain(event);
      }
    }
  });

  it('starts every session with the memory brief as its own bounded handler, before the summary, in both harnesses', () => {
    for (const config of [generateHooksConfig(), generateCodexTurnSummaryHooks()]) {
      const handlers = (config.hooks.SessionStart as Array<{ hooks: Array<{ command: string; timeout: number }> }>).flatMap((e) => e.hooks);
      const brief = handlers.findIndex((h) => h.command.includes('REVERIE_MEMORY_BRIEF_V2'));
      const summary = handlers.findIndex((h) => h.command.includes('REVERIE_TURN_SUMMARY_V2'));
      expect(brief).toBeGreaterThanOrEqual(0);
      expect(brief).toBeLessThan(summary);
      expect(handlers[brief].timeout).toBe(3);
      for (const event of ['UserPromptSubmit', 'PostToolUse'])
        expect(JSON.stringify(config.hooks[event])).not.toContain('REVERIE_MEMORY_BRIEF');
    }
    const script = generateMemoryBriefScript();
    expect(script).toContain("['agent', 'journal', 'brief', '--hook-event', 'SessionStart']");
    expect(script).toContain('timeout: 2500');
    expect(script).toContain('text.length > 2000');
  });

  it('bounds the helper and emits only validated context, with no hook-event API envelope', () => {
    const script = generateTurnSummaryScript('PostToolUse');
    expect(script).toContain('timeout: 2500');
    expect(script).toContain('maxBuffer: 32768');
    expect(script).toContain("killSignal: 'SIGKILL'");
    expect(script).toContain("'--hook-event', 'PostToolUse'");
    expect(script).toContain('hookSpecificOutput');
    expect(script).not.toContain('/api/hook-event');
  });

  it('forwards only valid context and silently drops failures, empty text and API envelopes', () => {
    const run = (value: unknown, error: Error | null = null) => {
      let output = '';
      const execFile = vi.fn((_command, _args, options, callback) => {
        expect(options.timeout).toBeLessThan(3000);
        callback(error, JSON.stringify(value));
      });
      const processStub = {
        stdin: { resume: vi.fn() },
        env: { REVERIE_SESSION_ID: '11111111-1111-4111-8111-111111111111', REVERIE_API_URL: 'http://office' },
        stdout: {
          write: (value: string) => {
            output += value;
          },
        },
      };
      new Function('require', 'process', generateTurnSummaryScript('PostToolUse'))(() => ({ execFile }), processStub);
      expect(execFile).toHaveBeenCalledOnce();
      expect(processStub.stdin.resume).toHaveBeenCalledOnce();
      return output;
    };
    const valid = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Room update' } };
    expect(JSON.parse(run(valid))).toEqual(valid);
    expect(run(valid, new Error('offline'))).toBe('');
    expect(run({ success: true, data: valid })).toBe('');
    expect(run({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '  ' } })).toBe('');
    expect(run({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'wrong event' } })).toBe('');
  });

  it('runs the real memory brief helper: shows the brief every session start, says when it could not be had, and drops bad output', () => {
    const dir = join(tmpdir(), `reverie-brief-hook-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(
      join(dir, 'reverie'),
      `#!${process.execPath}\nif(process.env.BRIEF_FAIL==='old'){process.stderr.write("error: unknown command 'journal'\\n");process.exit(1)}if(process.argv.slice(2).join(' ')!=='agent journal brief --hook-event SessionStart'||process.env.BRIEF_FAIL)process.exit(1);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:process.env.BRIEF_TEXT}}));\n`,
      { mode: 0o700 }
    );
    const run = (text: string, fail: boolean | 'old' = false) => {
      const result = spawnSync(process.execPath, ['-e', generateMemoryBriefScript()], {
        env: { ...process.env, TMPDIR: dir, PATH: `${dir}:${process.env.PATH}`, REVERIE_SESSION_ID: randomUUID(), REVERIE_CLI: '',
          REVERIE_API_URL: 'http://office', BRIEF_TEXT: text, BRIEF_FAIL: fail === 'old' ? 'old' : fail ? '1' : '' },
        encoding: 'utf8', input: 'untrusted hook payload', timeout: 4000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : undefined;
    };
    try {
      expect(run('Your memory: you are Maple.')).toEqual({ hookEventName: 'SessionStart', additionalContext: 'Your memory: you are Maple.' });
      expect(run('Your memory: you are Maple.')?.additionalContext).toBe('Your memory: you are Maple.'); // every start, no dedup
      expect(run('x'.repeat(2001))).toBeUndefined();
      // The CLI failed or timed out: the session is told its brief could not be read, not left to assume it has no memory.
      expect(run('Your memory: you are Maple.', true)).toEqual({ hookEventName: 'SessionStart', additionalContext: `${MEMORY_BRIEF_UNREADABLE} (The hook ran reverie from PATH.)` });
      // A laptop CLI from before the journal: the gap is named, not a command that is not there.
      expect(run('Your memory: you are Maple.', 'old')).toEqual({ hookEventName: 'SessionStart', additionalContext: `${MEMORY_BRIEF_NO_CLI} (The hook ran reverie from PATH.)` });
      expect(run('  ')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the image CLI named in REVERIE_CLI, not an older reverie earlier on PATH, and names it when it fails', () => {
    const dir = join(tmpdir(), `reverie-image-cli-hook-${randomUUID()}`);
    mkdirSync(join(dir, 'home'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'image'), { mode: 0o700 });
    // The stale home copy predates the journal and the summary; the image's copy answers both.
    writeFileSync(join(dir, 'home', 'reverie'), `#!${process.execPath}\nprocess.stderr.write("error: unknown command '" + process.argv[3] + "'\\n");process.exit(1);\n`, { mode: 0o700 });
    const image = join(dir, 'image', 'reverie');
    writeFileSync(image, `#!${process.execPath}\nif(process.env.IMAGE_FAIL)process.exit(1);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:process.argv.at(-1),additionalContext:'from the image CLI'}}));\n`, { mode: 0o700 });
    const run = (script: string, cli: string, fail = false) => {
      const result = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, TMPDIR: dir, PATH: `${join(dir, 'home')}:${process.env.PATH}`, REVERIE_CLI: cli, REVERIE_SESSION_ID: randomUUID(),
          REVERIE_API_URL: 'http://office', IMAGE_FAIL: fail ? '1' : '' },
        encoding: 'utf8', input: 'untrusted hook payload', timeout: 4000,
      });
      expect(result.status).toBe(0);
      return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : undefined;
    };
    try {
      expect(run(generateMemoryBriefScript(), image)).toBe('from the image CLI');
      expect(run(generateTurnSummaryScript('UserPromptSubmit'), image)).toBe('from the image CLI');
      expect(run(generateMemoryBriefScript(), image, true)).toBe(`${MEMORY_BRIEF_UNREADABLE} (The hook ran ${image}.)`);
      // Unset or not an absolute path: PATH as before, so the stale copy answers and the fallback says so.
      for (const cli of ['', 'reverie', 'image/reverie'])
        expect(run(generateMemoryBriefScript(), cli)).toBe(`${MEMORY_BRIEF_NO_CLI} (The hook ran reverie from PATH.)`);
      expect(run(generateTurnSummaryScript('UserPromptSubmit'), '')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates real helper processes, refreshes each prompt, and clears a prior snapshot once', () => {
    const dir = join(tmpdir(), `reverie-summary-hook-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    const cli = join(dir, 'reverie');
    writeFileSync(
      cli,
      `#!${process.execPath}\nif(process.env.SUMMARY_FAIL)process.exit(1);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:process.argv.at(-1),additionalContext:process.env.SUMMARY_TEXT}}));\n`,
      { mode: 0o700 }
    );
    const sessionId = randomUUID();
    const run = (event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse', text: string, fail = false) => {
      const result = spawnSync(process.execPath, ['-e', generateTurnSummaryScript(event)], {
        env: {
          ...process.env,
          TMPDIR: dir,
          PATH: `${dir}:${process.env.PATH}`,
          REVERIE_CLI: '',
          REVERIE_SESSION_ID: sessionId,
          REVERIE_API_URL: 'http://office',
          SUMMARY_TEXT: text,
          SUMMARY_FAIL: fail ? '1' : '',
        },
        encoding: 'utf8',
        input: 'untrusted hook payload'.repeat(8192),
        timeout: 4000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : '';
    };
    try {
      expect(run('PostToolUse', '')).toBe('');
      expect(run('PostToolUse', 'first pending message')).toBe('first pending message');
      expect(run('PostToolUse', 'first pending message')).toBe('');
      expect(run('PostToolUse', '', true)).toBe('');
      expect(run('PostToolUse', 'first pending message')).toBe('');
      expect(run('PostToolUse', 'x'.repeat(3001))).toBe('');
      expect(run('PostToolUse', 'first pending message')).toBe('');
      expect(run('PostToolUse', 'changed pending message')).toBe('changed pending message');
      expect(run('UserPromptSubmit', 'changed pending message')).toBe('changed pending message');
      expect(run('SessionStart', 'changed pending message')).toBe('changed pending message');
      expect(run('PostToolUse', '')).toContain('summary cleared');
      expect(run('PostToolUse', '')).toBe('');
      const statePath = join(dir, `reverie-turn-summary-${process.getuid!()}`, `${sessionId}.json`);
      const state = readFileSync(statePath, 'utf8');
      expect(state).not.toContain('pending message');
      expect(JSON.parse(state)).toEqual({ digest: expect.stringMatching(/^[a-f0-9]{64}$/), nonempty: false });
      expect(statSync(statePath).mode & 0o077).toBe(0);
      rmSync(statePath);
      const outside = join(dir, 'outside');
      writeFileSync(outside, 'untouched');
      symlinkSync(outside, statePath);
      expect(run('PostToolUse', 'snapshot despite unsafe cache')).toBe('snapshot despite unsafe cache');
      expect(readFileSync(outside, 'utf8')).toBe('untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges Codex user hooks idempotently and refuses symlink and malformed files', async () => {
    const dir = join(tmpdir(), `reverie-codex-hooks-${Date.now()}-${Math.random()}`);
    const external = join(tmpdir(), `reverie-codex-hooks-external-${Date.now()}`);
    mkdirSync(join(dir, '.codex'), { recursive: true });
    const path = join(dir, '.codex', 'hooks.json');
    const userHook = { hooks: [{ type: 'command', command: './my-hook' }] };
    try {
      writeFileSync(path, JSON.stringify({ custom: true, hooks: { SessionStart: [userHook] } }));
      await applyCodexTurnSummaryHooks(dir, true);
      const once = readFileSync(path, 'utf8');
      const parsed = JSON.parse(once);
      expect(parsed.custom).toBe(true);
      expect(parsed.hooks.SessionStart).toContainEqual(userHook);
      expect(JSON.stringify(parsed)).toContain('REVERIE_TURN_SUMMARY_V2');
      await applyCodexTurnSummaryHooks(dir, true);
      expect(readFileSync(path, 'utf8')).toBe(once);
      writeFileSync(path, '{invalid');
      await applyCodexTurnSummaryHooks(dir, true);
      expect(readFileSync(path, 'utf8')).toBe('{invalid');
      rmSync(path);
      writeFileSync(external, '{}');
      symlinkSync(external, path);
      await applyCodexTurnSummaryHooks(dir, true);
      expect(readFileSync(external, 'utf8')).toBe('{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { force: true });
    }
  });
});


it('deduplicates actual zoned summary snapshots across clock ticks', () => {
  const dir = join(tmpdir(), 'reverie-clock-dedup-' + randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  const sessionId = randomUUID();
  writeFileSync(join(dir, 'reverie'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:process.argv.at(-1),additionalContext:process.env.SUMMARY_TEXT}}));\n`, { mode: 0o700 });
  const candidate = { roomId: 'room', room: 'Office', messageId: 'source', sender: 'Owner', role: 'owner',
    at: 1000, excerpt: 'An unchanged request', state: 'reply-pending' as const, priority: 1 };
  const snapshot = (now: number, zone = 'America/New_York', excerpt = candidate.excerpt) =>
    renderTurnSummary('ring', [{ ...candidate, excerpt }], { state: 'complete', rooms: [] }, zone, now);
  const run = (text: string, event: 'PostToolUse' | 'UserPromptSubmit' = 'PostToolUse') => {
    const result = spawnSync(process.execPath, ['-e', generateTurnSummaryScript(event)], {
      env: { ...process.env, TMPDIR: dir, PATH: dir + ':' + process.env.PATH, REVERIE_CLI: '',
        REVERIE_SESSION_ID: sessionId, REVERIE_API_URL: 'http://inert', SUMMARY_TEXT: text },
      input: '', encoding: 'utf8', timeout: 4000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    return result.stdout;
  };
  try {
    const first = snapshot(Date.parse('2026-10-28T00:00:00Z'));
    const next = snapshot(Date.parse('2026-10-28T00:00:01Z'));
    expect(run(first.text)).not.toBe('');
    expect(run(next.text)).toBe('');
    expect(next.generatedAt).not.toBe(first.generatedAt);
    expect(run(snapshot(Date.parse('2026-10-29T00:00:01Z')).text)).toBe('');
    expect(run(next.text, 'UserPromptSubmit')).not.toBe('');
    expect(run(snapshot(next.generatedAt!, 'Asia/Kathmandu').text)).not.toBe('');
    expect(run(snapshot(next.generatedAt!, 'Asia/Kathmandu', 'Actually changed request').text)).not.toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
