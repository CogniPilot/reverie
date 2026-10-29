import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerBody, composerIsEmpty, placeholderHoldsPrompt, promptStillInComposer, SubmitVerifier } from '../src/session-submit-verifier.js';
import { CODEX_KEY_BURST_MAX_CHARS, pastesInsteadOfKeys, submitAndConfirm, typeAndSubmit } from '../src/submit-settle.js';
import { ChatroomDelivery } from '../src/chatroom-delivery.js';
import { Session } from '../src/session.js';

// Same presentation as the reported Codex composer: two chips and a literal tail
// wrapped across rows. Synthetic content only; no real conversation or CLI input.
const TAIL = ' owned source tail; keep the complete submitted delivery and its final reply hint.';
const PROMPT = 'a'.repeat(1024) + 'b'.repeat(1022) + TAIL;
const MIXED = `• earlier answer (esc to interrupt)\n› [Pasted Content 1024 chars][Pasted Content 1022 chars]${TAIL.slice(0, 35)}\n${TAIL.slice(35)}\n\nGPT-6.1-Sol high · /owned/fixture`;
const FOOTER = 'GPT-6.1-Sol high · /owned/fixture';
const EMPTY = `›\n\n${FOOTER}`;
const CODEX = { glyph: '›', workingLine: 'esc to interrupt' };
afterEach(() => vi.useRealTimers());

