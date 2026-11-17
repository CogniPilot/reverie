import { registeredMuxFixture } from './helpers/registered-mux-fixture.js';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';
import { deliverRecoveryPrompt, submitRecoveryPrompt, recoveryComposerReady } from '../src/company-recovery-prompt.js';
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
  const registry = registeredMuxFixture({mode: 'codex', sessionId: session.id, muxName: 'owned-recovery', pid: 42, owner: session.owner});
  const mux = {...registry,
    capturePaneText: () => pane,
    sendInput: vi.fn(async (_id: string, data: string, _options?: {admitted?: () => boolean}) => {
      writes.push(data);
      if (data === '\r') pane = codexPane('');
      else pane = codexPane(`[Pasted Content ${data.replace(/\r/g, '').length} chars]`);
      return true;
    }),
  };
  Object.assign(session, { _pid: 42, _mux: mux, _muxSession: registry.subject });
  vi.spyOn(session as unknown as {_recheckPaneDialogSoon(): void}, '_recheckPaneDialogSoon').mockImplementation(() => {});
  return { session, writes, mux, pane: () => pane, setPane: (body: string) => { pane = codexPane(body); } };
}
afterEach(() => {
  for (const session of ownedSessions.splice(0)) (session as unknown as {_submitVerifier?: {cancel(): void}})._submitVerifier?.cancel();
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


it('keeps exact OSC and CSI stripping for fragmented visible composer markers', () => {
  const session = fixture(), escape = String.fromCharCode(27), bell = String.fromCharCode(7);
  for (const buffer of [
    'rea' + escape + '[31mdy',
    'rea' + escape + ']0;window title' + bell + 'dy',
    'rea' + escape + ']0;window title' + escape + '\\' + 'dy',
  ]) {
    session.terminalBuffer = buffer;
    expect(recoveryComposerReady(session, 'ready')).toBe(true);
  }
  session.terminalBuffer = escape + ']0;ready' + bell;
  expect(recoveryComposerReady(session, 'ready')).toBe(false);
});


it('recognizes the real Codex footer across a charset selection without granting busy or dialog readiness', () => {
  const session = fixture();
  session.mode = 'codex';
  // Actual terminal history: tmux selects the default character set between the
  // question mark and the following styled text; it displays no literal "(B".
  session.terminalBuffer = '\x1b[1m?\x1b(B\x1b[m for shortcuts';
  expect(recoveryComposerReady(session, '? for shortcuts')).toBe(true);
  session.isWorking = true;
  expect(recoveryComposerReady(session, '? for shortcuts')).toBe(false);
  session.isWorking = false;
  session.paneDialog = 'Approval required';
  expect(recoveryComposerReady(session, '? for shortcuts')).toBe(false);
});

it.each([
  '\x1b(B',
  '\x1b)0',
  '\x1b[31m',
  '\x1b[1 q',
  '\x1b]0;title\x07',
  '\x1b]0;title\x1b\\',
  '\x1bPpayload\x1b\\',
  '\x1b^payload\x1b\\',
])('ignores a complete presentation sequence inside the composer marker: %j', (control) => {
  const session = fixture();
  session.terminalBuffer = '?' + control + ' for shortcuts';
  expect(recoveryComposerReady(session, '? for shortcuts')).toBe(true);
});

it.each([
  '?\x1b( for shortcuts',
  '?\x1b[31 for shortcuts',
  '?\x1b\x01 for shortcuts',
  '\x1b]0;? for shortcuts',
  '\x1bP? for shortcuts',
  '\x1b]0;title\x1b[31m? for shortcuts',
  '? for shortcuts\x1b',
  '? for shortcuts\x1b[31',
  '? for shortcuts\x1b(',
])('holds readiness for incomplete or unknown control bytes: %j', (terminalBuffer) => {
  const session = fixture();
  session.terminalBuffer = terminalBuffer;
  expect(recoveryComposerReady(session, '? for shortcuts')).toBe(false);
});

it.each(['\x1b]0;? for shortcuts\x07', '\x1bP? for shortcuts\x1b\\'])(
  'never treats a marker inside control-string contents as visible: %j',
  (terminalBuffer) => {
    const session = fixture();
    session.terminalBuffer = terminalBuffer;
    expect(recoveryComposerReady(session, '? for shortcuts')).toBe(false);
  }
);

it('keeps the null-PID delivery boundary even with a normalized ready marker', async () => {
  const session = fixture();
  session.mode = 'codex';
  session.pid = null;
  session.terminalBuffer = '?\x1b(B\x1b[m for shortcuts';
  await expect(
    deliverRecoveryPrompt(
      session,
      'handoff',
      () => true,
      async () => {}
    )
  ).rejects.toThrow('canceled');
  expect(session.writeViaMux).not.toHaveBeenCalled();
});

it('retains the original recovery grant at the actual Session mux dispatch boundary', async () => {
  const f = realRecoverySession();
  let allowed = true,
    entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeKeys: string[] = [];
  f.mux.sendInput.mockImplementation(async (_id, data, options) => {
    entered = true;
    await gate;
    expect(options?.admitted).toBeTypeOf('function');
    if (!options!.admitted!()) return false;
    nativeKeys.push(data);
    return true;
  });
  const pending = submitRecoveryPrompt(f.session, 'approved original handoff', () => allowed);
  await expect.poll(() => entered).toBe(true);
  allowed = false;
  release();
  const refused = await pending.catch((error: unknown) => error);
  expect(nativeKeys).toEqual([]);
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain('could not be typed');
  expect(f.writes).toEqual([]);
});
