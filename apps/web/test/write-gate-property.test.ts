import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeAndSubmit, writeGateActive } from '../src/submit-settle.js';

// Property check for the gated writes (idle-only wake, capacity retry), independent PR70 review 2026-10-29: random
// interleavings of gated and ordinary writes, busy flips, plan-move holds, ignored Enters and verifier timers, against a
// fake mux that runs the real typeAndSubmit. Invariant, checked at every key a gated write sends (text, Enter, retry Enter,
// the delayed verifier's Enter): no other mux write is in flight; a wake's key never reaches a busy session; a capacity
// key never reaches a composer a plan move holds.
const FOOTER = '  gpt-6.1-sol high · /owned/fixture';
const SEEDS = 120;
const STEPS = 40;

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let session: Session | undefined;
afterEach(async () => {
  if (session) {
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
    session = undefined;
  }
  vi.useRealTimers();
});

type Kind = 'wake' | 'capacity';

async function run(seed: number): Promise<string[]> {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const violations: string[] = [];
  let screen = `›\n${FOOTER}`;
  const active = new Set<number>();
  let calls = 0;
  let lastArmed: Kind | null = null;
  let release: (() => void) | undefined;
  const s = (): Record<string, unknown> => session as unknown as Record<string, unknown>;
  const retry = (): { paused: boolean } => s()._capacityRetry as { paused: boolean };
  const check = (key: string, call: number, kind: Kind | null): void => {
    const others = [...active].filter((c) => c !== call).length;
    if (others > 0) violations.push(`seed ${seed}: gated ${key} while ${others} other write(s) in flight`);
    if (kind === 'wake' && session!.isWorking) violations.push(`seed ${seed}: wake ${key} into a busy session`);
    if (kind === 'capacity' && retry().paused) violations.push(`seed ${seed}: capacity ${key} while a plan move holds the composer`);
  };
  const kindOf = (text: string): Kind | null => (text.startsWith('wake#') ? 'wake' : text.startsWith('cont#') ? 'capacity' : null);
  const delay = (max: number) => new Promise((resolve) => setTimeout(resolve, Math.floor(rand() * max)));

  const mux = {
    capturePaneText: () => screen,
    sendInput: vi.fn(async (_id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) => {
      const call = ++calls;
      active.add(call);
      try {
        await delay(400); // the transport can be slow, so writes overlap
        if (input === '\r') {
          // A bare Enter only comes from the delayed submit verifier: gated when it tracks a gated write.
          if (s()._verifierGate) check('verifier Enter', call, lastArmed);
          if (rand() < 0.5) screen = `›\n${FOOTER}`;
          return true;
        }
        const text = input.replace(/\r/g, '');
        const kind = kindOf(text);
        const io = {
          capture: () => screen,
          typeText: async (t: string) => {
            if (writeGateActive()) check('text', call, kind);
            screen = `› ${t}\n${FOOTER}`;
          },
          sleep: () => delay(300),
          sendEnter: async () => {
            if (writeGateActive()) check('Enter', call, kind);
            if (rand() < 0.5) screen = `›\n${FOOTER}`; // half the Enters are ignored, leaving the text for a retry/verifier
          },
        };
        return (await typeAndSubmit(io, text, { glyph: '›', workingLine: 'esc to interrupt' }, 'property', options.requireEmptyComposer)) !== 'not-written';
      } finally {
        active.delete(call);
      }
    }),
  };
  session = new Session({ id: `prop-${seed}`, workingDir: '/tmp', mode: 'codex', useMux: true, mux: mux as never,
    muxSession: { muxName: 'reverie-owned-review', sessionId: `prop-${seed}`, pid: 42 } as never });
  const writes: Promise<unknown>[] = [];
  const track = (p: Promise<boolean>, kind: Kind | null) =>
    writes.push(p.then((sent) => { if (sent) lastArmed = kind; }).catch(() => {}));
  for (let step = 0; step < STEPS; step++) {
    const op = pick(['wake', 'capacity', 'ordinary', 'busy', 'hold', 'clear', 'time', 'time']);
    if (op === 'wake') track(session.writeViaMux(`wake#${step}\r`, { requireEmptyComposer: true, requireIdle: true }), 'wake');
    else if (op === 'capacity')
      track(session.writeViaMux(`cont#${step}\r`, { requireEmptyComposer: true, capacityRetry: true, writeGate: () => !retry().paused }), 'capacity');
    else if (op === 'ordinary') track(session.writeViaMux(`note#${step}\r`), null);
    else if (op === 'busy') Object.assign(session, { _isWorking: !session.isWorking });
    else if (op === 'hold') {
      if (release) { release(); release = undefined; } else release = session.pauseCapacityRetry();
    } else if (op === 'clear') screen = `›\n${FOOTER}`;
    await vi.advanceTimersByTimeAsync(op === 'time' ? Math.floor(rand() * 3000) : Math.floor(rand() * 50));
  }
  await vi.advanceTimersByTimeAsync(70_000); // every delayed verifier has had its whole schedule
  await Promise.all(writes);
  release?.();
  return violations;
}

it(`no gated key reaches a busy, held or otherwise-owned composer (${SEEDS} seeded interleavings)`, async () => {
  vi.useFakeTimers();
  const found: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    found.push(...(await run(seed)));
    if (session) {
      Object.assign(session, { ptyProcess: null, _muxSession: null });
      await session.stop(false);
      session = undefined;
    }
  }
  expect(found.slice(0, 5)).toEqual([]);
}, 120_000);