describe('complete Codex composer ownership', () => {
  it('matches all chips plus the entire wrapped literal tail', () => {
    expect(promptStillInComposer(MIXED, PROMPT, '›')).toBe(true);
    expect(placeholderHoldsPrompt(`[Pasted Content 1024 chars][Pasted Content 1022 chars]${TAIL}`, PROMPT)).toBe(true);
  });
  it('refuses a matching chip next to unrelated content, wrong tails and extra user text', () => {
    expect(promptStillInComposer(MIXED.replace('final reply hint', 'foreign user draft'), PROMPT, '›')).toBeUndefined();
    expect(promptStillInComposer(`› [Pasted Content 90 chars][Pasted Content ${PROMPT.length} chars]`, PROMPT, '›', true)).toBeUndefined();
    expect(promptStillInComposer(`› ${PROMPT} user addition`, PROMPT, '›')).toBeUndefined();
    expect(placeholderHoldsPrompt(`[Pasted Content 1024 chars][Pasted Content 1022 chars]wrong tail`, PROMPT, true)).toBe(false);
  });
  it('requires observed empty-before-write evidence for a wholly opaque paste', () => {
    const opaque = `› [Pasted Content ${PROMPT.length} chars]\n\n${FOOTER}`;
    expect(promptStillInComposer(opaque, PROMPT, '›')).toBeUndefined();
    expect(promptStillInComposer(opaque, PROMPT, '›', true)).toBe(true);
    expect(composerIsEmpty(EMPTY, '›')).toBe(true);
    expect(composerIsEmpty(null, '›')).toBe(false);
  });
  it('uses only the last composer, preserving taken/transcript semantics', () => {
    expect(promptStillInComposer(MIXED.replace(FOOTER, `• Completed\n›\n\n${FOOTER}`), PROMPT, '›')).toBe(false);
    expect(promptStillInComposer('unknown layout', PROMPT, '›')).toBeUndefined();
  });
  it('preserves leading and internal blank rows instead of treating a multiline draft as empty', () => {
    const draft = '›\n\n  existing draft\n\n GPT-6.1-Sol high · /owned/fixture';
    expect(composerIsEmpty(draft, '›')).toBe(false);
    expect(promptStillInComposer(draft, PROMPT, '›')).toBeUndefined();
    expect(promptStillInComposer(MIXED.replace(TAIL.slice(35), `\n${TAIL.slice(35)}`), PROMPT, '›')).toBe(true);
  });
  it('does not confuse indented literal prompt glyphs or model-looking text with an empty composer', () => {
    for (const draft of ['› retained first line\n  ›\nGPT-6.1-Sol high', '›\n  GPT-example existing draft\nmore user text',
      '› retained first line\n›\nGPT-6.1-Sol high · /owned/fixture',
      '›\n  ─ retained markdown draft\nGPT-6.1-Sol high · /owned/fixture']) {
      expect(composerIsEmpty(draft, '›')).toBe(false);
      expect(promptStillInComposer(draft, PROMPT, '›')).toBeUndefined();
    }
  });
  it('preserves significant spaces within visible literal rows', () => {
    expect(promptStillInComposer(`› set alpha=1 0\n\n${FOOTER}`, 'set alpha=10', '›')).toBeUndefined();
    expect(promptStillInComposer(`› [Pasted Content 1024 chars][Pasted Content 1022 chars]${TAIL.replace('source', 's ource')}\n\n${FOOTER}`, PROMPT, '›')).toBeUndefined();
  });
  it('retries only the complete owned mixed paste and reports submission only after empty', async () => {
    vi.useFakeTimers(); let screen = MIXED; let enters = 0; const outcomes: string[] = [];
    const verifier = new SubmitVerifier({ capture: () => screen, glyph: () => '›', delaysMs: [100, 100],
      sendEnter: () => { if (++enters === 2) screen = EMPTY; } });
    verifier.arm(PROMPT, value => outcomes.push(value));
    await vi.advanceTimersByTimeAsync(2200);
    expect(enters).toBe(2); expect(outcomes).toEqual(['submitted']);
  });
  it('never presses Enter or issues a submitted receipt for changed/foreign content', async () => {
    vi.useFakeTimers(); const enter = vi.fn(); const outcomes: string[] = [];
    // Keep the extra text in the composer, before its blank/footer boundary.
    const foreign = MIXED.replace('final reply hint.', 'final reply hint. user draft');
    const second = new SubmitVerifier({ capture: () => foreign, glyph: () => '›', delaysMs: [100], sendEnter: enter });
    second.arm(PROMPT, value => outcomes.push(value));
    await vi.advanceTimersByTimeAsync(3000);
    expect(enter).not.toHaveBeenCalled(); expect(outcomes).toEqual(['unverified']);
  });
  it('does not mistake a historical busy line for submission; retries the swallowed first Enter', async () => {
    let enters = 0;
    const outcome = await submitAndConfirm({ capture: () => enters < 2 ? MIXED : EMPTY, sleep: async () => {},
      sendEnter: async () => { enters++; } }, PROMPT, CODEX);
    expect(outcome).toBe('started-after-retry'); expect(enters).toBe(2);
  });
  it('withholds the retry if a user edits during confirmation', async () => {
    let enters = 0;
    const outcome = await submitAndConfirm({ capture: () => enters ? MIXED.replace('final reply hint.', 'user draft') : MIXED,
      sleep: async () => {}, sendEnter: async () => { enters++; } }, PROMPT, CODEX);
    expect(outcome).toBe('unverified'); expect(enters).toBe(1);
  });
  it('types one full delivery from an empty composer and never splits it into separate writes', async () => {
    let typed = false; let enters = 0; const writes: string[] = [];
    const result = await typeAndSubmit({ capture: () => !typed || enters > 1 ? EMPTY : MIXED,
      typeText: async text => { typed = true; writes.push(text); }, sleep: async () => {}, sendEnter: async () => { enters++; } }, PROMPT, CODEX);
    expect(result).toBe('started-after-retry'); expect(writes).toEqual([PROMPT]); expect(enters).toBe(2);
  });
  it('actual Session refuses chat writes into occupied or unreadable Codex panes before mux input', async () => {
    const session = new Session({ workingDir: '/owned/fixture', mode: 'codex' });
    const sendInput = vi.fn(); let screen: string | null = MIXED;
    Object.assign(session, { _mux: { sendInput, capturePaneText: () => screen }, _muxSession: { muxName: 'owned-fixture' } });
    expect(session.canAcceptChatInput()).toBe(false);
    expect(await session.writeViaMux('next delivery\r', { requireEmptyComposer: true })).toBe(false);
    screen = null; expect(await session.writeViaMux('next delivery\r', { requireEmptyComposer: true })).toBe(false);
    expect(sendInput).not.toHaveBeenCalled(); screen = EMPTY; expect(session.canAcceptChatInput()).toBe(true);
  });
  it('does not write or stamp submission when a pre-write guard finds a user draft', async () => {
    const typeText = vi.fn(); const sendEnter = vi.fn();
    expect(await typeAndSubmit({ capture: () => '› user draft', typeText, sendEnter, sleep: async () => {} }, PROMPT, CODEX, 'chat', true)).toBe('not-written');
    expect(typeText).not.toHaveBeenCalled(); expect(sendEnter).not.toHaveBeenCalled();
    const session = new Session({ workingDir: '/owned/fixture', mode: 'codex' });
    const submitted = vi.fn(); session.on('promptSubmitted', submitted);
    Object.assign(session, { _mux: { sendInput: async () => false, capturePaneText: () => EMPTY }, _muxSession: { muxName: 'owned-fixture' } });
    expect(await session.writeViaMux('new prompt\r', { fromUser: true })).toBe(false);
    expect(session.lastSubmitAt).toBe(0); expect(submitted).not.toHaveBeenCalled();
  });
  it('keeps filtered chat queued behind a user draft and serializes until a verified outcome', async () => {
    let empty = false; let now = 100_000; let finish: ((value: 'submitted' | 'unverified') => void) | undefined;
    const writes: string[] = []; const submitted = vi.fn();
    const session = { id: 's', name: 's', mode: 'codex', pid: 1, isWorking: false,
      canAcceptChatInput: () => empty, writeViaMux: async (data: string, options: any) => {
        expect(options.requireEmptyComposer).toBe(true); writes.push(data); finish = options.onOutcome; return true; } };
    const delivery = new ChatroomDelivery({ getSession: () => session, now: () => now,
      allowFragment: (_sid, _room, mid) => mid !== 'filtered', onSubmitted: submitted });
    const room = { id: 'room', name: 'owned' };
    delivery.enqueue('s', room, 'filtered', { messageId: 'filtered' });
    delivery.enqueue('s', room, 'first', { messageId: 'first' });
    expect(await delivery.flush('s')).toBe(false); expect(writes).toEqual([]);
    empty = true; expect(await delivery.flush('s')).toBe(true); expect(writes).toHaveLength(1); expect(writes[0]).not.toContain('filtered');
    now += 9000; delivery.enqueue('s', room, 'second', { messageId: 'second' });
    expect(await delivery.flush('s')).toBe(false); expect(writes).toHaveLength(1);
    finish?.('unverified'); expect(await delivery.flush('s')).toBe(false); expect(submitted).not.toHaveBeenCalled();
    delivery.stop();
  });
});

