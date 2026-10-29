import { afterEach, describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';
import { deliverRecoveryPrompt, submitRecoveryPrompt } from '../src/company-recovery-prompt.js';
import { placeholderHoldsPrompt } from '../src/session-submit-verifier.js';

function fixture() {
  const session = {
    mode: 'claude',
    pid: 42 as number | null,
    paneDialog: null as string | null,
    isWorking: false,
    terminalBuffer: '',
    writeViaMux: vi.fn(async (_text, options) => {
      options.onOutcome('submitted');
      return true;
    }),
  };
  return session;
}
describe('crash recovery kickoff delivery', () => {
  it('recognizes a handoff split into several CLI paste placeholders by the laptop transport', () => {
    const composer = '[Pasted Content 1024 chars][Pasted Content 1016 chars]';
    expect(placeholderHoldsPrompt(composer, 'x'.repeat(2040))).toBe(false); // Counts alone are not ownership.
    expect(placeholderHoldsPrompt(composer, 'x'.repeat(2040), true)).toBe(true); // Observed empty-before-write.
    expect(placeholderHoldsPrompt(composer, 'x'.repeat(3000), true)).toBe(false);
  });
  it('keeps one handoff submission alive through a slow CLI startup without typing the body twice', async () => {
    const session = fixture();
    let outcome: (value: 'submitted') => void = () => {};
    session.writeViaMux.mockImplementation(async (_text, options) => { outcome = options.onOutcome; return true; });
    let seconds = 0;
    await submitRecoveryPrompt(session, 'Saved handoff', () => true, async () => {
      if (++seconds === 50) outcome('submitted');
    });
    expect(seconds).toBe(50);
    expect(session.writeViaMux).toHaveBeenCalledTimes(1);
  });
  it('waits for composer readiness, then verifies one submission into the same pane', async () => {
    const session = fixture();
    const sleep = vi.fn(async () => {
      session.terminalBuffer = 'shift+tab';
    });
    await deliverRecoveryPrompt(session, 'Restore\norganization', () => true, sleep);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(session.writeViaMux).toHaveBeenCalledTimes(1);
    expect(session.writeViaMux.mock.calls[0][0]).toBe('Restore organization\r');
  });
  it('never types into startup dialogs even when a readiness footer is visible', async () => {
    const session = fixture();
    session.terminalBuffer = 'shift+tab';
    session.paneDialog = 'Enter to continue';
    await expect(
      deliverRecoveryPrompt(
        session,
        'Restore',
        () => true,
        async () => {}
      )
    ).rejects.toThrow('did not become ready');
    expect(session.writeViaMux).not.toHaveBeenCalled();
  });
  it('cancels if the owner changes selection or stops the expert while readiness is awaited', async () => {
    const session = fixture();
    let allowed = true;
    await expect(
      deliverRecoveryPrompt(
        session,
        'Restore',
        () => allowed,
        async () => {
          allowed = false;
        }
      )
    ).rejects.toThrow('canceled');
    expect(session.writeViaMux).not.toHaveBeenCalled();
  });
  it('never pastes the body twice when submission is unverified', async () => {
    const session = fixture();
    session.terminalBuffer = 'shift+tab';
    session.writeViaMux.mockImplementation(async (_text, options) => {
      options.onOutcome('unverified');
      return true;
    });
    await expect(
      deliverRecoveryPrompt(
        session,
        'Restore',
        () => true,
        async () => {}
      )
    ).rejects.toThrow('not confirmed');
    expect(session.writeViaMux).toHaveBeenCalledTimes(1);
  });
});

const CODEX_FOOTER = 'GPT-6.1-Sol high · /owned/recovery-fixture';
const codexPane = (body: string) => `› ${body}\n\n${CODEX_FOOTER}\n? for shortcuts`;
const ownedSessions: Session[] = [];
function realRecoverySession(initial = '') {
  let pane = codexPane(initial);
  const writes: string[] = [];
  const session = new Session({ mode: 'codex', workingDir: '/owned/recovery-fixture' });
  ownedSessions.push(session);
  const mux = {
    capturePaneText: () => pane,
    sendInput: vi.fn(async (_id: string, data: string) => {
      writes.push(data);
      if (data === '\r') pane = codexPane('');
      else pane = codexPane(`[Pasted Content ${data.replace(/\r/g, '').length} chars]`);
      return true;
    }),
  };
  Object.assign(session, { _pid: 42, _mux: mux, _muxSession: { muxName: 'owned-recovery', pid: 42 } });
  vi.spyOn(session as any, '_recheckPaneDialogSoon').mockImplementation(() => {});
  return { session, writes, mux, pane: () => pane, setPane: (body: string) => { pane = codexPane(body); } };
}
afterEach(() => {
  for (const session of ownedSessions.splice(0)) (session as any)._submitVerifier?.cancel();
  vi.useRealTimers();
});

describe('actual Session recovery submission ownership', () => {
  it('refuses an occupied candidate draft before any recovery text or Enter', async () => {
    const f = realRecoverySession('existing owner draft');
    const before = f.pane();
    await expect(submitRecoveryPrompt(f.session, 'approved handoff', () => true, async () => {}, { fromUser: true }))
      .rejects.toThrow('could not be typed');
    expect(f.writes).toEqual([]); expect(f.pane()).toBe(before); expect(f.session.lastSubmitAt).toBe(0);
  });
  it('observes a genuine empty composer before typing one opaque handoff and verifies its empty transition', async () => {
    vi.useFakeTimers(); const f = realRecoverySession(); const text = 'x'.repeat(2040);
    await submitRecoveryPrompt(f.session, text, () => true, async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.writes.filter(value => value !== '\r')).toEqual([text + '\r']);
    expect(f.writes.filter(value => value === '\r')).toHaveLength(1);
    expect(f.pane()).toBe(codexPane(''));
  });
  it('does not retry Enter or paste again if a user changes the composer after the handoff write', async () => {
    vi.useFakeTimers(); const f = realRecoverySession(); let ticks = 0;
    await expect(submitRecoveryPrompt(f.session, 'x'.repeat(2040), () => true, async () => {
      if (++ticks === 1) f.setPane('new owner draft');
      await vi.advanceTimersByTimeAsync(1000);
    })).rejects.toThrow('not confirmed');
    expect(f.writes).toHaveLength(1); expect(f.pane()).toBe(codexPane('new owner draft'));
  });
});
