import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '../src/config/instance.js';
import { getCli, registryFilePath, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import { WebServer } from '../src/web/server.js';
import { rebootResumeTarget } from '../src/utils/native-thread-profile.js';
import type { SessionState } from '../src/types.js';

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
});

it('reads only the selected account and declared rollout codec, without granting restore eligibility', async () => {
  const root = join(getDataDir(), 'owned-history-accounts');
  const selected = join(root, 'selected'),
    defaultAccount = join(root, 'default');
  vi.stubEnv('CODEX_HOME', defaultAccount);
  const rollout = (account: string, id: string, thread: string) => {
    const path = join(account, 'sessions', `${thread}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: thread,
          cwd: root,
          originator: `reverie_${id}`,
          base_instructions: { text: 'fixture'.repeat(300) },
        },
      }) + '\n'
    );
  };
  const profilePath = join(getDataDir(), 'subscription-profiles.json');
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(
    profilePath,
    JSON.stringify([
      { id: 'selected', label: 'Selected', provider: 'openai', configDir: selected, openCodeDataDir: root },
      {
        id: 'foreign',
        label: 'Other provider',
        provider: 'anthropic',
        configDir: defaultAccount,
        openCodeDataDir: root,
      },
    ]),
    { mode: 0o600 }
  );
  const custom = structuredClone(getCli('codex')!);
  custom.id = 'custom-reader' as typeof custom.id;
  const nonReader = { ...custom, id: 'custom-nonreader', capabilities: { ...custom.capabilities, transcript: 'none' } };
  const incompatible = structuredClone(custom);
  incompatible.id = 'custom-incompatible' as typeof incompatible.id;
  delete incompatible.launch.threadStateProfile;
  delete incompatible.capabilities.rebootRestore;
  incompatible.launch.legacyConfigAliases = { ...incompatible.launch.legacyConfigAliases, resumeId: 'unrelated' };
  mkdirSync(dirname(registryFilePath()), { recursive: true });
  writeFileSync(
    registryFilePath(),
    JSON.stringify({
      schemaVersion: 1,
      clis: { 'custom-reader': custom, 'custom-nonreader': nonReader, 'custom-incompatible': incompatible },
    }),
    { mode: 0o600 }
  );
  reloadCliRegistry();
  for (const mode of ['custom-reader', 'custom-nonreader', 'custom-incompatible']) expect(getCli(mode)).toBeDefined();
  const saved = (id: string, mode: string, profile?: string): SessionState =>
    ({
      id,
      mode,
      workingDir: root,
      pid: 42,
      status: 'idle',
      currentTaskId: null,
      createdAt: Date.now(),
      codexConfig: { resumeSessionId: 'preserved' },
      ...(profile
        ? {
            subscriptionProfile: {
              id: profile,
              label: profile,
              provider: profile === 'foreign' ? 'anthropic' : 'openai',
            },
          }
        : {}),
    }) as SessionState;
  const rows = {
    selected: saved('selected', 'codex', 'selected'),
    default: saved('default', 'codex'),
    missing: saved('missing', 'codex', 'missing'),
    foreign: saved('foreign', 'codex', 'foreign'),
    custom: saved('custom', 'custom-reader', 'selected'),
    nonreader: saved('nonreader', 'custom-nonreader', 'selected'),
    incompatible: saved('incompatible', 'custom-incompatible', 'selected'),
  };
  for (const id of Object.keys(rows)) {
    rollout(defaultAccount, id, `default-${id}`);
    rollout(selected, id, `selected-${id}`);
  }
  const setSession = vi.fn((id: keyof typeof rows, state: SessionState) => {
    rows[id] = state;
  });
  const method = (
    WebServer.prototype as unknown as {
      planRebootRestoreOffer(this: unknown, dead: string[], live: number): Promise<number>;
    }
  ).planRebootRestoreOffer;
  // A surviving pane ensures the real method returns before any reboot offer/native recovery.
  expect(await method.call({ store: { getSessions: () => rows, setSession } }, Object.keys(rows), 1)).toBe(0);
  expect(rows.selected.codexConfig?.resumeSessionId).toBe('selected-selected');
  expect(rows.default.codexConfig?.resumeSessionId).toBe('default-default');
  expect(rows.custom.codexConfig?.resumeSessionId).toBe('selected-custom');
  for (const id of ['missing', 'foreign', 'nonreader', 'incompatible'] as const)
    expect(rows[id].codexConfig?.resumeSessionId).toBe('preserved');
  expect(setSession.mock.calls.map(([id]) => id).sort()).toEqual(['custom', 'default', 'selected']);
  expect(rebootResumeTarget(rows.custom)).toBeUndefined();
});