describe('Codex panes on any model and long deliveries', () => {
  // Footers measured on codex-cli 0.163.0 with a custom provider; synthetic paths only.
  it('reads the composer under a non-GPT model footer, at rest and mid-turn', () => {
    for (const footer of ['  mock-model default · /owned/fixture', '  qwen3-coder:30b default · ~/owned/fixture',
      '  Qwen/Qwen3-Coder high · /owned/fixture · ⠼']) {
      expect(composerIsEmpty(`› \n\n${footer}\n  ← for agents · ? for shortcuts`, '›')).toBe(true);
      expect(composerIsEmpty(`› [Pasted Content ${PROMPT.length} chars]\n\n${footer}`, '›')).toBe(false);
      expect(promptStillInComposer(`› [Pasted Content ${PROMPT.length} chars]\n\n${footer}`, PROMPT, '›', true)).toBe(true);
    }
  });
  it('still refuses two footer-shaped rows', () => {
    expect(composerIsEmpty('›\n  notes · /owned/one\n  mock-model default · /owned/fixture', '›')).toBe(false);
  });
  it('pastes only long, control-free text into Codex panes', () => {
    expect(pastesInsteadOfKeys('codex', 'x'.repeat(CODEX_KEY_BURST_MAX_CHARS))).toBe(false);
    expect(pastesInsteadOfKeys('codex', 'x'.repeat(CODEX_KEY_BURST_MAX_CHARS + 1))).toBe(true);
    expect(pastesInsteadOfKeys('codex', `${'x'.repeat(2000)}\u001b[201~tail`)).toBe(false);
    expect(pastesInsteadOfKeys('claude', 'x'.repeat(3000))).toBe(false);
  });
});

describe('Codex composer as captured with SGR codes (codex-cli 0.163.0)', () => {
  // Escape sequences as `capture-pane -p -e` returned them; synthetic text only.
  const ESC = '\u001b';
  const GLYPH = `${ESC}[1m›${ESC}[0m`;
  const FOOT = `  ${ESC}[38;2;246;226;183mmock-model default${ESC}[39m · ${ESC}[38;2;171;223;167m/owned/fixture${ESC}[39m`;
  const placeholder = (hint: string) => `${GLYPH} ${ESC}[2m${hint}${ESC}[0m`;
  it('reads a dim placeholder as an empty composer, and typed or pasted text as content', () => {
    for (const hint of ['Ask Codex to do anything', 'Find and fix a bug in @filename']) {
      expect(composerIsEmpty(`${placeholder(hint)}\n\n${FOOT}`, '›')).toBe(true);
    }
    expect(composerIsEmpty(`${GLYPH} real text\n\n${FOOT}`, '›')).toBe(false);
    expect(composerIsEmpty(`${GLYPH} ${ESC}[38;5;6m[Pasted Content 2900 chars]${ESC}[39m\n\n${FOOT}`, '›')).toBe(false);
    // Without the codes the placeholder is indistinguishable from text, so a plain capture never reads as empty.
    expect(composerIsEmpty(`› Ask Codex to do anything\n\n${FOOT}`, '›')).toBe(false);
  });
  it('reads the composer under a message steered into a running turn', () => {
    const echo = (text: string) => `${ESC}[1;2m› ${ESC}[0m${text}`;
    const working = `${ESC}[1m•${ESC}[0m ${ESC}[2mWorking${ESC}[0m ${ESC}[2m(3s • ${ESC}[0;1mesc${ESC}[0;2m to interrupt)${ESC}[0m`;
    const screen = `${echo('busy turn')}\n\n${echo('steered delivery')}\n\n${working}\n\n${placeholder('Ask Codex to do anything')}\n\n${FOOT}`;
    expect(composerIsEmpty(screen, '›')).toBe(true);
    expect(promptStillInComposer(screen, 'steered delivery', '›')).toBe(false);
    // A literal glyph row straight under the composer is still refused.
    expect(composerBody(`${echo('busy turn')}\n\n${working}\n${GLYPH} draft\n› literal\n\n${FOOT}`, '›')).toBeUndefined();
  });
});
