import type { Session } from '../../src/session.js';
import type { MuxSession } from '../../src/mux-interface.js';

/** Register the fixture's current pane once, as a real mux manager does.
 * Replacing Session's private pane afterwards must not silently update this registry.
 */
export function registerMuxFixture(session: Session): Map<string, MuxSession> {
  const { _mux: mux, _muxSession: subject } = session as unknown as {
    _mux: { getSession?: (id: string) => MuxSession | null };
    _muxSession: MuxSession;
  };
  if (!mux || !subject) throw new Error('Create the fixture pane before registering it');
  if (mux.getSession) throw new Error('The fixture mux already has a registry');
  subject.owner = session.owner;
  const registry = new Map([[session.id, subject]]);
  mux.getSession = id => registry.get(id) ?? null;
  return registry;
}
