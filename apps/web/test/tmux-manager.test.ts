/**
 * @fileoverview Unit + integration tests for TmuxManager
 *
 * Unit tests (mocked): validation, command construction, parsing logic.
 * Integration tests (real tmux): session creation, input, kill, reconciliation.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TmuxManager,
  buildCodexCommand,
  buildTmuxPaneLaunchCommand,
  buildRemoteKillCommand,
  buildRemoteLaunchCommand,
  formatPaneSnapshot,
  parsePaneRows,
  derivePaneExits,
  hasObservablePaneSession,
  type PaneRow,
  resolveActivePaneTarget,
} from '../src/tmux-manager.js';
import { execSync, exec } from 'node:child_process';
import type { MuxSession } from '../src/mux-interface.js';
import { withWriteGate } from '../src/submit-settle.js';

// ============================================================================
// Unit Tests (mocked)
// ============================================================================

// Mock child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    exec: vi.fn((_cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (typeof callback === 'function') {
        setImmediate(() => callback(null, '', ''));
      }
      return {
        on: vi.fn(),
        kill: vi.fn(),
        pid: 12345,
      };
    }),
    execSync: vi.fn(),
    spawn: vi.fn(() => ({
      unref: vi.fn(),
      on: vi.fn(),
      pid: 12345,
    })),
  };
});

// Mock fs to avoid file I/O
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFile: vi.fn((_path: string, _data: string, cb: (err: Error | null) => void) => cb(null)),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
  };
});

describe('TmuxManager (unit)', () => {
  let manager: TmuxManager;
  const mockedExecSync = vi.mocked(execSync);
  const mockedExec = vi.mocked(exec);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: which claude returns /usr/local/bin/claude
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('which claude')) {
        return '/usr/local/bin/claude\n';
      }
      if (typeof cmd === 'string' && cmd.includes('which tmux')) {
        return '/usr/bin/tmux\n';
      }
      return '';
    });
    manager = new TmuxManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('backend', () => {
    it('should report tmux as backend', () => {
      expect(manager.backend).toBe('tmux');
    });
  });

  describe('statusline user-command env', () => {
    // A tmux setenv survives respawn-pane, so the absence of a user statusline
    // must UNSET the variable rather than leave a stale one for the exporter
    // to wrap.
    it('unsets REVERIE_USER_STATUSLINE_CMD when the user has no statusline', () => {
      mockedExecSync.mockClear();
      (
        manager as unknown as { _configureStatusLineUserCommand: (m: string, c?: string) => void }
      )._configureStatusLineUserCommand('reverie-abc', undefined);
      const cmds = mockedExecSync.mock.calls.map((c) => String(c[0]));
      expect(cmds.some((c) => c.includes("setenv -t 'reverie-abc' -u REVERIE_USER_STATUSLINE_CMD"))).toBe(true);
    });

    it('sets REVERIE_USER_STATUSLINE_CMD, shell-escaped, when the user has one', () => {
      mockedExecSync.mockClear();
      (
        manager as unknown as { _configureStatusLineUserCommand: (m: string, c?: string) => void }
      )._configureStatusLineUserCommand('reverie-abc', `printf '%s' "$1" | jq -r .model`);
      const cmds = mockedExecSync.mock.calls.map((c) => String(c[0]));
      const setCmd = cmds.find((c) => c.includes('REVERIE_USER_STATUSLINE_CMD'));
      expect(setCmd).toBeDefined();
      expect(setCmd).not.toContain(' -u ');
      expect(setCmd).toContain("setenv -t 'reverie-abc' REVERIE_USER_STATUSLINE_CMD ");
    });
  });

  describe('Codex command builder', () => {
    it('controls decorative TUI animation through Codex config', () => {
      expect(buildCodexCommand({ animations: false })).toBe('codex --config check_for_update_on_startup=false --config tui.animations=false');
      expect(buildCodexCommand({ animations: true })).toBe('codex --config check_for_update_on_startup=false --config tui.animations=true');
      expect(buildCodexCommand()).toBe('codex --config check_for_update_on_startup=false');
    });
  });

  describe('remote launch command builder', () => {
    it('wraps codex command overrides in ssh with remote tmux launch', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'codex',
        remote: {
          hostId: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          remotePath: '/home/ubuntu/work',
          commands: { codex: 'exec codx personal' },
        },
        sessionId: 'abc123def456',
      });

      expect(command).toContain('ssh');
      expect(command).toContain('BatchMode=yes');
      expect(command).toContain('ubuntu@10.0.0.42');
      expect(command).toContain('/home/ubuntu/work');
      // Dedicated socket + a name that fails a remote Reverie's SAFE_MUX_NAME_PATTERN.
      expect(command).toContain('tmux -L reverie-remote new-session -A -s reverie-ssh-abc123de');
      expect(command).toContain('exec codx personal');
      // Session options are scoped per-session, never global (-g).
      expect(command).not.toContain('set -g');
    });

    it('uses default shell command when no override is configured', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'shell',
        remote: {
          hostId: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          remotePath: '/home/ubuntu/work',
        },
        sessionId: 'abc123def456',
      });

      expect(command).toContain('exec "${SHELL:-/bin/sh}" -i -l');
      // `failed`, not `on`: `on` also keeps the pane after a CLEAN exit, so typing
      // `exit` in a remote shell strands a dead pane that the next launch's `-A`
      // reattaches to instead of starting a shell.
      expect(command).toContain('remain-on-exit failed');
      expect(command).not.toContain('remain-on-exit on');
      // Last in the chain: tmux aborts the rest of a `\;` sequence after an error,
      // and `failed` needs tmux >= 3.2 on the REMOTE host. Trailing, a rejection
      // costs only this option instead of every setting after it.
      expect(command.trimEnd().endsWith("remain-on-exit failed'")).toBe(true);
    });

    it('defaults claude to a non-interactive launch (--dangerously-skip-permissions)', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'claude',
        remote: { hostId: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', remotePath: '/w' },
        sessionId: 'abc123def456',
      });
      // Routed through an interactive login shell so ~/.local/bin (where `claude`
      // typically lives) is on PATH — ssh's remote-command execution is neither
      // interactive nor login, so a bare `exec claude` fails with "command not found".
      // The inner quoting is escaped twice over (once per shellescape() layer), so
      // assert on the unescaped substrings rather than the literal quoted form.
      expect(command).toContain('exec "${SHELL:-/bin/sh}" -i -l -c');
      expect(command).toContain('claude --dangerously-skip-permissions');
    });

    it('pins SSH-remote claude to the Reverie session id so a respawn resumes the same conversation', () => {
      // Regression (2026-08-29): remote claude was launched as a bare `claude …`,
      // so every reattach/respawn after a pane death (user ctrl-d or ctrl-c exit)
      // started a NEW conversation. The launch now mirrors the docker-claude shape:
      // `--session-id <id>` to create, with a `|| --resume <id>` fallback so the
      // idempotent re-run resumes instead of erroring ("already in use").
      const command = buildRemoteLaunchCommand({
        mode: 'claude',
        remote: { hostId: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', remotePath: '/w' },
        sessionId: 'abc123def456',
      });
      expect(command).toContain('claude --dangerously-skip-permissions --session-id abc123def456');
      expect(command).toContain('claude --dangerously-skip-permissions --resume abc123def456');
    });

    it('resumes an explicit resumeSessionId distinct from sessionId (mirrors claudeDockerPaneCommand)', () => {
      // The docker-claude builder (claudeDockerPaneCommand) has always handled a
      // resumeId that differs from sessionId — e.g. a resume-from-history launch —
      // by leading with `--resume <rid> || --session-id <sessionId>`. The remote
      // claude branch used to only mirror the SAME-id fallback shape and silently
      // dropped a distinct resumeSessionId, so a remote resume-from-history claude
      // launch created a brand-new conversation instead of resuming the named one.
      const command = buildRemoteLaunchCommand({
        mode: 'claude',
        remote: { hostId: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', remotePath: '/w' },
        sessionId: 'abc123def456',
        resumeSessionId: 'old-conversation-uuid',
      });
      expect(command).toContain('claude --dangerously-skip-permissions --resume old-conversation-uuid');
      expect(command).toContain('claude --dangerously-skip-permissions --session-id abc123def456');
      // The resume attempt must lead — session-id is the fallback here, reversed
      // from the same-id case.
      const resumeIdx = command.indexOf('--resume old-conversation-uuid');
      const sessionIdIdx = command.indexOf('--session-id abc123def456');
      expect(resumeIdx).toBeLessThan(sessionIdIdx);
    });
  });

  describe('remote kill command builder', () => {
    it('kills the durable remote tmux session on the dedicated socket via ssh', () => {
      const command = buildRemoteKillCommand({
        remote: {
          hostId: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          remotePath: '/home/ubuntu/work',
        },
        sessionId: 'abc123def456',
      });

      expect(command).toContain('ssh');
      // Shares the default ConnectTimeout so an unreachable host fails fast (never blocks kill).
      expect(command).toContain('-o ConnectTimeout=10');
      expect(command).toContain('ubuntu@10.0.0.42');
      expect(command).toContain('tmux -L reverie-remote kill-session -t');
      expect(command).toContain('reverie-ssh-abc123de');
    });
  });

  describe('getAttachCommand', () => {
    it('should return tmux', () => {
      expect(manager.getAttachCommand()).toBe('tmux');
    });
  });

  describe('getAttachArgs', () => {
    it('should attach every session through the dedicated Reverie socket', () => {
      const args = manager.getAttachArgs('reverie-00000030');
      expect(args).toEqual(['-L', 'reverie', 'attach-session', '-t', 'reverie-00000030']);
    });

    it('refuses every key shape but text + Enter for a gated write, before any transport', async () => {
      manager.registerSession({ sessionId: 'gated', muxName: 'reverie-00000031', pid: 12345, createdAt: Date.now(), workingDir: '/tmp', mode: 'codex', attached: false });
      const gated = (input: string, options = {}) => withWriteGate(() => true, () => manager.sendInput('gated', input, options));
      expect((await gated('\r')).result).toBe(false); // a bare Enter
      expect((await gated('wake')).result).toBe(false); // text without Enter
      expect(await manager.sendInput('gated', 'wake\r', { opencode: true, stillIdle: () => true })).toBe(false); // OpenCode has no idle check
      expect(await manager.sendInput('gated', 'wake', { stillIdle: () => true })).toBe(false);
      // OpenCode's own typer follows a write gate key by key (typeIntoOpencode), so a gated OpenCode text + Enter goes on.
      expect((await gated('wake\r', { opencode: true })).result).toBe(true);
      expect((await gated('\r', { opencode: true })).result).toBe(true); // OpenCode's bare Enter (a verifier's) follows the gate too
      expect(await manager.sendInput('gated', '\r', { opencode: true, stillIdle: () => true })).toBe(false);
      // Text + Enter goes on to the (test-mode) transport; an ungated write is not affected.
      expect((await gated('wake\r')).result).toBe(true);
      expect(await manager.sendInput('gated', '\r')).toBe(true);
    });

    it('should attach registered sessions on the same dedicated socket (no per-session socket)', () => {
      manager.registerSession({
        sessionId: 'some-session',
        muxName: 'reverie-00000030',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const args = manager.getAttachArgs('reverie-00000030');
      expect(args).toEqual(['-L', 'reverie', 'attach-session', '-t', 'reverie-00000030']);
    });
  });

  describe('window sizing', () => {
    it('pins a tmux window to manual sizing before browser attach', () => {
      expect(manager.setManualWindowSize('reverie-00000030')).toBe(true);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "tmux -L 'reverie' set-window-option -t 'reverie-00000030' window-size manual",
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('resizes the tmux window when Reverie accepts a desktop resize', () => {
      expect(manager.resizeWindow('reverie-00000030', 140, 42)).toBe(true);

      // Non-blocking exec (not execSync) on the interactive resize hot path.
      expect(mockedExec).toHaveBeenCalledWith(
        "tmux -L 'reverie' resize-window -t 'reverie-00000030' -x 140 -y 42",
        expect.objectContaining({ timeout: expect.any(Number) }),
        expect.any(Function)
      );
    });
  });

  describe('environment exports', () => {
    const callBuildEnvExports = (mode: string) =>
      (
        manager as unknown as {
          buildEnvExports(sessionId: string, muxName: string, mode: string): string[];
        }
      ).buildEnvExports('session-1', 'reverie-00000030', mode);

    it('uses the built-in UTF-8 locale for newly launched panes', () => {
      for (const mode of ['claude', 'codex', 'opencode', 'shell']) {
        const exports = callBuildEnvExports(mode);
        expect(exports).toContain('export LANG=C.UTF-8');
        expect(exports).toContain('export LC_ALL=C.UTF-8');
      }
    });

    it('keeps COLORTERM unset for OpenCode sessions', () => {
      expect(callBuildEnvExports('opencode')).toContain('unset COLORTERM');
    });

    // Claude renders its themed backgrounds as RGB. Without this the pane inherits
    // tmux's TERM=screen, supports-color reads 16 colors, and every dark background
    // quantizes to ESC[40m — the terminal's own black — so the block goes invisible.
    it('exports truecolor for Claude sessions', () => {
      expect(callBuildEnvExports('claude')).toContain('export COLORTERM=truecolor');
    });

    it('exports the server-stamped REVERIE_API_URL verbatim', () => {
      const original = process.env.REVERIE_API_URL;
      process.env.REVERIE_API_URL = 'https://127.0.0.1:3199';
      try {
        expect(callBuildEnvExports('claude')).toContain('export REVERIE_API_URL=https://127.0.0.1:3199');
      } finally {
        if (original === undefined) delete process.env.REVERIE_API_URL;
        else process.env.REVERIE_API_URL = original;
      }
    });

    // A hardcoded fallback exported the wrong scheme on HTTPS installs; unset must
    // stay unset so in-session guards fail closed instead of curling a bad URL.
    it('exports no REVERIE_API_URL at all when the server has not stamped one', () => {
      const original = process.env.REVERIE_API_URL;
      delete process.env.REVERIE_API_URL;
      try {
        const exports = callBuildEnvExports('claude');
        expect(exports.some((line) => line.startsWith('export REVERIE_API_URL'))).toBe(false);
        expect(exports.join(' ')).not.toContain('localhost:3000');
      } finally {
        if (original === undefined) delete process.env.REVERIE_API_URL;
        else process.env.REVERIE_API_URL = original;
      }
    });
  });

  describe('formatPaneSnapshot', () => {
    it('paints captured rows with absolute cursor positions to avoid newline autowrap scroll', () => {
      const fullWidthLine = 'x'.repeat(10);

      const snapshot = formatPaneSnapshot([fullWidthLine, 'next line'], {
        cols: 10,
        rows: 4,
        cursorX: 2,
        cursorY: 1,
      });

      // Full pane width is painted (10 cols); autowrap is avoided by the
      // absolute cursor positioning, not by dropping the last column.
      expect(snapshot).toBe(`\x1b[1;1H${'x'.repeat(10)}\x1b[2;1Hnext line\x1b[2;3H`);
      expect(snapshot).not.toContain('\n');
    });

    it('preserves the rightmost column of each captured row', () => {
      const snapshot = formatPaneSnapshot(['abcd'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      // Previously truncated to cols - 1 ('abc'); the full width is now kept.
      expect(snapshot).toBe('\x1b[1;1Habcd\x1b[1;1H');
    });

    it('preserves SGR color while stripping non-style pane controls', () => {
      const snapshot = formatPaneSnapshot(['\x1b[32mgreen\x1b[0m\x1b[2K\x1b[10;20Htail'], {
        cols: 40,
        rows: 2,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toContain('\x1b[32mgreen\x1b[0m');
      expect(snapshot).toContain('tail');
      expect(snapshot).not.toContain('\x1b[2K');
      expect(snapshot).not.toContain('\x1b[10;20H');
    });

    it('truncates styled rows by visible columns without cutting SGR escapes', () => {
      const snapshot = formatPaneSnapshot(['\x1b[31mabcdef\x1b[0m'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toBe('\x1b[1;1H\x1b[31mabcd\x1b[0m\x1b[1;1H');
    });

    it('does not let full-width glyphs cross the paint boundary', () => {
      // cols 5 = 'abc' (3) + full-width \u754c (2) fits exactly; with cols 4 the
      // wide glyph would straddle the boundary and is dropped.
      expect(formatPaneSnapshot(['abc\u754cdef'], { cols: 5, rows: 1, cursorX: 0, cursorY: 0 })).toBe(
        '\x1b[1;1Habc\u754c\x1b[1;1H'
      );
      expect(formatPaneSnapshot(['abc\u754cdef'], { cols: 4, rows: 1, cursorX: 0, cursorY: 0 })).toBe(
        '\x1b[1;1Habc\x1b[1;1H'
      );
    });

    it('keeps combining marks attached without consuming a terminal column', () => {
      const snapshot = formatPaneSnapshot(['a\u0301bc'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toBe('\x1b[1;1Ha\u0301bc\x1b[1;1H');
    });
  });

  describe('resolveActivePaneTarget', () => {
    it('selects the active pane instead of assuming pane zero', () => {
      expect(resolveActivePaneTarget('%1:0\n%18:1\n')).toBe('%18');
    });
  });

  describe('isAvailable', () => {
    it('should return true when tmux is found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(true);
    });

    it('should return false when tmux is not found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          throw new Error('not found');
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(false);
    });
  });

  // NOTE: In test mode (VITEST=1), sendInput is a no-op that returns true
  // without calling execSync. This prevents tests from sending input to real tmux.
  describe('sendInput (test mode safety)', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'test-id',
        muxName: 'reverie-1e571234',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should return true for registered session (no-op in test mode)', async () => {
      expect(await manager.sendInput('test-id', '/clear\r')).toBe(true);
    });

    it('should return false for unknown session', async () => {
      expect(await manager.sendInput('nonexistent', 'hello\r')).toBe(false);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.sendInput('test-id', 'hello\r');
      const sendKeyCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('send-keys')
      );
      expect(sendKeyCalls).toHaveLength(0);
    });
  });

  // NOTE: In test mode, reconcileSessions returns all registered sessions as
  // alive without running any real tmux commands. This prevents discovery of
  // or interaction with the user's real tmux sessions.
  describe('reconcileSessions (test mode safety)', () => {
    it('should return all registered sessions as alive', async () => {
      manager.registerSession({
        sessionId: 'alive-1',
        muxName: 'reverie-a11ce111',
        pid: 100,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.reconcileSessions();
      expect(result.alive).toContain('alive-1');
      expect(result.dead).toHaveLength(0);
      expect(result.discovered).toHaveLength(0);
    });

    it('should never discover real tmux sessions', async () => {
      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(0);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.reconcileSessions();
      const tmuxCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && (cmd.includes('has-session') || cmd.includes('list-sessions'))
      );
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  // NOTE: In test mode, killSession removes from memory without running any
  // real kill commands. The self-kill protection is not needed because no real
  // tmux commands are executed — sessions are only removed from the in-memory map.
  describe('killSession (test mode safety)', () => {
    it('should remove session from memory in test mode', async () => {
      manager.registerSession({
        sessionId: 'kill-test',
        muxName: 'reverie-5e1f1111',
        pid: 999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.killSession('kill-test');
      expect(result).toBe(true);
      expect(manager.getSession('kill-test')).toBeUndefined();
    });

    it('should allow kill when session does NOT match REVERIE_MUX_NAME', async () => {
      const originalEnv = process.env.REVERIE_MUX_NAME;
      process.env.REVERIE_MUX_NAME = 'reverie-0ther1111';

      try {
        manager.registerSession({
          sessionId: 'other-kill-test',
          muxName: 'reverie-d1ff1111',
          pid: 888,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        // Mock the kill flow
        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('other-kill-test');
        expect(result).toBe(true);

        // Session should be removed
        expect(manager.getSession('other-kill-test')).toBeUndefined();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.REVERIE_MUX_NAME;
        } else {
          process.env.REVERIE_MUX_NAME = originalEnv;
        }
      }
    });

    it('should allow kill when REVERIE_MUX_NAME is not set', async () => {
      const originalEnv = process.env.REVERIE_MUX_NAME;
      delete process.env.REVERIE_MUX_NAME;

      try {
        manager.registerSession({
          sessionId: 'no-env-test',
          muxName: 'reverie-aaa11111',
          pid: 777,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('no-env-test');
        expect(result).toBe(true);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.REVERIE_MUX_NAME;
        } else {
          process.env.REVERIE_MUX_NAME = originalEnv;
        }
      }
    });
  });

  describe('metadata operations', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'meta-test',
        muxName: 'reverie-ae1a1234',
        pid: 300,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should update session name', () => {
      const result = manager.updateSessionName('meta-test', 'My Session');
      expect(result).toBe(true);
      expect(manager.getSession('meta-test')?.name).toBe('My Session');
    });

    it('should return false for unknown session name update', () => {
      const result = manager.updateSessionName('nonexistent', 'Name');
      expect(result).toBe(false);
    });

    it('should set attached status', () => {
      manager.setAttached('meta-test', true);
      expect(manager.getSession('meta-test')?.attached).toBe(true);
      manager.setAttached('meta-test', false);
      expect(manager.getSession('meta-test')?.attached).toBe(false);
    });

    it('should update respawn config', () => {
      const config = {
        enabled: true,
        idleTimeoutMs: 5000,
        updatePrompt: 'test',
        interStepDelayMs: 1000,
        sendClear: true,
        sendInit: true,
      };
      manager.updateRespawnConfig('meta-test', config);
      expect(manager.getSession('meta-test')?.respawnConfig).toEqual(config);
    });

    it('should clear respawn config', () => {
      manager.updateRespawnConfig('meta-test', {
        enabled: true,
        idleTimeoutMs: 5000,
        updatePrompt: 'test',
        interStepDelayMs: 1000,
        sendClear: true,
        sendInit: true,
      });
      manager.clearRespawnConfig('meta-test');
      expect(manager.getSession('meta-test')?.respawnConfig).toBeUndefined();
    });

    it('should update ralph enabled', () => {
      manager.updateRalphEnabled('meta-test', true);
      expect(manager.getSession('meta-test')?.ralphEnabled).toBe(true);
    });
  });

  describe('getSessions', () => {
    it('should return all registered sessions', () => {
      manager.registerSession({
        sessionId: 's1',
        muxName: 'reverie-51111111',
        pid: 1,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
      manager.registerSession({
        sessionId: 's2',
        muxName: 'reverie-52222222',
        pid: 2,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: true,
      });

      const sessions = manager.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId)).toContain('s1');
      expect(sessions.map((s) => s.sessionId)).toContain('s2');
    });
  });

  describe('stats collection', () => {
    it('should start and stop stats collection', () => {
      manager.startStatsCollection(60000);
      // No error thrown
      manager.stopStatsCollection();
      // No error thrown
    });
  });

  describe('tmux launch cwd hardening', () => {
    async function importWithTmuxCommandsEnabled(): Promise<typeof TmuxManager> {
      const originalVitest = process.env.VITEST;
      vi.resetModules();
      delete process.env.VITEST;
      const module = await import('../src/tmux-manager.js');
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      return module.TmuxManager;
    }

    beforeEach(() => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('#{pane_pid}')) {
          return '4242\n';
        }
        return '';
      });
    });

    async function launchFixture() {
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const child = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const bash = child.execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
      const path = await import('node:path');
      const os = await import('node:os');
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tmux-launch-'));
      const tools = path.join(root, 'tools');
      fs.mkdirSync(tools);
      const capture = path.join(root, 'tmux-argv.json');
      const script = (file: string, body: string) => {
        fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
      };
      script(path.join(tools, 'tmux'), `require('node:fs').writeFileSync(process.env.TMUX_ARGV, JSON.stringify(process.argv.slice(2)))`);
      const outerArgs = (command: string, env: Record<string, string> = {}) => {
        child.execFileSync('/bin/sh', ['-c', command], {
          env: { HOME: root, PATH: tools + ':/bin', TMUX_ARGV: capture, ...env },
        });
        return JSON.parse(fs.readFileSync(capture, 'utf8')) as string[];
      };
      return { fs, child, bash, path, root, tools, script, outerArgs, close: () => fs.rmSync(root, { recursive: true, force: true }) };
    }

    it('passes literal variables, substitutions, backticks and spaces through the outer shell as one program', async () => {
      const f = await launchFixture();
      try {
        const data = 'space $PARENT_MARK $(printf OUTER_SUB) `printf OUTER_TICK`';
        const program = `printf '%s' '${data}'`;
        const command = buildTmuxPaneLaunchCommand('tmux -L reverie', 'reverie-test', program, true);
        const args = f.outerArgs(command, { PARENT_MARK: 'website-value' });
        expect(args.slice(-3)).toEqual(['bash', '-c', program]);
        expect(args).not.toContain('-k');
        expect(f.child.execFileSync(f.bash, ['--noprofile', '--norc', '-c', args.at(-1)!], { encoding: 'utf8' })).toBe(data);
      } finally { f.close(); }
    });

    it('defers native PATH expansion until the pane shell', async () => {
      const f = await launchFixture();
      try {
        const program = 'printf "%s" "$PATH"';
        const args = f.outerArgs(buildTmuxPaneLaunchCommand('tmux -L reverie', 'reverie-test', program), { PATH: f.tools + ':/website-only' });
        expect(args.at(-1)).toBe(program);
        expect(f.child.execFileSync(f.bash, ['--noprofile', '--norc', '-c', args.at(-1)!], { env: { PATH: '/pane-only' }, encoding: 'utf8' })).toBe('/pane-only');
      } finally { f.close(); }
    });

    it('treats a native CLI directory with spaces and shell metacharacters as literal data', async () => {
      const f = await launchFixture();
      const originalWorker = process.env.REVERIE_WORKER_SOCKET;
      delete process.env.REVERIE_WORKER_SOCKET;
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      const resolver = await import('../src/utils/cli-resolver.js');
      const cliDir = f.path.join(f.root, 'CLI $NAME $(printf SUB) `printf TICK` with spaces');
      f.fs.mkdirSync(cliDir);
      const output = f.path.join(f.root, 'native-provider.json');
      f.script(f.path.join(cliDir, 'codex'), `require('node:fs').writeFileSync(process.env.PROVIDER_RESULT, JSON.stringify({cwd:process.cwd(),path:process.env.PATH,args:process.argv.slice(2)}))`);
      const resolverSpy = vi.spyOn(resolver, 'resolveCliBinDir').mockReturnValue(cliDir);
      mockedExecSync.mockClear();
      try {
        await nonTestManager.createSession({ sessionId: '11111111-1234-4123-8123-123456789abc', workingDir: f.root, mode: 'codex' });
        const command = mockedExecSync.mock.calls.find(([value]) => String(value).includes(' respawn-pane '))?.[0];
        const args = f.outerArgs(String(command), { PATH: f.tools + ':/website-parent', NAME: 'PARENT_EXPANSION' });
        f.child.execFileSync(f.bash, ['--noprofile', '--norc', '-c', args.at(-1)!], { env: { HOME: f.root, PATH: '/pane-base', NAME: 'CHILD_EXPANSION', PROVIDER_RESULT: output } });
        expect(JSON.parse(f.fs.readFileSync(output, 'utf8'))).toMatchObject({cwd: f.root, path: cliDir + ':/pane-base'});
      } finally {
        resolverSpy.mockRestore();
        if (originalWorker === undefined) delete process.env.REVERIE_WORKER_SOCKET;
        else process.env.REVERIE_WORKER_SOCKET = originalWorker;
        nonTestManager.destroy(); f.close();
      }
    });

    it.each(['create', 'respawn'] as const)('%s preserves worker image shims and private profile selection across both real shell layers', async (action) => {
      const f = await launchFixture();
      const originalWorker = process.env.REVERIE_WORKER_SOCKET;
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      const resolver = await import('../src/utils/cli-resolver.js');
      const serverBin = f.path.join(f.root, 'server-bin');
      const profileBin = f.path.join(f.root, 'private-profile-bin');
      const shimBin = f.path.join(f.root, 'image-autoenv-bin');
      const plainBin = f.path.join(f.root, 'image-bin');
      for (const dir of [serverBin, profileBin, shimBin, plainBin]) f.fs.mkdirSync(dir);
      const resolverSpy = vi.spyOn(resolver, 'resolveCliBinDir').mockReturnValue(serverBin);
      const output = f.path.join(f.root, 'provider.json');
      const workerArgs = f.path.join(f.root, 'worker-argv.json');
      const cwd = f.path.join(f.root, 'project with spaces');
      f.fs.mkdirSync(cwd);
      const provider = (selection: string) => `
const cp = require('node:child_process');
require('node:fs').writeFileSync(process.env.PROVIDER_RESULT, JSON.stringify({
  selection: ${JSON.stringify(selection)}, cwd: process.cwd(), args: process.argv.slice(2),
  cargo: cp.execFileSync(${JSON.stringify(f.bash)}, ['--noprofile', '--norc', '-c', 'command -v cargo'], {encoding:'utf8'}).trim(),
  profile: cp.execFileSync(${JSON.stringify(f.bash)}, ['--noprofile', '--norc', '-c', 'command -v profile-tool'], {encoding:'utf8'}).trim()
}));`;
      f.script(f.path.join(serverBin, 'codex'), provider('website'));
      f.script(f.path.join(profileBin, 'codex'), provider('private-profile'));
      for (const file of [f.path.join(serverBin, 'cargo'), f.path.join(plainBin, 'cargo'), f.path.join(shimBin, 'cargo'), f.path.join(profileBin, 'profile-tool')]) f.script(file, '');
      f.script(f.path.join(f.tools, 'reverie-worker-exec'), `
const fs = require('node:fs'); const cp = require('node:child_process'); const args = process.argv.slice(2);
fs.writeFileSync(process.env.WORKER_ARGV, JSON.stringify(args));
const command = args[args.indexOf('--command') + 1];
const result = cp.spawnSync(${JSON.stringify(f.bash)}, ['--noprofile', '--norc', '-c', command], {cwd: args[args.indexOf('--cwd') + 1], env:{...process.env, PATH:process.env.WORKER_IMAGE_PATH}, stdio:'inherit'});
process.exit(result.status === null ? 1 : result.status);`);
      process.env.REVERIE_WORKER_SOCKET = '/fixture/broker.sock';
      mockedExecSync.mockClear(); mockedExec.mockClear();
      try {
        const sessionId = '12345678-1234-4123-8123-123456789abc';
        if (action === 'create') await nonTestManager.createSession({ sessionId, workingDir: cwd, mode: 'codex' });
        else {
          nonTestManager.registerSession({ sessionId, muxName: 'reverie-12345678', pid: 1000, createdAt: Date.now(), workingDir: cwd, mode: 'codex', attached: false });
          expect(await nonTestManager.respawnPane({ sessionId, workingDir: cwd, mode: 'codex', onlyIfDead: true })).toBe(4242);
        }
        const calls = action === 'create' ? mockedExecSync.mock.calls : mockedExec.mock.calls;
        const command = calls.find(([value]) => String(value).includes(' respawn-pane '))?.[0];
        expect(typeof command).toBe('string');
        const env = { PATH: f.tools + ':' + serverBin + ':/bin', WORKER_IMAGE_PATH: [shimBin, profileBin, plainBin].join(':'), WORKER_ARGV: workerArgs, PROVIDER_RESULT: output };
        const args = f.outerArgs(String(command), env);
        f.child.execFileSync(f.bash, ['--noprofile', '--norc', '-c', args.at(-1)!], { env: { HOME: f.root, ...env } });
        const sent = JSON.parse(f.fs.readFileSync(workerArgs, 'utf8')) as string[];
        expect(sent.slice(0, 4)).toEqual(['--session-id', sessionId, '--cwd', cwd]);
        expect(sent.at(-1)).not.toContain(serverBin);
        const result = JSON.parse(f.fs.readFileSync(output, 'utf8'));
        expect(result).toMatchObject({ selection: 'private-profile', cwd, cargo: f.path.join(shimBin, 'cargo'), profile: f.path.join(profileBin, 'profile-tool') });
      } finally {
        resolverSpy.mockRestore();
        if (originalWorker === undefined) delete process.env.REVERIE_WORKER_SOCKET;
        else process.env.REVERIE_WORKER_SOCKET = originalWorker;
        nonTestManager.destroy(); f.close();
      }
    });

    it('starts new tmux sessions from /tmp and cd-bounces into the requested workspace', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        const session = await nonTestManager.createSession({
          sessionId: '00000030-003b-4000-8000-000000000055',
          workingDir: '/mnt/gdrive/project with spaces',
          mode: 'shell',
          historyLimit: 250_000,
        });

        expect(session.workingDir).toBe('/mnt/gdrive/project with spaces');
        expect(session.pid).toBe(4242);

        const newSessionCall = mockedExecSync.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' new-session ')
        );
        expect(newSessionCall?.[0]).toBe(
          `tmux -L 'reverie' set-option -g history-limit 250000 \\; new-session -ds "reverie-00000030" -c /tmp \\; set-option -t "reverie-00000030" history-limit 250000`
        );
        expect(newSessionCall?.[1]).toEqual(expect.objectContaining({ cwd: '/tmp' }));

        const respawnCall = mockedExecSync.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' respawn-pane ')
        );
        expect(respawnCall?.[0]).toContain(`tmux -L 'reverie' respawn-pane -k -c /tmp -t 'reverie-00000030'`);
        expect(respawnCall?.[0]).toContain(String.raw`cd '\''/mnt/gdrive/project with spaces'\'' &&`);
      } finally {
        nonTestManager.destroy();
      }
    });

    it('changes the global history default on tmux versions that cannot resize panes', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        await nonTestManager.setHistoryLimit(200_000);
        const historyCall = mockedExec.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' history-limit ')
        );
        expect(historyCall?.[0]).toBe(`tmux -L 'reverie' set-option -g history-limit 200000`);
        expect(historyCall?.[0]).not.toContain(' -t ');
      } finally {
        nonTestManager.destroy();
      }
    });

    it('targets only the new and tracked sessions on tmux 3.7+', async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.endsWith(' -V')) return 'tmux 3.7b\n';
        if (typeof cmd === 'string' && cmd.includes('which tmux')) return '/usr/bin/tmux\n';
        if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('#{pane_pid}')) return '4242\n';
        return '';
      });
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        await nonTestManager.createSession({
          sessionId: '00000044-0056-4000-8000-000000000082',
          workingDir: '/project',
          mode: 'shell',
          historyLimit: 250_000,
        });
        const newSessionCall = mockedExecSync.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' new-session ')
        );
        expect(newSessionCall?.[0]).toBe(
          `tmux -L 'reverie' new-session -ds "reverie-00000044" -c /tmp \\; set-option -t "reverie-00000044" history-limit 250000`
        );
        expect(newSessionCall?.[0]).not.toContain('set-option -g');

        mockedExec.mockClear();
        await nonTestManager.setHistoryLimit(200_000);
        const historyCall = mockedExec.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' history-limit ')
        );
        expect(historyCall?.[0]).toBe(`tmux -L 'reverie' set-option -t 'reverie-00000044' history-limit 200000`);
        expect(historyCall?.[0]).not.toContain('set-option -g');
      } finally {
        nonTestManager.destroy();
      }
    });

    it('respawns existing panes from /tmp and cd-bounces into the requested workspace', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'respawn1234',
        muxName: 'reverie-abcd1234',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: false,
      });

      try {
        const pid = await nonTestManager.respawnPane({
          sessionId: 'respawn1234',
          workingDir: '/mnt/gdrive/project',
          mode: 'shell',
        });

        expect(pid).toBe(4242);
        const { exec: currentExec } = await import('node:child_process');
        const respawnCall = vi
          .mocked(currentExec)
          .mock.calls.find(([cmd]) => typeof cmd === 'string' && cmd.includes(' respawn-pane '));
        expect(respawnCall?.[0]).toContain(`tmux -L 'reverie' respawn-pane -k -c /tmp -t 'reverie-abcd1234'`);
        expect(respawnCall?.[0]).toContain(String.raw`cd '\''/mnt/gdrive/project'\'' &&`);
      } finally {
        nonTestManager.destroy();
      }
    });

    it.each([false, true])('onlyIfDead=%s controls whether tmux may kill a pane that became live', async (onlyIfDead) => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'recovery1234', muxName: 'reverie-abcd1234', pid: 1000,
        createdAt: Date.now(), workingDir: '/tmp', mode: 'shell', attached: true,
      });
      try {
        expect(await nonTestManager.respawnPane({ sessionId: 'recovery1234', workingDir: '/tmp', mode: 'shell', onlyIfDead })).toBe(4242);
        const { exec: currentExec } = await import('node:child_process');
        const command = vi.mocked(currentExec).mock.calls.find(([cmd]) => String(cmd).includes(' respawn-pane '))?.[0];
        expect(command).toContain(`respawn-pane${onlyIfDead ? '' : ' -k'} -c /tmp -t 'reverie-abcd1234'`);
        if (onlyIfDead) expect(command).not.toMatch(/respawn-pane\s+-k\b/);
      } finally { nonTestManager.destroy(); }
    });

    it.each([false, true])('emits workerAttachOnly=%s in the actual canonical respawn command only for this call', async workerAttachOnly => {
      vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/fixture/worker.sock');
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({ sessionId: 'viewer1234', muxName: 'reverie-abcd1234', pid: 1000,
        createdAt: Date.now(), workingDir: '/tmp', mode: 'shell', attached: true });
      try {
        expect(await nonTestManager.respawnPane({ sessionId: 'viewer1234', workingDir: '/tmp', mode: 'shell',
          onlyIfDead: true, workerAttachOnly })).toBe(4242);
        const { exec: currentExec } = await import('node:child_process');
        const command = String(vi.mocked(currentExec).mock.calls.find(([cmd]) => String(cmd).includes(' respawn-pane '))?.[0]);
        expect(command).toContain('reverie-worker-exec');
        expect(command.includes('--attach-only')).toBe(workerAttachOnly);
        expect(command).not.toMatch(/respawn-pane\s+-k\b/);
      } finally { nonTestManager.destroy(); }
    });

    it('returns failure without retrying forcefully when tmux refuses a pane that became live', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'recovery5678', muxName: 'reverie-abcd5678', pid: 1000,
        createdAt: Date.now(), workingDir: '/tmp', mode: 'shell', attached: true,
      });
      const { exec: currentExec } = await import('node:child_process');
      const previousExec = vi.mocked(currentExec).getMockImplementation();
      vi.mocked(currentExec).mockImplementation((cmd, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        if (typeof callback === 'function') setImmediate(() => callback(String(cmd).includes(' respawn-pane ') ? new Error('pane is not dead') : null, '', ''));
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 } as never;
      });
      try {
        expect(await nonTestManager.respawnPane({ sessionId: 'recovery5678', workingDir: '/tmp', mode: 'shell', onlyIfDead: true })).toBeNull();
        const commands = vi.mocked(currentExec).mock.calls.filter(([cmd]) => String(cmd).includes(' respawn-pane '));
        expect(commands).toHaveLength(1);
        expect(commands[0][0]).not.toMatch(/respawn-pane\s+-k\b/);
      } finally {
        vi.mocked(currentExec).mockImplementation(previousExec!);
        nonTestManager.destroy();
      }
    });

    it('unsets retired env keys on the tmux session BEFORE re-applying the live overrides', async () => {
      // `tmux setenv` persists at the session level and is inherited by `respawn-pane`, so
      // a key that merely disappears from envOverrides comes back in the relaunched CLI
      // (measured: `setenv FOO bar` survived two `respawn-pane -k`). Clearing a custom-model
      // selection names the keys to drop; a key both dropped and re-set must end up SET.
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'respawn5678',
        muxName: 'reverie-abcd5678',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: false,
      });

      try {
        const pid = await nonTestManager.respawnPane({
          sessionId: 'respawn5678',
          workingDir: '/tmp',
          mode: 'shell',
          envOverrides: { CLAUDE_CODE_KEEP: '1', ANTHROPIC_API_KEY: 'again' },
          unsetEnvKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'not-a-key; rm -rf /'],
        });
        expect(pid).toBe(4242);

        const setenvCalls = mockedExecSync.mock.calls
          .map(([cmd]) => cmd)
          .filter((cmd): cmd is string => typeof cmd === 'string' && cmd.includes(" setenv -t 'reverie-abcd5678'"));
        const unsetBase = setenvCalls.findIndex((cmd) => cmd.endsWith(' -u ANTHROPIC_BASE_URL'));
        const unsetKey = setenvCalls.findIndex((cmd) => cmd.endsWith(' -u ANTHROPIC_API_KEY'));
        const setKeep = setenvCalls.findIndex((cmd) => cmd.includes(' CLAUDE_CODE_KEEP '));
        const setKey = setenvCalls.findIndex((cmd) => cmd.includes(' ANTHROPIC_API_KEY ') && !cmd.includes(' -u '));
        expect(unsetBase).toBeGreaterThanOrEqual(0);
        expect(unsetKey).toBeGreaterThanOrEqual(0);
        expect(setKeep).toBeGreaterThan(unsetBase);
        // Re-set AFTER its own unset, so the live value wins.
        expect(setKey).toBeGreaterThan(unsetKey);
        // The shell-metachar key never reaches tmux at all.
        expect(setenvCalls.some((cmd) => cmd.includes('rm -rf'))).toBe(false);
      } finally {
        nonTestManager.destroy();
      }
    });
  });
});

// ============================================================================
// Parser Tests — locks in the '|' separator contract for `tmux list-panes -F`
// output, guarding against regressions in non-tty execution contexts where
// `\t` in tmux FORMAT strings can be emitted as the literal two characters
// `\` + `t` instead of a tab byte (launchd, systemd without TTYPath, docker
// exec without TTY). See PR #71.
// ============================================================================

describe('parsePaneRows', () => {
  /** Pull the name → pid map reconciliation builds, so these cases read as they used to. */
  const pids = (output: string) => new Map(parsePaneRows(output).map((row) => [row.sessionName, row.pid]));

  it('parses well-formed output into name → pid', () => {
    const out = 'reverie-aaaa|1234\nreverie-bbbb|5678\nclaudeman-cccc|9999';
    const result = pids(out);
    expect(result.size).toBe(3);
    expect(result.get('reverie-aaaa')).toBe(1234);
    expect(result.get('reverie-bbbb')).toBe(5678);
    expect(result.get('claudeman-cccc')).toBe(9999);
  });

  it('returns no rows for empty output', () => {
    expect(parsePaneRows('')).toEqual([]);
  });

  it('skips blank lines', () => {
    const result = pids('\nreverie-aaaa|100\n\n\nreverie-bbbb|200\n');
    expect(result.size).toBe(2);
    expect(result.get('reverie-aaaa')).toBe(100);
    expect(result.get('reverie-bbbb')).toBe(200);
  });

  it('skips lines without the separator', () => {
    const result = pids('reverie-aaaa 1234\nreverie-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('reverie-bbbb')).toBe(5678);
  });

  it('skips lines with a non-numeric pid', () => {
    const result = pids('reverie-aaaa|notapid\nreverie-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('reverie-bbbb')).toBe(5678);
  });

  it('skips lines with an empty session name', () => {
    const result = pids('|1234\nreverie-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('reverie-bbbb')).toBe(5678);
  });

  it('treats a literal backslash-t in input as part of the session name, not a delimiter', () => {
    // Reproduces the launchd/systemd regression: under non-tty contexts tmux
    // was emitting FORMAT '\t' as the two characters `\` + `t` rather than a
    // tab byte. With the '|' separator, such literals must not be silently
    // treated as a delimiter — the line is discarded because there is no '|'.
    const literalBackslashT = 'reverie-aaaa\\t1234';
    expect(parsePaneRows(literalBackslashT)).toEqual([]);
  });

  it('keeps a row whose pane_dead fields are missing, and calls its deadness unknown', () => {
    // A tmux old enough to have shipped the previous two-field format, or one
    // that dropped the trailing fields, must still yield its pid.
    const [row] = parsePaneRows('reverie-aaaa|1234');
    expect(row.pid).toBe(1234);
    expect(row.dead).toBeUndefined();
    expect(row.exitStatus).toBeUndefined();
    expect(row.exitSignal).toBeUndefined();
  });

  it('reads a live pane as not dead, with no status or signal', () => {
    // Measured against tmux 3.2a: a live pane leaves both numeric fields blank.
    const [row] = parsePaneRows('reverie-aaaa|1234|0|||1');
    expect(row.dead).toBe(false);
    expect(row.exitStatus).toBeUndefined();
    expect(row.exitSignal).toBeUndefined();
  });

  it('reads a dead pane with its exit status', () => {
    const [row] = parsePaneRows('reverie-aaaa|1234|1|7|');
    expect(row.dead).toBe(true);
    expect(row.exitStatus).toBe(7);
    expect(row.exitSignal).toBeUndefined();
  });

  it('reads a dead pane with its killing signal', () => {
    const [row] = parsePaneRows('reverie-aaaa|1234|1||9');
    expect(row.dead).toBe(true);
    expect(row.exitStatus).toBeUndefined();
    expect(row.exitSignal).toBe(9);
  });

  it('leaves a status of 0 as 0 rather than dropping it', () => {
    // The whole point of the field: a clean exit is the case part 2 acts on.
    const [row] = parsePaneRows('reverie-aaaa|1234|1|0|');
    expect(row.exitStatus).toBe(0);
  });

  it('still reads the pid when a trailing field is junk', () => {
    // Carried over from the retired parsePaneList case 'splits on the first separator only'.
    expect(pids('reverie-aaaa|1234|extra-field').get('reverie-aaaa')).toBe(1234);
  });

  it('calls a non-numeric dead flag unknown rather than false', () => {
    const [row] = parsePaneRows('reverie-aaaa|1234|?||');
    expect(row.dead).toBeUndefined();
  });

  it('returns one row per pane of a split session, in tmux order', () => {
    const rows = parsePaneRows('reverie-aaaa|100|0|||\nreverie-aaaa|200|1|0|');
    expect(rows.map((row) => row.pid)).toEqual([100, 200]);
    expect(rows.map((row) => row.sessionName)).toEqual(['reverie-aaaa', 'reverie-aaaa']);
  });
});

describe('derivePaneExits', () => {
  const NOW = 1_700_000_000_000;

  it('reports a single dead pane with its exit status', () => {
    const exits = derivePaneExits(parsePaneRows('reverie-aaaa|1234|1|0|'), NOW);
    expect(exits.get('reverie-aaaa')).toEqual({ panePid: 1234, exit: { status: 0, at: NOW } });
  });

  it('reports a signalled death without inventing a status', () => {
    // Folding an absent status into 0 would turn an unexplained death into the
    // clean exit part 2 closes on sight.
    const exits = derivePaneExits(parsePaneRows('reverie-aaaa|1234|1||9'), NOW);
    expect(exits.get('reverie-aaaa')).toEqual({ panePid: 1234, exit: { signal: 9, at: NOW } });
  });

  it('reports a death tmux could not explain at all', () => {
    // Measured on tmux 3.2a: a SIGKILLed pane reports pane_dead=1 and nothing else.
    const exits = derivePaneExits(parsePaneRows('reverie-aaaa|1234|1||'), NOW);
    expect(exits.get('reverie-aaaa')).toEqual({ panePid: 1234, exit: { at: NOW } });
  });

  it('says nothing about a live pane', () => {
    const exits = derivePaneExits(parsePaneRows('reverie-aaaa|1234|0|||'), NOW);
    expect(exits.has('reverie-aaaa')).toBe(false);
  });

  it('says nothing about a pane whose deadness tmux did not report', () => {
    expect(derivePaneExits(parsePaneRows('reverie-aaaa|1234'), NOW).size).toBe(0);
  });

  it('says nothing about a session with more than one pane, even when all are dead', () => {
    // A session the user split by hand has no single "the agent" to report on,
    // and guessing which pane speaks for it could call a live session exited.
    const exits = derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|\nreverie-aaaa|200|1|0|'), NOW);
    expect(exits.size).toBe(0);
  });

  it("answers per session, so one session's split does not silence another", () => {
    const exits = derivePaneExits(
      parsePaneRows('reverie-aaaa|100|1|0|\nreverie-bbbb|200|1|0|\nreverie-bbbb|201|0|||'),
      NOW
    );
    expect([...exits.keys()]).toEqual(['reverie-aaaa']);
  });
});

describe('TmuxManager pane-exit bookkeeping', () => {
  const NOW = 1_700_000_000_000;

  it('reports nothing before any tick has run', () => {
    const manager = new TmuxManager();
    expect(manager.getPaneExit('reverie-aaaa')).toBeUndefined();
  });

  it('keeps the timestamp of the FIRST tick that saw an unchanged exit', () => {
    // The stamp says when the agent was found gone, so a pane that stays dead
    // must not have its age reset every two seconds.
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW + 2000));
    expect(manager.getPaneExit('reverie-aaaa')).toEqual({ status: 0, at: NOW });
  });

  it('starts a new observation when the exit status changes', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|137|'), NOW + 2000));
    expect(manager.getPaneExit('reverie-aaaa')).toEqual({ status: 137, at: NOW + 2000 });
  });

  it('forgets the exit once the same session reports a live pane', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|101|0|||'), NOW + 2000));
    expect(manager.getPaneExit('reverie-aaaa')).toBeUndefined();
  });

  it('prunes an exit for a session an authoritative read did not mention', () => {
    // `list-panes -a` lists every pane on the socket, so a session missing from
    // a successful read has no pane at all and no exit to report. Keeping the
    // entry would grow the map forever as tmux sessions come and go outside
    // killSession(). A FAILED or empty read never reaches here — refreshPaneExits
    // returns before calling this, which is the case the next test covers.
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-bbbb|200|1|0|'), NOW));
    expect(manager.getPaneExit('reverie-aaaa')).toBeUndefined();
    expect(manager.getPaneExit('reverie-bbbb')).toEqual({ status: 0, at: NOW });
  });

  it('starts a new observation when the same status comes from a different pane pid', () => {
    // A second command in the same pane that also exited 0 is a NEW death, and
    // its `at` must say so. Only reachable when the respawn bypassed
    // respawnPane() — a hand-run `tmux respawn-pane` — since every Reverie path
    // clears the entry outright.
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|101|1|0|'), NOW + 60_000));
    expect(manager.getPaneExit('reverie-aaaa')).toEqual({ status: 0, at: NOW + 60_000 });
  });

  it('forgets an exit on request, which is what a respawned pane needs', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.clearPaneExit('reverie-aaaa');
    expect(manager.getPaneExit('reverie-aaaa')).toBeUndefined();
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(0);
  });

  // The clean-exit sweep closes a session only once two reads agreed on its
  // exit (Ark0N/Codeman#446), so the count must rise only on an exact repeat.
  it('counts the reads that agreed on one exit', () => {
    const manager = new TmuxManager();
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(0);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(1);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW + 2000));
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(2);
  });

  it('starts the count again when the status or the pane pid changes', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW + 2000));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|1|'), NOW + 4000));
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(1);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|101|1|1|'), NOW + 6000));
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(1);
  });

  it('drops the count once a read sees the pane alive again', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|101|0|||'), NOW + 2000));
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(0);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('reverie-aaaa|101|1|0|'), NOW + 4000));
    expect(manager.getPaneExitReadCount('reverie-aaaa')).toBe(1);
  });
});

