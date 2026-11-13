/**
 * @fileoverview The pane's last-Enter timestamp must survive a Reverie restart.
 *
 * `start()` resets `claudeSessionId` to the launch id even when re-attaching to
 * a mux session whose CLI has since moved on (a `/clear` before the restart), so
 * `lastSubmitAt` is the response viewer's only anchor for re-deriving the live
 * conversation. If it is not persisted, a recovered pane shows the pre-`/clear`
 * transcript until the user happens to type again — hours, in practice.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';

function withPty(session: Session) {
  const write = vi.fn();
  Object.assign(session, {ptyProcess: {write}});
  return write;
}

describe('session submit anchor', () => {
  it('records the pane Enter and carries it into persisted state', () => {
    const session = new Session({ workingDir: '/tmp' });
    expect(session.lastSubmitAt).toBe(0);
    expect(session.toState().lastSubmitAt).toBeUndefined();

    const write = withPty(session);
    const before = Date.now();
    expect(session.write('hello\r')).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith('hello\r');
    const after = Date.now();

    expect(session.lastSubmitAt).toBeGreaterThanOrEqual(before);
    expect(session.lastSubmitAt).toBeLessThanOrEqual(after);
    expect(session.toState().lastSubmitAt).toBe(session.lastSubmitAt);
  });

  it('leaves the anchor unset for keystrokes that never submit', () => {
    const session = new Session({ workingDir: '/tmp' });
    const write = withPty(session);
    expect(session.write('hello')).toBe(true);
    session.write('\x1b[A');
    expect(write.mock.calls).toEqual([['hello'], ['\x1b[A']]); // arrow-up: history recall, not a submit

    expect(session.lastSubmitAt).toBe(0);
    expect(session.toState().lastSubmitAt).toBeUndefined();
  });

  it('restores the anchor from persisted state on boot recovery', () => {
    const submitted = new Session({ workingDir: '/tmp' });
    const write = withPty(submitted);
    expect(submitted.write('prompt\r')).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith('prompt\r');
    const persisted = submitted.toState();

    const recovered = new Session({ workingDir: '/tmp', lastSubmitAt: persisted.lastSubmitAt });

    expect(recovered.lastSubmitAt).toBe(submitted.lastSubmitAt);
    expect(recovered.toState().lastSubmitAt).toBe(submitted.lastSubmitAt);
  });

  it('starts a pane with no persisted anchor at zero rather than NaN', () => {
    const recovered = new Session({ workingDir: '/tmp', lastSubmitAt: undefined });
    expect(recovered.lastSubmitAt).toBe(0);
  });
});
