import { expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeIntoOpencode } from '../src/opencode-input.js';

it.each(['before-verifier', 'inside-opencode'] as const)('retains the agent move gate through an OpenCode delayed verifier Enter: %s', async (holdAt) => {
  vi.useFakeTimers();
  const keys: string[] = [];
  let composer = '', verifying = false;
  let session!: Session;
  let release: (() => void) | undefined;
  const screen = () => `┃ ${composer}\n────────────────────`;
  const mux = { capturePaneText: screen,
    sendInput: async (_id: string, data: string) => {
      const outcome = await typeIntoOpencode({ capture: screen,
        sleep: async () => { if (verifying && holdAt === 'inside-opencode' && !release) release = session.pauseCapacityRetry(); },
        tmux: async (args: string[]) => {
          if (args.includes('-l')) { composer += args.at(-1)!; keys.push('text'); }
          if (args.at(-1) === 'Enter') keys.push(verifying ? 'lateVerifierEnter' : 'initialEnter');
        } }, { target: 'reverie-owned-review', text: data.replace(/[\r\n]/g, ''), enter: data.includes('\r'),
          paste: false, buffer: 'owned', confirm: { glyph: '┃' } });
      return outcome !== 'not-written';
    } };
  session = new Session({ id: 'test-session-1', workingDir: '/owned/fixture', mode: 'opencode', useMux: true,
    mux: mux as never, muxSession: { muxName: 'reverie-owned-review', sessionId: 'test-session-1', pid: 42 } as never });
  try {
    await session.writeViaMux('synthetic note\r', { agentInput: true, opencodeGuard: true });
    expect(keys).toEqual(['text', 'initialEnter', 'initialEnter']);
    verifying = true;
    if (holdAt === 'before-verifier') release = session.pauseCapacityRetry();
    await vi.advanceTimersByTimeAsync(2100);
    expect(session.composerHeldByMove).toBe(true);
    console.log(JSON.stringify({ holdAt, held: session.composerHeldByMove, syntheticKeys: keys }));
    expect(keys).toEqual(['text', 'initialEnter', 'initialEnter']);
  } finally {
    release?.(); Object.assign(session, { ptyProcess: null, _muxSession: null }); await session.stop(false);
    vi.useRealTimers();
  }
});
