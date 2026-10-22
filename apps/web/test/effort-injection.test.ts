/**
 * @fileoverview Tests for Claude CLI effort level injection.
 *
 * Effort must flow as a `--settings` SOFT default (overridable in-session via
 * /effort, incl. ultracode) — never as the CLAUDE_CODE_EFFORT_LEVEL env var,
 * which hard-locks the session. Also covers the legacy migration path: old
 * persisted sessions carried effort inside __envOverrides.
 */

import { describe, it, expect } from 'vitest';
import { buildEffortCliArgs, buildInteractiveArgs } from '../src/session-cli-builder.js';
import { isEffortLevel, EFFORT_LEVELS } from '../src/types.js';
import { Session } from '../src/session.js';

describe('buildEffortCliArgs', () => {
  it('maps regular levels (incl. max) to the --effort flag', () => {
    // NOT the settings effortLevel key: its enum lacks "max" and silently drops it
    expect(buildEffortCliArgs('low')).toEqual(['--effort', 'low']);
    expect(buildEffortCliArgs('high')).toEqual(['--effort', 'high']);
    expect(buildEffortCliArgs('xhigh')).toEqual(['--effort', 'xhigh']);
    expect(buildEffortCliArgs('max')).toEqual(['--effort', 'max']);
  });

  it('maps ultracode to its dedicated --settings boolean key', () => {
    // The --effort flag rejects ultracode; only the settings key enables it at spawn
    expect(buildEffortCliArgs('ultracode')).toEqual(['--settings', '{"ultracode":true}']);
  });

  it('returns empty args for missing or invalid values', () => {
    expect(buildEffortCliArgs(undefined)).toEqual([]);
    // Invalid strings must not reach the shell command (injection guard)
    expect(buildEffortCliArgs('"; rm -rf /' as never)).toEqual([]);
    expect(buildEffortCliArgs('turbo' as never)).toEqual([]);
  });

  it('produces a flag/value pair for every allowed level', () => {
    for (const level of EFFORT_LEVELS) {
      const args = buildEffortCliArgs(level);
      expect(args).toHaveLength(2);
      expect(args[0]).toMatch(/^--(effort|settings)$/);
    }
  });
});

describe('isEffortLevel', () => {
  it('accepts all defined levels and rejects everything else', () => {
    for (const level of EFFORT_LEVELS) {
      expect(isEffortLevel(level)).toBe(true);
    }
    expect(isEffortLevel(undefined)).toBe(false);
    expect(isEffortLevel('')).toBe(false);
    expect(isEffortLevel('ULTRACODE')).toBe(false);
  });
});

describe('buildInteractiveArgs with effort', () => {
  it('appends --settings for ultracode', () => {
    const args = buildInteractiveArgs('sid-123', 'dangerously-skip-permissions', undefined, undefined, 'ultracode');
    const idx = args.indexOf('--settings');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('{"ultracode":true}');
  });

  it('appends --effort for max', () => {
    const args = buildInteractiveArgs('sid-123', 'dangerously-skip-permissions', undefined, undefined, 'max');
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('max');
  });

  it('omits effort args when effort is absent', () => {
    const args = buildInteractiveArgs('sid-123', 'dangerously-skip-permissions');
    expect(args).not.toContain('--settings');
    expect(args).not.toContain('--effort');
  });
});

describe('Session effort handling', () => {
  it('stores explicit effort and exposes it in toState()', () => {
    const session = new Session({ workingDir: '/tmp', effort: 'ultracode' });
    expect(session.toState().effort).toBe('ultracode');
  });

  it('migrates legacy CLAUDE_CODE_EFFORT_LEVEL out of envOverrides', () => {
    const session = new Session({
      workingDir: '/tmp',
      envOverrides: {
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
    });
    // Legacy env var becomes the soft-default effort...
    expect(session.toState().effort).toBe('high');
    // ...and is never persisted (or exported) as an env var again
    expect(session.getEnvOverridesForPersist()).toEqual({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });
  });

  it('drops an invalid legacy effort value instead of forwarding it', () => {
    const session = new Session({
      workingDir: '/tmp',
      envOverrides: { CLAUDE_CODE_EFFORT_LEVEL: 'bogus-value' },
    });
    expect(session.toState().effort).toBeUndefined();
    expect(session.getEnvOverridesForPersist()).toBeUndefined();
  });

  it('prefers explicit effort over the legacy env var', () => {
    const session = new Session({
      workingDir: '/tmp',
      effort: 'ultracode',
      envOverrides: { CLAUDE_CODE_EFFORT_LEVEL: 'low' },
    });
    expect(session.toState().effort).toBe('ultracode');
  });

  it('leaves effort undefined when nothing is configured', () => {
    const session = new Session({ workingDir: '/tmp' });
    expect(session.toState().effort).toBeUndefined();
  });
});
