/** The state store's part of the owner's rebuild of a session this office
 * process launched itself: a real StateStore, a real Session and the real
 * launch publication it owns. No pane, container or provider is involved. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import type { SessionState } from '../src/types.js';

const sid = '70000000-0000-4000-8000-000000000007';
const FOREIGN = 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
/** A boxed viewer whose launch this process published and still owns. */
async function launched() {
  const directory = mkdtempSync(join(tmpdir(), 'rebuild-live-launch-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new StateStore(join(directory, 'state.json'));
  const data = {
    id: sid,
    name: 'Synthetic',
    mode: 'claude',
    claudeMode: 'normal',
    allowedTools: 'Read',
    workingDir: '/workspace',
    status: 'busy',
    pid: 23,
    createdAt: 1,
    lastActivityAt: 1,
    currentTaskId: null,
    docker: {
      hostId: 'boxed-runtime',
      label: 'Docker-contained employee',
      engine: 'docker',
      image: 'sha256:' + 'e'.repeat(64),
      containerName: 'a'.repeat(64),
      hostWorkspacePath: '/',
      containerWorkdir: '/workspace',
      network: 'bridge',
      mountCredentials: false,
      hooksEnabled: false,
      resumeOnStart: true,
      owned: false,
      daemonHost: 'unix:///run/reverie-engine/docker.sock',
      continuation: {
        operationId: '30000000-0000-4000-8000-000000000003',
        employeeId: '20000000-0000-4000-8000-000000000002',
        sessionGeneration: 3,
        clientManifestDigest: '4'.repeat(64),
        apiUrl: 'http://synthetic.invalid:3000',
      },
    },
  } as SessionState;
  store.setSession(sid, data);
  const viewer = new Session({ ...data, publicationStore: store });
  const publication = store.stageProviderLaunch(viewer, {
    transport: 'docker',
    current: () => true,
    snapshot: () => viewer.toPersistedState(),
  });
  await publication.prepare(viewer, {
    kind: 'mux',
    sessionId: sid,
    owner: null,
    mode: 'claude',
    command: 'controlled-known-returned-docker',
    cwd: '/workspace',
    environment: {},
  });
  publication.claim();
  publication.settle(true);
  cleanups.push(() => store.flush());
  return { store, viewer, data };
}

describe('a launch that its own live viewer still owns', () => {
  it('blocks the absent-laptop workflow and any other subject, but not the rebuild that discards that viewer', async () => {
    const f = await launched();
    expect(f.store.dockerAbsentReprovisionBlocker(sid, undefined)).toBe(FOREIGN);
    expect(f.store.absentLaptopViewOwnsLaunch(f.viewer)).toBe(true);
    expect(f.store.dockerAbsentReprovisionBlocker(sid, undefined, f.viewer)).toBeUndefined();
    // Another object for the same session ID owns nothing, and neither does a saved record.
    const other = new Session({ ...f.data, publicationStore: f.store });
    expect(f.store.absentLaptopViewOwnsLaunch(other)).toBe(false);
    expect(f.store.dockerAbsentReprovisionBlocker(sid, undefined, other)).toBe(FOREIGN);
    expect(f.store.dockerAbsentReprovisionBlocker(sid, undefined, { id: sid })).toBe(FOREIGN);
    // The other conditions are not relaxed: another owner's row stays foreign even for the viewer.
    expect(f.store.dockerAbsentReprovisionBlocker(sid, 'someone-else', f.viewer)).toBe(FOREIGN);
  });
  it('releases only the viewer’s own launch, keeps the row as an unowned denial and is idempotent', async () => {
    const f = await launched();
    const other = new Session({ ...f.data, publicationStore: f.store });
    expect(() => f.store.releaseAbsentLaptopViewLaunch(other)).toThrow('another launch owns this session');
    expect(f.store.dockerAbsentReprovisionBlocker(sid, undefined)).toBe(FOREIGN);
    f.store.releaseAbsentLaptopViewLaunch(f.viewer);
    // Exactly what a restarted office would hold: no live owner, so the absent-laptop workflow may clear the row.
    expect(f.store.absentLaptopViewOwnsLaunch(f.viewer)).toBe(false);
    expect(f.store.dockerAbsentReprovisionBlocker(sid, undefined)).toBeUndefined();
    f.store.releaseAbsentLaptopViewLaunch(f.viewer);
    f.store.releaseAbsentLaptopViewLaunch(other);
    expect(f.store.dockerAbsentReprovisionBlocker(sid, undefined)).toBeUndefined();
    // The denial itself is still on record for the discarded viewer: it may not launch again.
    expect(f.store.providerLaunchHeldFor(f.viewer)).toBe(true);
  });
});