describe('the pane-exit watcher tick', () => {
  // Every guard in `refreshPaneExits()` used to be unreachable: the method
  // began with `if (IS_TEST_MODE) return;`, so deleting the generation check,
  // the in-flight suppression, the empty-read rule or the read gate left the
  // whole suite green. The tmux read now sits alone in `readPaneRows()`, which
  // a subclass can answer for.
  const NOW = 1_700_000_000_000;

  class TestManager extends TmuxManager {
    rows: PaneRow[] = [];
    reads = 0;
    /** While true, a read parks until releaseAll(), so a test can hold one in flight. */
    hold = false;
    private pending: (() => void)[] = [];

    protected override async readPaneRows(): Promise<PaneRow[]> {
      this.reads++;
      // Every parked read is tracked, not just the latest: with the in-flight
      // guard removed a second one starts, and a harness that could release
      // only the last would deadlock instead of failing.
      if (this.hold) await new Promise<void>((resolve) => this.pending.push(resolve));
      return this.rows;
    }

    releaseAll(): void {
      this.hold = false;
      for (const resolve of this.pending.splice(0)) resolve();
    }
  }

  const localSession = (sessionId = 's1'): MuxSession =>
    ({
      sessionId,
      muxName: `reverie-${sessionId}`,
      pid: 100,
      createdAt: 0,
      workingDir: '/tmp',
      mode: 'claude',
      attached: true,
    }) as MuxSession;

  const withLocalSession = () => {
    const manager = new TestManager();
    manager.registerSession(localSession());
    return manager;
  };

  it('does not read tmux when no session could answer', async () => {
    const manager = new TestManager();
    await manager.refreshPaneExits(NOW);
    expect(manager.reads).toBe(0);
  });

  it('reads tmux once a local session exists', async () => {
    const manager = withLocalSession();
    manager.rows = parsePaneRows('reverie-s1|100|1|0|');
    await manager.refreshPaneExits(NOW);
    expect(manager.reads).toBe(1);
    expect(manager.getPaneExit('reverie-s1')).toEqual({ status: 0, at: NOW });
  });

  it('suppresses a second read while one is still in flight', async () => {
    // EXEC_TIMEOUT_MS is 5000 against a 2000 ms tick, so a slow read outlives
    // two ticks; without this the older one can resolve last and win.
    const manager = withLocalSession();
    manager.hold = true;
    const first = manager.refreshPaneExits(NOW);
    const second = manager.refreshPaneExits(NOW);
    const reads = manager.reads;
    manager.releaseAll();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
  });

  it('retracts nothing when the read comes back empty', async () => {
    // An empty read is "tmux did not answer". Retracting there would turn a
    // transient failure into a silent denial of a death already observed.
    const manager = withLocalSession();
    manager.rows = parsePaneRows('reverie-s1|100|1|137|');
    await manager.refreshPaneExits(NOW);
    manager.rows = [];
    await manager.refreshPaneExits(NOW + 2000);
    expect(manager.getPaneExit('reverie-s1')).toEqual({ status: 137, at: NOW });
  });

  it('does not count an empty read as confirming an exit', async () => {
    // The clean-exit sweep closes on the second agreeing read. A read tmux did
    // not answer agrees with nothing, so it must not supply that second read.
    const manager = withLocalSession();
    manager.rows = parsePaneRows('reverie-s1|100|1|0|');
    await manager.refreshPaneExits(NOW);
    manager.rows = [];
    await manager.refreshPaneExits(NOW + 2000);
    expect(manager.getPaneExitReadCount('reverie-s1')).toBe(1);
    manager.rows = parsePaneRows('reverie-s1|100|1|0|');
    await manager.refreshPaneExits(NOW + 4000);
    expect(manager.getPaneExitReadCount('reverie-s1')).toBe(2);
  });

  it('discards a read that started before the pane was cleared', async () => {
    // The guard that stops an in-flight read from republishing a death over
    // the pane that has just replaced it.
    const manager = withLocalSession();
    manager.rows = parsePaneRows('reverie-s1|100|1|0|');
    manager.hold = true;
    const pending = manager.refreshPaneExits(NOW);
    manager.clearPaneExit('reverie-s1');
    manager.releaseAll();
    await pending;
    expect(manager.getPaneExit('reverie-s1')).toBeUndefined();
  });

  it('announces each tick so the server can publish it', async () => {
    // Losing this emit, or the server's own startPaneExitWatcher() call,
    // disables the whole feature with nothing failing.
    vi.useFakeTimers();
    try {
      const manager = withLocalSession();
      manager.rows = parsePaneRows('reverie-s1|100|1||9');
      const updates: number[] = [];
      manager.on('paneExitsUpdated', () => updates.push(1));
      manager.startPaneExitWatcher(10);
      await vi.advanceTimersByTimeAsync(25);
      manager.stopPaneExitWatcher();
      expect(updates.length).toBeGreaterThan(0);
      expect(manager.getPaneExit('reverie-s1')).toMatchObject({ signal: 9 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hasObservablePaneSession', () => {
  // The pane-exit watcher is always-on, so a tick with nothing to observe is
  // the normal case on an instance running only remote or Docker work. This
  // predicate is what keeps that tick from exec'ing tmux to find out.
  const base = {
    sessionId: 's1',
    muxName: 'reverie-aaaa',
    pid: 100,
    createdAt: 0,
    workingDir: '/tmp',
    mode: 'claude' as const,
    attached: true,
  };

  it('says no for an empty manager', () => {
    expect(hasObservablePaneSession([])).toBe(false);
  });

  it('says yes for a local session, which is the whole reason the watcher runs', () => {
    expect(hasObservablePaneSession([base])).toBe(true);
  });

  it('says no for a remote session, whose local pane holds the ssh client', () => {
    expect(hasObservablePaneSession([{ ...base, remote: { host: 'box', user: 'me' } }])).toBe(false);
  });

  it('says no for a Docker case, whose local pane holds a `docker exec`', () => {
    expect(hasObservablePaneSession([{ ...base, docker: { containerName: 'c1' } }])).toBe(false);
  });

  it('says no for a record rebuilt from the socket, which carries no provenance', () => {
    // `reconcileSessions()` gives it a synthetic id that matches no state.json
    // entry, so a remote session rediscovered that way looks local. Session
    // forces UNKNOWN for it, so reading tmux for it buys nothing.
    expect(hasObservablePaneSession([{ ...base, discovered: true }])).toBe(false);
  });

  it('says yes when one local session sits among sessions that cannot answer', () => {
    // The read is one batched call for the whole socket, so a single local
    // session is enough to make the tick worth paying for.
    expect(
      hasObservablePaneSession([
        { ...base, sessionId: 's1', remote: { host: 'box', user: 'me' } },
        { ...base, sessionId: 's2', discovered: true },
        { ...base, sessionId: 's3' },
      ])
    ).toBe(true);
  });

  // The predicate has to agree with `Session.paneExitApplies`, which is where
  // the rule is enforced; that pairing is pinned in session-pane-exit.test.ts,
  // where a real Session can answer for itself.
});
