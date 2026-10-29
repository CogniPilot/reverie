/**
 * OpenCode turns a "!" keystroke into shell mode, and a line typed as one burst of keys can lose its first "!" to it, after which
 * Enter runs the whole line in bash. Chat deliveries and an agent's `send` into an OpenCode pane are typed with a fullwidth "！",
 * can go in as a bracketed paste (opt-in), and clear shell mode before Enter. Claude panes and a person's typing are unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FULLWIDTH_BANG,
  footerShowsShellMode,
  guardShellKey,
  pasteDeliveryEnabled,
  typeIntoOpencode,
  type OpencodeTypingIo,
} from '../src/opencode-input.js';
import { Session } from '../src/session.js';
import { ChatroomDelivery, type DeliverySession } from '../src/chatroom-delivery.js';
import { withWriteGate } from '../src/submit-settle.js';

const SHELL_FOOTER = '  ~/work\n\n  ! ls -la\n\n  esc exit shell mode                      enter send';
const NORMAL_FOOTER = '  Ask anything...\n\n  tab agents  ctrl+p commands';

function io(captures: Array<string | null> = [NORMAL_FOOTER]) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const sleeps: number[] = [];
  let n = 0;
  const fake: OpencodeTypingIo = {
    tmux: async (args, stdin) => void calls.push({ args, ...(stdin === undefined ? {} : { stdin }) }),
    capture: () => captures[Math.min(n++, captures.length - 1)],
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { fake, calls, sleeps };
}
const opts = { target: 'pane1', text: '[Reverie chat "R"] "a" -> you: "hi!"', enter: true, paste: false, buffer: 'reverie-x' };

describe('the shell-mode key guard', () => {
  it('replaces every ASCII ! with the fullwidth one and nothing else', () => {
    expect(guardShellKey('wow! really? yes!!')).toBe(`wow${FULLWIDTH_BANG} really? yes${FULLWIDTH_BANG}${FULLWIDTH_BANG}`);
    expect(guardShellKey('no bang')).toBe('no bang');
    expect(FULLWIDTH_BANG).toBe('！');
  });

  it('recognises the shell-mode footer only at the bottom of the pane', () => {
    expect(footerShowsShellMode(SHELL_FOOTER)).toBe(true);
    expect(footerShowsShellMode(`${SHELL_FOOTER}\n\n`)).toBe(true);
    expect(footerShowsShellMode(NORMAL_FOOTER)).toBe(false);
    expect(footerShowsShellMode(null)).toBe(false);
    // the words far up in the scrollback (someone quoting them) do not count
    expect(footerShowsShellMode(`esc exit shell mode\n${'x\n'.repeat(20)}${NORMAL_FOOTER}`)).toBe(false);
  });

  it('bracketed paste is off unless REVERIE_OPENCODE_PASTE=1', () => {
    expect(pasteDeliveryEnabled({})).toBe(false);
    expect(pasteDeliveryEnabled({ REVERIE_OPENCODE_PASTE: '0' })).toBe(false);
    expect(pasteDeliveryEnabled({ REVERIE_OPENCODE_PASTE: 'true' })).toBe(false);
    expect(pasteDeliveryEnabled({ REVERIE_OPENCODE_PASTE: '1' })).toBe(true);
  });
});

describe('typing into an OpenCode pane', () => {
  it('types the guarded line as keys, then Enter, with no Escape in normal mode', async () => {
    const { fake, calls, sleeps } = io();
    await typeIntoOpencode(fake, opts);
    expect(calls).toEqual([
      { args: ['send-keys', '-t', 'pane1', '-l', `[Reverie chat "R"] "a" -> you: "hi${FULLWIDTH_BANG}"`] },
      { args: ['send-keys', '-t', 'pane1', 'Enter'] },
    ]);
    expect(calls[0].args.join(' ')).not.toContain('!');
    // the keys settle, then the footer is read three times a frame apart
    expect(sleeps).toEqual([50, 50, 50]);
  });

  it('sends Escape before Enter when the footer shows shell mode (the text stays), waits, and re-checks the footer first', async () => {
    // shell footer, then (after Escape) the normal footer
    const { fake, calls, sleeps } = io([SHELL_FOOTER, NORMAL_FOOTER, NORMAL_FOOTER, NORMAL_FOOTER]);
    expect(await typeIntoOpencode(fake, opts)).toBe('sent');
    expect(calls.map((c) => c.args.at(-1))).toEqual([expect.any(String), 'Escape', 'Enter']);
    // Escape and Enter are never back to back: at least 120 ms sit between them
    const escapeAt = sleeps.indexOf(120);
    expect(escapeAt).toBeGreaterThan(-1);
  });

  it('a footer that lags the keys is still caught: it is read three times, a frame apart', async () => {
    const { fake, calls } = io([NORMAL_FOOTER, NORMAL_FOOTER, SHELL_FOOTER, NORMAL_FOOTER, NORMAL_FOOTER, NORMAL_FOOTER]);
    await typeIntoOpencode(fake, opts);
    expect(calls.map((c) => c.args.at(-1))).toEqual([expect.any(String), 'Escape', 'Enter']);
  });

  it('tries Escape twice at most; a pane still in shell mode gets no Enter, and the text stays', async () => {
    const { fake, calls } = io([SHELL_FOOTER]);
    expect(await typeIntoOpencode(fake, opts)).toBe('blocked');
    expect(calls.map((c) => c.args.at(-1))).toEqual([expect.any(String), 'Escape', 'Escape']);
    expect(calls.some((c) => c.args.at(-1) === 'Enter')).toBe(false);
  });

  it('a person\u2019s leading ! is theirs (shell mode on purpose): kept, no Escape; later ones are still guarded', async () => {
    const { fake, calls } = io([SHELL_FOOTER]);
    await typeIntoOpencode(fake, { ...opts, text: '!echo hi! there', person: true });
    expect(calls[0].args.at(-1)).toBe(`!echo hi${FULLWIDTH_BANG} there`);
    expect(calls.map((c) => c.args.at(-1))).toEqual([`!echo hi${FULLWIDTH_BANG} there`, 'Enter']);
    expect(guardShellKey('!a!b', { keepLeading: true })).toBe(`!a${FULLWIDTH_BANG}b`);
    expect(guardShellKey('!a!b')).toBe(`${FULLWIDTH_BANG}a${FULLWIDTH_BANG}b`);
    expect(guardShellKey('a!b', { keepLeading: true })).toBe(`a${FULLWIDTH_BANG}b`);
  });

  it('with paste on, loads a tmux buffer from stdin and pastes it bracketed, then waits 100 ms and presses Enter', async () => {
    const { fake, calls, sleeps } = io();
    await typeIntoOpencode(fake, { ...opts, paste: true });
    expect(calls).toEqual([
      { args: ['load-buffer', '-b', 'reverie-x', '-'], stdin: `[Reverie chat "R"] "a" -> you: "hi${FULLWIDTH_BANG}"` },
      { args: ['paste-buffer', '-p', '-d', '-b', 'reverie-x', '-t', 'pane1'] },
      { args: ['send-keys', '-t', 'pane1', 'Enter'] },
    ]);
    expect(sleeps[0]).toBe(100);
  });

  it('types without Enter when none was asked for, and presses only Enter for an empty text', async () => {
    const a = io();
    await typeIntoOpencode(a.fake, { ...opts, enter: false });
    expect(a.calls.map((c) => c.args[0])).toEqual(['send-keys']);
    expect(a.sleeps).toEqual([]);
    const b = io();
    await typeIntoOpencode(b.fake, { ...opts, text: '' });
    expect(b.calls).toEqual([{ args: ['send-keys', '-t', 'pane1', 'Enter'] }]);
  });

  // A gated write (an agent's input while a plan move may take the composer) answers to its gate at each of OpenCode's keys.
  it('a gate closed before the text types nothing', async () => {
    const { fake, calls } = io();
    const out = await withWriteGate(() => false, () => typeIntoOpencode(fake, opts));
    expect(out).toEqual({ result: 'not-written', typedUnsent: false });
    expect(calls).toEqual([]);
  });

  it('a gate that closes while a paste buffer is staged pastes nothing: the buffer is dropped, not typed', async () => {
    const { fake, calls } = io();
    let open = true;
    const typing: OpencodeTypingIo = { ...fake, tmux: async (args, stdin) => { await fake.tmux(args, stdin); if (args[0] === 'load-buffer') open = false; } };
    const out = await withWriteGate(() => open, () => typeIntoOpencode(typing, { ...opts, paste: true }));
    expect(out).toEqual({ result: 'not-written', typedUnsent: false });
    expect(calls.map((c) => c.args[0])).toEqual(['load-buffer', 'delete-buffer']); // no paste-buffer, no Enter
  });

  it('a gate that closes once the text is in withholds Enter and reports the text unsent', async () => {
    const { fake, calls } = io();
    let open = true;
    const typing: OpencodeTypingIo = { ...fake, tmux: async (args, stdin) => { await fake.tmux(args, stdin); open = false; } };
    const out = await withWriteGate(() => open, () => typeIntoOpencode(typing, opts));
    expect(out).toEqual({ result: 'withheld', typedUnsent: true });
    expect(calls.map((c) => c.args.at(-1))).toEqual([guardShellKey(opts.text)]); // the text only: no Escape, no Enter
  });

  it('a gate that closes while shell mode is being cleared sends no further Escape and no Enter', async () => {
    const { fake, calls } = io([SHELL_FOOTER]);
    let escapes = 0;
    const typing: OpencodeTypingIo = { ...fake, tmux: async (args, stdin) => { await fake.tmux(args, stdin); if (args.at(-1) === 'Escape') escapes++; } };
    const out = await withWriteGate(() => escapes === 0, () => typeIntoOpencode(typing, opts));
    expect(out).toEqual({ result: 'withheld', typedUnsent: true });
    expect(calls.map((c) => c.args.at(-1))).toEqual([guardShellKey(opts.text), 'Escape']);
  });

  it('a gate that closes after Enter, while no turn has started, withholds the confirm retry Enter', async () => {
    const pane = `┃ ${guardShellKey(opts.text)}\n\n  tab agents  ctrl+p commands`; // the first Enter was ignored: text still there
    const { fake, calls } = io([pane]);
    let open = true;
    const typing: OpencodeTypingIo = { ...fake, tmux: async (args, stdin) => { await fake.tmux(args, stdin); if (args.at(-1) === 'Enter') open = false; } };
    const out = await withWriteGate(() => open, () => typeIntoOpencode(typing, { ...opts, confirm: { glyph: '┃', workingLine: 'esc interrupt' } }));
    expect(out.typedUnsent).toBe(true);
    expect(calls.map((c) => c.args.at(-1))).toEqual([guardShellKey(opts.text), 'Enter']); // one Enter, no retry
  });

  it('an open gate, or none at all (a person\u2019s typing, the move\u2019s own handoff), types and submits as before', async () => {
    const gated = io();
    expect(await withWriteGate(() => true, () => typeIntoOpencode(gated.fake, opts))).toEqual({ result: 'sent', typedUnsent: false });
    const plain = io();
    expect(await typeIntoOpencode(plain.fake, opts)).toBe('sent');
    expect(gated.calls).toEqual(plain.calls);
    expect(plain.calls.map((c) => c.args.at(-1))).toEqual([guardShellKey(opts.text), 'Enter']);
  });
});

describe('who gets the guard', () => {
  function session(mode: 'opencode' | 'claude') {
    const s = new Session({ workingDir: '/tmp', name: 'w1-demo', mode });
    const sendInput = vi.fn(async () => true);
    (s as unknown as { _mux: unknown; _muxSession: unknown })._mux = { sendInput };
    (s as unknown as { _mux: unknown; _muxSession: unknown })._muxSession = { sessionId: s.id };
    return { s, sendInput };
  }

  it('an OpenCode pane gets a fullwidth "!" and the opencode typing path, only when the caller asks for the guard', async () => {
    const { s, sendInput } = session('opencode');
    await s.writeViaMux('hello! world\r', { opencodeGuard: true });
    expect(sendInput).toHaveBeenLastCalledWith(s.id, `hello${FULLWIDTH_BANG} world\r`, { opencode: true });
    // a person's typing (no guard flag) is untouched, "!" and all
    await s.writeViaMux('!ls\r', { fromUser: true });
    expect(sendInput).toHaveBeenLastCalledWith(s.id, '!ls\r', undefined);
  });

  it('a person\u2019s text (remote wake, an approval answer) keeps its leading ! and the guarded typing path', async () => {
    const { s, sendInput } = session('opencode');
    await s.writeViaMux('!ls here! now\r', { opencodeGuard: 'person' });
    expect(sendInput).toHaveBeenLastCalledWith(s.id, `!ls here${FULLWIDTH_BANG} now\r`, { opencode: 'person' });
  });

  it('the submit verifier\u2019s retry Enter takes the OpenCode path (so a pane left in shell mode is cleared first)', async () => {
    const { s, sendInput } = session('opencode');
    (s as unknown as { _mux: { capturePaneText: () => string } })._mux.capturePaneText = () => '';
    await s.writeViaMux('hello\r', { opencodeGuard: true });
    sendInput.mockClear();
    const verifier = (s as unknown as { _submitVerifier: { deps: { sendEnter: () => Promise<boolean> | undefined } } })._submitVerifier;
    await verifier.deps.sendEnter();
    expect(sendInput).toHaveBeenCalledWith(s.id, '\r', { opencode: true });
    // and a Claude pane\u2019s retry is the plain one
    const claude = session('claude');
    (claude.s as unknown as { _mux: { capturePaneText: () => string } })._mux.capturePaneText = () => '';
    await claude.s.writeViaMux('hello\r');
    claude.sendInput.mockClear();
    await (claude.s as unknown as { _submitVerifier: { deps: { sendEnter: () => Promise<boolean> | undefined } } })._submitVerifier.deps.sendEnter();
    expect(claude.sendInput).toHaveBeenCalledWith(claude.s.id, '\r', undefined);
  });

  it('a Claude pane is unchanged even when the guard is asked for', async () => {
    const { s, sendInput } = session('claude');
    await s.writeViaMux('hello! world\r', { opencodeGuard: true });
    expect(sendInput).toHaveBeenLastCalledWith(s.id, 'hello! world\r', undefined);
  });

  it('chat delivery asks for the guard on every write, and the line goes out with the mode-appropriate text', async () => {
    const writes: Array<{ data: string; options: unknown }> = [];
    const pane: DeliverySession = {
      id: 'p',
      name: 'p',
      mode: 'opencode',
      isWorking: false,
      pid: 1,
      writeViaMux: async (data, options) => {
        writes.push({ data, options });
        return true;
      },
    };
    const delivery = new ChatroomDelivery({ getSession: () => pane, now: () => 1_000_000 });
    delivery.enqueue('p', { id: 'r', name: 'Room' }, '"alpha" -> you: "done!"');
    await delivery.flushAll();
    expect(writes).toHaveLength(1);
    expect(writes[0].options).toEqual({ opencodeGuard: true, requireEmptyComposer: true, onOutcome: expect.any(Function) });
    expect(writes[0].data.endsWith('\r')).toBe(true);
  });
});
