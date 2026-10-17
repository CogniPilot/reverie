/**
 * 82d: a session resuming through ANY CLI's own field carries that conversation as its thread alias, from construction
 * and through start(), so 82's same-thread check sees one mind for every CLI (not only Claude, Codex and omp).
 * Mirrors test/codex-resume-alias-survives-start.test.ts (a real Session on vitest's in-memory tmux).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';

describe('every CLI resume field becomes the thread alias, and survives start()', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'resume-alias-all');
  const sessions: Session[] = [];
  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });
  const make = (config: Record<string, unknown>) => {
    mkdirSync(workingDir, { recursive: true });
    const s = new Session({ workingDir, mux: new TmuxManager(), useMux: true, ...config } as never);
    sessions.push(s);
    return s;
  };

  it.each([
    ['pi', { mode: 'pi', piConfig: { resumeSessionId: 'pi-thread-1' } }, 'pi-thread-1'],
    ['opencode', { mode: 'opencode', openCodeConfig: { continueSession: 'ses_abc123' } }, 'ses_abc123'],
  ])('%s: alias at construction and after startInteractive', async (_name, config, thread) => {
    const s = make(config);
    expect(s.claudeSessionId).toBe(thread);
    await s.startInteractive().catch(() => undefined);
    expect(s.claudeSessionId).toBe(thread);
  });

  it('a fresh session with no resume keeps its own id', () => {
    const s = make({ mode: 'pi' });
    expect(s.claudeSessionId).toBe(s.id);
  });
});
