import { describe, it, expect } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';
import {
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_BUFFER_BYTES,
  MIN_TERMINAL_BUFFER_BYTES,
} from '../src/config/terminal-history.js';

describe('SettingsUpdateSchema — terminal history keys', () => {
  it('accepts valid in-range terminal-history settings', () => {
    const res = SettingsUpdateSchema.safeParse({
      terminalScrollbackLines: 100_000,
      tmuxHistoryLimit: 100_000,
      terminalBufferMaxBytes: 32 * 1024 * 1024,
      terminalBufferTrimBytes: 24 * 1024 * 1024,
    });
    expect(res.success).toBe(true);
  });

  it('accepts a settings object that omits the terminal-history keys', () => {
    const res = SettingsUpdateSchema.safeParse({ allowedTools: 'Bash' });
    expect(res.success).toBe(true);
  });

  it('rejects scrollback below the minimum', () => {
    const res = SettingsUpdateSchema.safeParse({ terminalScrollbackLines: MIN_TERMINAL_SCROLLBACK_LINES - 1 });
    expect(res.success).toBe(false);
  });

  it('rejects scrollback above the maximum', () => {
    const res = SettingsUpdateSchema.safeParse({ tmuxHistoryLimit: MAX_TERMINAL_SCROLLBACK_LINES + 1 });
    expect(res.success).toBe(false);
  });

  it('rejects buffer bytes outside the byte bounds', () => {
    expect(SettingsUpdateSchema.safeParse({ terminalBufferMaxBytes: MIN_TERMINAL_BUFFER_BYTES - 1 }).success).toBe(
      false
    );
    expect(SettingsUpdateSchema.safeParse({ terminalBufferMaxBytes: MAX_TERMINAL_BUFFER_BYTES + 1 }).success).toBe(
      false
    );
  });

  it('rejects non-integer values', () => {
    expect(SettingsUpdateSchema.safeParse({ terminalScrollbackLines: 12_345.5 }).success).toBe(false);
  });

  it('rejects trim > max via the cross-field superRefine', () => {
    const res = SettingsUpdateSchema.safeParse({
      terminalBufferMaxBytes: 4 * 1024 * 1024,
      terminalBufferTrimBytes: 8 * 1024 * 1024,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('terminalBufferTrimBytes'))).toBe(true);
    }
  });

  it('allows trim == max', () => {
    const res = SettingsUpdateSchema.safeParse({
      terminalBufferMaxBytes: 8 * 1024 * 1024,
      terminalBufferTrimBytes: 8 * 1024 * 1024,
    });
    expect(res.success).toBe(true);
  });
});
