/**
 * A wake line that was typed and never submitted must not hold a seat for good.
 *
 * Observed 2026-11-26: an agent sat idle for six hours with the office's own wake line unsent in its composer. Every later
 * wake needs an empty composer, so nothing was typed again and the room only said the terminal "was not idle". The office
 * now presses Enter for that line when it is the whole composer of an otherwise idle pane.
 *
 * The first block drives delivery against a fake pane; the second the real Session and its composer check against a fake mux.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatroomDelivery, DELIVERY_SPACING_MS, UNSENT_WAKE_RETRY_MS, WAKE_LINE, type DeliverySession, type DeliveryStall } from '../src/chatroom-delivery.js';
import { Session } from '../src/session.js';
import { typeAndSubmit } from '../src/submit-settle.js';
import { registeredMuxFixture } from './helpers/registered-mux-fixture.js';

type Options = Parameters<DeliverySession['writeViaMux']>[1];

/** A Claude pane as delivery sees it: what its composer holds, and whether a turn is running. */
function fixture(composer = WAKE_LINE) {
  const clock = { now: 1_000_000 };
  const pane = { composer, working: false, canResubmit: true };
  const typed: string[] = [];
  const entered: string[] = [];
  const session: DeliverySession & { paneDialog?: unknown; canAcceptChatInput?: () => boolean } = {
    id: 's', name: 'Ada', mode: 'claude', pid: 42,
    get isWorking() { return pane.working; },
    composerProvablyIdle: () => !pane.working && pane.composer === '',
    // The wake as the session makes it: refused before any key unless the pane is idle with an empty composer.
    writeViaMux: async (text: string, options: Options) => {
      if (options?.requireIdle && (pane.working || pane.composer !== '')) {
        options.onIdleRefused?.();
        return false;
      }
      typed.push(text);
      pane.working = true;
      options?.onOutcome?.('submitted');
      return true;
    },
    // Enter for a line that is the whole composer of an idle pane; the turn it starts empties the composer.
    resubmitStranded: (text: string) => {
      if (!pane.canResubmit || pane.working || pane.composer !== text) return false;
      entered.push(text);
      pane.composer = '';
      pane.working = true;
      return true;
    },
  };
  const stalls: DeliveryStall[] = [];
  const delivery = new ChatroomDelivery({ getSession: () => session, now: () => clock.now, onStalled: (_id, stall) => stalls.push(stall) });
  delivery.enqueue('s', { id: 'office', name: 'office' }, '@Ada please look at the build', { messageId: 'm-1' });
  /** One delivery attempt, later than the spacing between two lines. */
  const poll = async () => {
    clock.now += DELIVERY_SPACING_MS;
    return delivery.flush('s');
  };
  return { delivery, session, clock, pane, typed, entered, stalls, poll };
}

