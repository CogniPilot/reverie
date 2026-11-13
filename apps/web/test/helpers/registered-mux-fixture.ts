import type { MuxSession } from '../../src/mux-interface.js';

/** A fixture registry owns actual objects; replacing a row never updates its predecessor. */
export function registeredMuxFixture(
  options: Pick<MuxSession, 'sessionId' | 'muxName' | 'pid' | 'mode'> & Partial<MuxSession>,
) {
  const subject: MuxSession = {
    createdAt: 0,
    workingDir: '/owned/fixture',
    attached: true,
    ...options,
  };
  const sessions = new Map<string, MuxSession>([[subject.sessionId, subject]]);
  return { subject, sessions, getSession: (id: string) => sessions.get(id) };
}
