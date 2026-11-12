import { describe, expect, it } from 'vitest';
import { captureClaudeLaunch } from './helpers/capture-claude-launch.js';

describe('synthetic provider launch evidence', () => {
  it('records exact provider argv without invoking a real model', () => {
    expect(captureClaudeLaunch("claude --model 'synthetic model' --name 'quoted λ'")).toEqual([
      '--model',
      'synthetic model',
      '--name',
      'quoted λ',
    ]);
  });
  it('refuses a duplicate provider invocation', () => {
    expect(() => captureClaudeLaunch('claude first; claude second')).toThrow(
      'Synthetic launch must invoke exactly one provider'
    );
  });
  it.each(['printf unexpected; claude', 'claude; exit 1', 'kill -TERM $$'])(
    'refuses incomplete or noisy evidence: %s',
    (command) => {
      expect(() => captureClaudeLaunch(command)).toThrow('Synthetic launch did not complete cleanly');
    }
  );
  it('rejects a transcript fixture escaping its private account namespace', () => {
    expect(() => captureClaudeLaunch('claude', '../other')).toThrow('Invalid synthetic transcript identity');
  });
});