describe('a wake line left unsent in the composer', () => {
  it('is submitted on the next attempt instead of holding every later line', async () => {
    const f = fixture();
    // The first attempt finds the composer in the way, as it always did.
    expect(await f.poll()).toBe(false);
    expect(f.entered).toEqual([]);
    expect(f.delivery.waitingFor('s')).toEqual({ reason: 'not_idle', since: f.clock.now });
    // The next one looks at what is in it: Enter is pressed for the line that is there. Nothing is typed beside it.
    expect(await f.poll()).toBe(false);
    expect(f.entered).toEqual([WAKE_LINE]);
    expect(f.typed).toEqual([]);
    // The turn that Enter started: delivery waits for it like for any other.
    expect(await f.poll()).toBe(false);
    expect(f.delivery.waitingFor('s')?.reason).toBe('working');
    // Idle again with an empty composer: lines are typed as before.
    f.pane.working = false;
    expect(await f.poll()).toBe(true);
    expect(f.typed).toEqual([`${WAKE_LINE}\r`]);
    expect(f.entered).toEqual([WAKE_LINE]);
    expect(f.delivery.waitingFor('s')).toBeUndefined();
  });

  it('without that step the seat waited for good: the write is refused on every attempt', async () => {
    const f = fixture();
    f.session.resubmitStranded = undefined;
    for (let attempt = 0; attempt < 5; attempt++) expect(await f.poll()).toBe(false);
    expect(f.typed).toEqual([]);
    expect(f.delivery.waitingFor('s')?.reason).toBe('not_idle');
  });

  it('never touches a composer that holds anything else: a draft, or the wake line with words added', async () => {
    for (const composer of ['please wait for me', `${WAKE_LINE} and one more thing`, WAKE_LINE.slice(0, -1)]) {
      const f = fixture(composer);
      for (let attempt = 0; attempt < 3; attempt++) expect(await f.poll()).toBe(false);
      expect([composer, f.entered, f.typed]).toEqual([composer, [], []]);
      expect(f.pane.composer).toBe(composer);
      expect(f.delivery.waitingFor('s')?.reason).toBe('not_idle');
    }
  });

  it('presses nothing while the pane is not running, shows a dialog or is in a turn', async () => {
    const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
      ['not_running', (f) => { f.session.pid = null; }],
      ['dialog_open', (f) => { f.session.paneDialog = { kind: 'permission' }; }],
      ['working', (f) => { f.pane.working = true; }],
    ];
    for (const [reason, set] of cases) {
      const f = fixture();
      set(f);
      expect(await f.poll()).toBe(false);
      expect([reason, f.entered]).toEqual([reason, []]);
      expect(f.delivery.waitingFor('s')?.reason).toBe(reason);
    }
  });

  it('is looked at first on a harness whose composer closes chat input while it holds text', async () => {
    const f = fixture();
    f.session.canAcceptChatInput = () => f.pane.composer === '';
    expect(await f.poll()).toBe(false);
    expect(f.delivery.waitingFor('s')?.reason).toBe('input_closed');
    expect(await f.poll()).toBe(false);
    expect(f.entered).toEqual([WAKE_LINE]);
    // A draft there keeps the input closed, as before.
    const g = fixture('a draft');
    g.session.canAcceptChatInput = () => g.pane.composer === '';
    for (let attempt = 0; attempt < 3; attempt++) expect(await g.poll()).toBe(false);
    expect(g.entered).toEqual([]);
    expect(g.delivery.waitingFor('s')?.reason).toBe('input_closed');
  });

  it('is submitted before the wait for unconfirmed earlier lines, which that same line is', async () => {
    const f = fixture();
    f.delivery.holdForInspection('s', [{ roomId: 'office', messageId: 'earlier' }]);
    expect(await f.poll()).toBe(false);
    expect(f.delivery.waitingFor('s')?.reason).toBe('unconfirmed_unread');
    expect(await f.poll()).toBe(false);
    expect(f.entered).toEqual([WAKE_LINE]);
  });

  it('costs a seat that takes its lines nothing: the composer is only looked at after it stood in the way', async () => {
    const f = fixture('');
    let asked = 0;
    f.session.resubmitStranded = () => { asked++; return false; };
    expect(await f.poll()).toBe(true);
    expect(f.typed).toEqual([`${WAKE_LINE}\r`]);
    expect(asked).toBe(0);
  });

  it('presses Enter for a line no Enter moves at most once per retry window, and still reports the seat as stalled', async () => {
    const f = fixture();
    // The CLI ignores every Enter: the line stays and no turn starts.
    f.session.resubmitStranded = (text: string) => { f.entered.push(text); return true; };
    const until = f.clock.now + 11 * 60_000;
    const started = f.clock.now + DELIVERY_SPACING_MS;
    while (f.clock.now < until) expect(await f.poll()).toBe(false);
    const spans = Math.floor((f.clock.now - started) / UNSENT_WAKE_RETRY_MS);
    expect(f.entered.length).toBeGreaterThanOrEqual(spans);
    expect(f.entered.length).toBeLessThanOrEqual(spans + 1);
    expect(f.typed).toEqual([]);
    // The wait kept its reason and its start through every press, so the owner is told after ten minutes.
    expect(f.delivery.waitingFor('s')).toEqual({ reason: 'not_idle', since: started });
    expect(f.stalls).toEqual([expect.objectContaining({ reason: 'not_idle', since: started, waiting: 1 })]);
  });

  it('is tried no more often than lines are typed, and falls back to waiting when the session will not press Enter', async () => {
    const f = fixture();
    f.pane.canResubmit = false;
    for (let attempt = 0; attempt < 3; attempt++) expect(await f.poll()).toBe(false);
    expect(f.delivery.waitingFor('s')?.reason).toBe('not_idle');
    f.pane.canResubmit = true;
    // Within the spacing after an attempt nothing is pressed.
    f.clock.now += 1000;
    expect(await f.delivery.flush('s')).toBe(false);
    expect(f.entered).toEqual([]);
    expect(await f.poll()).toBe(false);
    expect(f.entered).toEqual([WAKE_LINE]);
    // A session that throws from the step changes nothing.
    const g = fixture();
    g.session.resubmitStranded = () => { throw new Error('pane gone'); };
    for (let attempt = 0; attempt < 3; attempt++) expect(await g.poll()).toBe(false);
    expect(g.delivery.waitingFor('s')?.reason).toBe('not_idle');
  });
});

