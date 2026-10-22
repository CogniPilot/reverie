/**
 * @fileoverview Auto-naming a session after its first prompt (#376).
 *
 * The tracker sits on the raw keystroke stream, so most of these pin the
 * per-key rules that a review of the first cut found missing: a bare Esc ate
 * the next prompt's first character, a wheel report mid-word dropped half the
 * prompt, pasted newlines counted as Enter, and every prompt renamed the tab.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';
import {
  SubmittedPromptTracker,
  deriveAutoSessionName,
  composeAutoSessionName,
  isGeneratedSessionName,
} from '../src/session-auto-name.js';

describe('SubmittedPromptTracker', () => {
  it('reports the draft on Enter across arbitrary chunks, honouring backspace', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('fix the')).toEqual([]);
    expect(tracker.feed(' login bugs\x7f')).toEqual([]);
    expect(tracker.feed('\r')).toEqual(['fix the login bug']);
    expect(tracker.feed('\r')).toEqual([]);
    expect(tracker.feed('修复登录跳转\x08问题\r')).toEqual(['修复登录跳问题']);
  });

  it('treats a bare Esc as the Esc key, not the start of a sequence', () => {
    const tracker = new SubmittedPromptTracker();
    tracker.feed('\x1b');
    expect(tracker.feed('fix the login bug\r')).toEqual(['fix the login bug']);
    tracker.feed('\x1b');
    expect(tracker.feed('修复登录\r')).toEqual(['修复登录']);
    // Esc then digits and punctuation used to grow the escape buffer without bound.
    tracker.feed('\x1b');
    expect(tracker.feed('12345, ok?\r')).toEqual(['12345, ok?']);
    // A double Esc is two Esc keys, each its own write (in ONE chunk, `ESC s`
    // is Alt+s by the terminal's own encoding and stays swallowed).
    tracker.feed('\x1b');
    tracker.feed('\x1b');
    expect(tracker.feed('still here\r')).toEqual(['still here']);
  });

  it('swallows Alt chords and turns Alt+Enter into a newline in the draft', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('fix\x1bb the\x1b\rbug\r')).toEqual(['fix the bug']);
  });

  it('ignores cursor keys, mouse and focus reports, Shift+Tab and Tab', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('fix the \x1b[<64;10;5M\x1b[<65;10;5mlogin bug\r')).toEqual(['fix the login bug']);
    expect(tracker.feed('look at @src/ses\tsion.ts and fix it\r')).toEqual(['look at @src/session.ts and fix it']);
    expect(tracker.feed('typo\x1b[D\x1b[C\x1b[H\x1b[F\x1b[3~\x1b[Z\x1b[I\x1b[O\x1bOC fixed\r')).toEqual(['typo fixed']);
    expect(tracker.feed('mod\x1b[1;5D\x1b[1;2Cifiers\r')).toEqual(['modifiers']);
  });

  it('taints the draft on history recall so Enter submits nothing rather than a fragment', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('old text\x1b[A and more\r')).toEqual([]);
    expect(tracker.feed('\x1bOB\r')).toEqual([]);
    expect(tracker.feed('\x1b[1;5A\r')).toEqual([]);
    expect(tracker.feed('\x10x\r')).toEqual([]);
    expect(tracker.feed('\x12search\r')).toEqual([]);
    expect(tracker.feed('fresh prompt\r')).toEqual(['fresh prompt']);
    // Ctrl+C empties the composer, which also clears the taint.
    expect(tracker.feed('stale\x1b[A\x03typed after\r')).toEqual(['typed after']);
  });

  it('keeps bracketed-paste newlines inside the draft', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('\x1b[200~line one\nline two\r\nline three\x1b[201~ plus typed\r')).toEqual([
      'line one line two line three plus typed',
    ]);
    // A paste split across chunks stays a paste.
    tracker.feed('\x1b[200~first\r');
    expect(tracker.feed('second\x1b[201~\r')).toEqual(['first second']);
  });

  it('joins a Shift+Enter / Ctrl+J newline with a space', () => {
    const tracker = new SubmittedPromptTracker();
    tracker.feed('Fix the login bug');
    tracker.feed('\n');
    expect(tracker.feed('Also add tests.\r')).toEqual(['Fix the login bug Also add tests.']);
  });

  it('mirrors Ctrl+W, Ctrl+U and Ctrl+C', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('fix the bugs\x17bug\r')).toEqual(['fix the bug']);
    expect(tracker.feed('discarded\x15kept\r')).toEqual(['kept']);
    expect(tracker.feed('discarded\x03kept\r')).toEqual(['kept']);
  });

  it('keeps the HEAD of an over-long draft', () => {
    const tracker = new SubmittedPromptTracker();
    const [prompt] = tracker.feed(`${'a'.repeat(9000)}\r`);
    expect(prompt).toHaveLength(8192);
    // Backspaces past the cap consume the overflow before the kept text.
    const [again] = tracker.feed(`${'b'.repeat(8200)}${'\x7f'.repeat(10)}\r`);
    expect(again).toHaveLength(8190);
  });

  it('abandons a malformed escape without eating the text, and taints on an over-long one', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('\x1b[修复\r')).toEqual(['修复']);
    expect(tracker.feed('\x1b]0;window title\x07hello\r')).toEqual(['hello']);
    // Nothing a terminal sends runs past 64 bytes; the tail is garbage, not a title.
    expect(tracker.feed(`\x1b]${'x'.repeat(80)}after\r`)).toEqual([]);
    expect(tracker.feed('next prompt\r')).toEqual(['next prompt']);
  });

  it('resumes a CSI split across chunks', () => {
    const tracker = new SubmittedPromptTracker();
    tracker.feed('abc\x1b[');
    expect(tracker.feed('Ddef\r')).toEqual(['abcdef']);
  });
});

describe('deriveAutoSessionName', () => {
  it('takes the first sentence, drops the full stop, and bounds the length', () => {
    expect(deriveAutoSessionName('Fix the login bug. Also add tests.')).toBe('Fix the login bug');
    expect(deriveAutoSessionName('  修复登录跳转问题。\n不要改数据库')).toBe('修复登录跳转问题');
    expect(deriveAutoSessionName('Why does this crash? It worked before')).toBe('Why does this crash?');
    expect(deriveAutoSessionName('Run v2.0 tests. Then deploy')).toBe('Run v2.0 tests');
    expect(Array.from(deriveAutoSessionName('a'.repeat(200)) ?? '')).toHaveLength(72);
    const cut = deriveAutoSessionName('word '.repeat(40).trim()) ?? '';
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toMatch(/^(word )+word…$/);
  });

  it('does not cut on an abbreviation early in the prompt', () => {
    expect(deriveAutoSessionName('e.g. fix this now')).toBe('e.g. fix this now');
    expect(deriveAutoSessionName('Ok. Fix the login bug')).toBe('Ok. Fix the login bug');
  });

  it('returns null for commands and empties, but not for paths', () => {
    expect(deriveAutoSessionName('/clear')).toBeNull();
    expect(deriveAutoSessionName('/model opus')).toBeNull();
    expect(deriveAutoSessionName('/ralph-loop:ralph-loop')).toBeNull();
    expect(deriveAutoSessionName('! npm test')).toBeNull();
    expect(deriveAutoSessionName('   ')).toBeNull();
    expect(deriveAutoSessionName('/home/me/notes.txt what is this')).toBe('/home/me/notes.txt what is this');
  });

  it('strips control bytes and ANSI before the title is persisted', () => {
    expect(deriveAutoSessionName('\x1b[31m整理项目文档\x1b[0m')).toBe('整理项目文档');
    expect(deriveAutoSessionName('a\x00b\tc')).toBe('a b c');
  });
});

describe('composeAutoSessionName', () => {
  it('keeps the placeholder as a prefix so the case and the counter survive', () => {
    expect(composeAutoSessionName('w3-myapp', 'fix the login bug')).toBe('w3-myapp: fix the login bug');
    expect(composeAutoSessionName('', 'fix the login bug')).toBe('fix the login bug');
  });

  it('honours the rename cap in UTF-16 units', () => {
    const name = composeAutoSessionName('w3-myapp', '😀'.repeat(100), 40);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.startsWith('w3-myapp: ')).toBe(true);
    expect(name.endsWith('…')).toBe(true);
    expect(composeAutoSessionName('x'.repeat(127), 'title', 128)).toBe('x'.repeat(127));
  });

  it('recognises only the generated w/s + number + case form', () => {
    expect(isGeneratedSessionName('w12-my_case-2')).toBe(true);
    expect(isGeneratedSessionName('s1-shell')).toBe(true);
    expect(isGeneratedSessionName('w1-case: fix it')).toBe(false);
    expect(isGeneratedSessionName('alpha')).toBe(false);
  });
});

describe('Session name ownership', () => {
  it('infers placeholder vs manual from the name and persists the source', () => {
    const placeholder = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(placeholder.nameSource).toBe('placeholder');
    expect(placeholder.toState().nameSource).toBe('placeholder');
    expect(new Session({ workingDir: '/tmp' }).nameSource).toBe('placeholder');
    expect(new Session({ workingDir: '/tmp', name: 'my window' }).nameSource).toBe('manual');
    expect(new Session({ workingDir: '/tmp', name: 'w1-demo: fix it' }).nameSource).toBe('manual');
    // The boot restore passes the persisted source, which outranks the inference.
    const recovered = new Session({ workingDir: '/tmp', name: 'w1-demo: fix it', nameSource: 'auto' });
    expect(recovered.nameSource).toBe('auto');
    expect(recovered.applyAutoName('w1-demo: other')).toBe(false);
  });

  it('names once: the first prompt takes it, later prompts and renames do not', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(session.applyAutoName('w1-demo: fix the login bug')).toBe(true);
    expect(session.name).toBe('w1-demo: fix the login bug');
    expect(session.nameSource).toBe('auto');
    expect(session.applyAutoName('w1-demo: 1')).toBe(false);
    expect(session.name).toBe('w1-demo: fix the login bug');

    session.name = 'mine';
    expect(session.nameSource).toBe('manual');
    expect(session.applyAutoName('other')).toBe(false);
    expect(session.name).toBe('mine');
  });

  it('consumes the first prompt even when the composed name is unchanged', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(session.applyAutoName('w1-demo')).toBe(false);
    expect(session.nameSource).toBe('auto');
  });
});

describe('Session promptSubmitted', () => {
  function withFakePty(session: Session): ReturnType<typeof vi.fn> {
    const write = vi.fn();
    (session as unknown as { ptyProcess: { write: typeof write } }).ptyProcess = { write };
    return write;
  }

  it('emits for user input only, after the bytes reached the PTY', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    const prompts: string[] = [];
    session.on('promptSubmitted', (p: string) => prompts.push(p));

    // No PTY yet: the write fails and nothing is reported.
    expect(session.write('lost\r', { fromUser: true })).toBe(false);
    expect(prompts).toEqual([]);

    const write = withFakePty(session);
    expect(session.write('Read @ralph_prompt.md and follow the instructions.\r')).toBe(true);
    expect(prompts).toEqual([]);
    expect(session.write('fix the ', { fromUser: true })).toBe(true);
    expect(session.write('login bug\r', { fromUser: true })).toBe(true);
    expect(prompts).toEqual(['fix the login bug']);
    expect(write).toHaveBeenCalledTimes(3);
    // The pane's last-Enter stamp is kept for EVERY write, user or not.
    expect(session.lastSubmitAt).toBeGreaterThan(0);
  });

  it('never feeds the tracker for a shell session', () => {
    const session = new Session({ workingDir: '/tmp', name: 's1-demo', mode: 'shell' });
    const prompts: string[] = [];
    session.on('promptSubmitted', (p: string) => prompts.push(p));
    withFakePty(session);
    expect(session.write('ls -la\r', { fromUser: true })).toBe(true);
    session.trackUserInput('cd src\r');
    expect(prompts).toEqual([]);
  });

  it('feeds the send-key line feed so a two-line prompt keeps its separator', () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    const prompts: string[] = [];
    session.on('promptSubmitted', (p: string) => prompts.push(p));
    withFakePty(session);
    session.write('Fix the login bug', { fromUser: true });
    session.trackUserInput('\n');
    session.write('Also add tests.\r', { fromUser: true });
    expect(prompts).toEqual(['Fix the login bug Also add tests.']);
  });

  it('reports through writeViaMux only when the mux accepted the input', async () => {
    const session = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    const prompts: string[] = [];
    session.on('promptSubmitted', (p: string) => prompts.push(p));
    const sendInput = vi.fn(async () => false);
    (session as unknown as { _mux: unknown; _muxSession: unknown })._mux = { sendInput };
    (session as unknown as { _mux: unknown; _muxSession: unknown })._muxSession = { sessionId: session.id };

    expect(await session.writeViaMux('dropped\r', { fromUser: true })).toBe(false);
    expect(prompts).toEqual([]);
    sendInput.mockResolvedValue(true);
    expect(await session.writeViaMux('delivered\r', { fromUser: true })).toBe(true);
    expect(prompts).toEqual(['delivered']);
    expect(await session.writeViaMux('/clear\r')).toBe(true);
    expect(prompts).toEqual(['delivered']);
  });
});