const claude = (body: string) => [
  '● earlier answer',
  '────────────────────────────────────────────',
  `❯ ${body}`.trimEnd(),
  '────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:0 out:0',
].join('\n');

describe('how a wake line comes to be left unsent', () => {
  /** The wake as the mux layer types it: text, a look at the composer, then Enter only for exactly that text. */
  const wake = (capture: (typed: boolean) => string | null) => {
    let typed = false;
    let enters = 0;
    const io = {
      typeText: async () => { typed = true; },
      sendEnter: async () => { enters++; },
      capture: () => capture(typed),
      sleep: async () => {},
      log: () => {},
    };
    return typeAndSubmit(io, WAKE_LINE, { glyph: '❯', workingLine: '[Ee]sc to interrupt' }, 'wake', true, () => true)
      .then((outcome) => ({ outcome, typed, enters }));
  };

  it('the text is typed, the pane cannot be read right after it, and Enter is withheld', async () => {
    // A laptop the office loses its connection to between the two steps: the text went in, the look at it fails.
    expect(await wake((typed) => (typed ? null : claude('')))).toEqual({ outcome: 'unverified', typed: true, enters: 0 });
    // The same when the pane has not drawn the text yet.
    expect(await wake(() => claude(''))).toEqual({ outcome: 'unverified', typed: true, enters: 0 });
  });

  it('when the composer shows the line, Enter is pressed', async () => {
    const seen = await wake((typed) => (typed ? claude(WAKE_LINE) : claude('')));
    expect(seen.typed).toBe(true);
    expect(seen.enters).toBeGreaterThanOrEqual(1);
  });
});

/** A real Session on a fake mux whose pane shows `screen.text`; an Enter is recorded and answered by `onEnter`. */
function paneSession(initial: string, mode = 'claude') {
  const screen = { text: claude(initial) as string | null };
  const keys: string[] = [];
  const hooks = { onEnter: () => { screen.text = claude(''); } };
  const registered = registeredMuxFixture({ sessionId: 'unsent-wake-1', muxName: 'reverie-unsent-wake', pid: 42, mode: mode as never });
  const mux = {
    getSession: registered.getSession,
    capturePaneText: () => screen.text,
    sendInput: vi.fn(async (_id: string, input: string, options?: { admitted?: () => boolean }) => {
      if (options?.admitted && !options.admitted()) return false;
      keys.push(input);
      if (input === '\r') hooks.onEnter();
      return true;
    }),
  };
  const session = new Session({
    id: 'unsent-wake-1', workingDir: '/tmp', mode: mode as never, useMux: true, mux: mux as never,
    muxSession: registered.subject,
  });
  Object.assign(session, { _pid: 42 });
  const close = async () => {
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
  };
  return { session, screen, keys, hooks, close };
}

describe('Session.resubmitStranded', () => {
  afterEach(() => vi.useRealTimers());

  it('presses Enter for exactly that line, types nothing, and reports the submission', async () => {
    vi.useFakeTimers();
    const p = paneSession(WAKE_LINE);
    try {
      const outcomes: string[] = [];
      expect(p.session.resubmitStranded(WAKE_LINE, (outcome) => outcomes.push(outcome))).toBe(true);
      // A second request while that one is deciding does nothing.
      expect(p.session.resubmitStranded(WAKE_LINE)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(p.keys).toEqual(['\r']);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(outcomes).toEqual(['submitted']);
      expect(p.keys).toEqual(['\r']);
    } finally {
      await p.close();
    }
  });

  it('keeps pressing while the CLI ignores Enter and the composer still holds exactly the line', async () => {
    vi.useFakeTimers();
    const p = paneSession(WAKE_LINE);
    try {
      let ignored = 2;
      p.hooks.onEnter = () => { if (ignored-- <= 0) p.screen.text = claude(''); };
      const outcomes: string[] = [];
      p.session.resubmitStranded(WAKE_LINE, (outcome) => outcomes.push(outcome));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(p.keys).toEqual(['\r', '\r', '\r']);
      expect(outcomes).toEqual(['submitted']);
    } finally {
      await p.close();
    }
  });

  it('does nothing unless the whole composer is that line', async () => {
    for (const body of ['', 'a draft of mine', `${WAKE_LINE} and more`, `x ${WAKE_LINE}`]) {
      const p = paneSession(body);
      try {
        expect([body, p.session.resubmitStranded(WAKE_LINE)]).toEqual([body, false]);
        expect(p.keys).toEqual([]);
      } finally {
        await p.close();
      }
    }
  });

  it('does nothing while a turn runs, input is held, the pane cannot be read or the harness has no verified composer', async () => {
    const blocked: Array<[string, (p: ReturnType<typeof paneSession>) => void]> = [
      ['a turn is running', (p) => Object.assign(p.session, { _isWorking: true })],
      ['a viewer holds the input', (p) => Object.assign(p.session, { _viewerInputHeld: true })],
      ['a plan move holds the composer', (p) => Object.assign(p.session, { _moveHolds: 1 })],
      ['the session is stopped', (p) => Object.assign(p.session, { _isStopped: true })],
      ['a capacity retry owns the composer', (p) => Object.assign(p.session, { _capacityTextPending: true })],
      ['the pane cannot be read', (p) => { p.screen.text = null; }],
    ];
    for (const [title, set] of blocked) {
      const p = paneSession(WAKE_LINE);
      try {
        set(p);
        expect([title, p.session.resubmitStranded(WAKE_LINE)]).toEqual([title, false]);
        expect(p.keys).toEqual([]);
      } finally {
        Object.assign(p.session, { _isStopped: false });
        await p.close();
      }
    }
    const shell = paneSession(WAKE_LINE, 'shell');
    try {
      expect(shell.session.resubmitStranded(WAKE_LINE)).toBe(false);
    } finally {
      await shell.close();
    }
  });

  it('presses nothing once a person has added to the line before the check looks', async () => {
    vi.useFakeTimers();
    const p = paneSession(WAKE_LINE);
    try {
      const outcomes: string[] = [];
      expect(p.session.resubmitStranded(WAKE_LINE, (outcome) => outcomes.push(outcome))).toBe(true);
      p.screen.text = claude(`${WAKE_LINE} wait`);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(p.keys).toEqual([]);
      expect(outcomes).toEqual(['unverified']);
    } finally {
      await p.close();
    }
  });

  it('presses nothing once a turn has started before the check looks', async () => {
    vi.useFakeTimers();
    const p = paneSession(WAKE_LINE);
    try {
      expect(p.session.resubmitStranded(WAKE_LINE)).toBe(true);
      Object.assign(p.session, { _isWorking: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(p.keys).toEqual([]);
    } finally {
      await p.close();
    }
  });
});

describe('delivery and the real session together', () => {
  afterEach(() => vi.useRealTimers());

  it('an idle agent with the unsent wake line is woken by the next attempt, and typed to again afterwards', async () => {
    vi.useFakeTimers();
    const p = paneSession(WAKE_LINE);
    try {
      const clock = { now: 1_000_000 };
      const delivery = new ChatroomDelivery({ getSession: () => p.session as unknown as DeliverySession, now: () => clock.now });
      delivery.enqueue('unsent-wake-1', { id: 'office', name: 'office' }, '@Ada please look at the build', { messageId: 'm-1' });
      // As the room showed it for six hours: the terminal "was not idle", and nothing was typed.
      clock.now += DELIVERY_SPACING_MS;
      expect(await delivery.flush('unsent-wake-1')).toBe(false);
      expect(delivery.waitingFor('unsent-wake-1')?.reason).toBe('not_idle');
      expect(p.keys).toEqual([]);
      clock.now += DELIVERY_SPACING_MS;
      expect(await delivery.flush('unsent-wake-1')).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      // Enter and nothing else reached the pane, and its composer is empty again.
      expect(p.keys).toEqual(['\r']);
      clock.now += DELIVERY_SPACING_MS;
      expect(await delivery.flush('unsent-wake-1')).toBe(true);
      expect(p.keys).toEqual(['\r', `${WAKE_LINE}\r`]);
      delivery.stop();
    } finally {
      await p.close();
    }
  });
});
