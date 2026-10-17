/**
 * @fileoverview The shared sensitive-path blocklist (`src/web/sensitive-path.ts`).
 *
 * This list guards every browser-facing file surface: workspace download,
 * cross-workspace attachment registration, raw/preview serving, and the
 * filesystem path picker.
 *
 * It became load-bearing when the picker gained `showHidden` (issue #221).
 * Before that, the picker refused any path with a dot-prefixed segment, so most
 * of the credential locations below were unreachable by construction and the
 * list only had to cover secrets that sit in plain sight. Opting into hidden
 * entries removes that accident, which is why each entry is pinned here: a
 * pattern silently dropped in a refactor would re-expose a real token.
 *
 * The list is a BLOCKLIST by design (cross-workspace attachment is a supported
 * feature), so the "stays attachable" cases matter just as much: over-blocking
 * breaks the publish skill and the review-card loop.
 */
import { homedir } from 'node:os';
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { isSensitivePath } from '../src/web/sensitive-path.js';

const HOME = '/home/dev';

describe('isSensitivePath', () => {
  afterEach(() => vi.unstubAllEnvs());
  describe('Fleet runtime secrets', () => {
    it('keeps nested conventional stores and credential trees protected', () => {
      expect(isSensitivePath(`${HOME}/.fleet/archive/.codeman/state.json`)).toBe(true);
      expect(isSensitivePath(`${HOME}/.fleet/.fleet-shared/external-chat.json`)).toBe(true);
      expect(isSensitivePath(`${HOME}/.fleet/accounts/.fleet-profile/report.md`)).toBe(true);
    });
    it.each(['.fleet', '.fleet-team', '.codeman', '.codeman-beta'])(
      'protects secret and state members in %s',
      (directory) => {
        for (const member of [
          'hook-secret',
          'users.json',
          'state.json',
          'state-inner.json',
          'settings.json',
          'push-keys.json',
          'intents.json',
          'external-chat.json',
          'chatrooms.json',
          'chatrooms.json.audit.jsonl',
          'admin-audit.jsonl',
          'company.json',
          'company-research.json',
          'external-chat.json.123.random.tmp',
          'state.json.bak',
          'users.json.123.random.tmp',
          'certs/key.pem',
          'chatroom-files-deleted/room-1/a.png',
          'custom-model-configs/profile.json',
          'docker-seeds/claude.seed.json',
        ]) {
          expect(isSensitivePath(`${HOME}/${directory}/${member}`), member).toBe(true);
        }
        expect(isSensitivePath(`${HOME}/${directory}/screenshots/review.png`)).toBe(false);
        expect(isSensitivePath(`${HOME}/${directory}/research/report.md`)).toBe(false);
        expect(isSensitivePath(`${HOME}/${directory}/external-chat.json.example`)).toBe(false);
      }
    );
    it.each(['FLEET_DATA_DIR', 'CODEMAN_DATA_DIR'])(
      'protects explicit %s without hiding ordinary artifacts or adjacent directories',
      (key) => {
        vi.stubEnv(key, join(homedir(), 'private-console'));
        for (const member of [
          'external-chat.json',
          'state.json',
          'settings.json',
          'users.json',
          'company.json',
          'intents.json',
          'push-keys.json',
          'hook-secret',
          'certs/key.pem',
          'accounts/profile/opencode/auth.json',
          'custom-model-hosts.json',
          'webhook.json',
          'push-subscriptions.json',
        ]) {
          expect(isSensitivePath(join(homedir(), 'private-console', member)), member).toBe(true);
        }
        expect(isSensitivePath(join(homedir(), 'private-console', 'screenshots', 'review.png'))).toBe(false);
        expect(isSensitivePath(join(homedir(), 'private-console-sibling', 'external-chat.json'))).toBe(false);
        expect(isSensitivePath(join(homedir(), 'project', 'settings.json'))).toBe(false);
      }
    );
    it('protects the real target of a configured symlink directory', () => {
      const actual = fs.mkdtempSync(join(homedir(), 'sensitive-runtime-'));
      const alias = `${actual}-alias`;
      fs.symlinkSync(actual, alias, 'dir');
      vi.stubEnv('FLEET_DATA_DIR', alias);
      expect(isSensitivePath(join(actual, 'external-chat.json'))).toBe(true);
      expect(isSensitivePath(join(alias, 'external-chat.json'))).toBe(true);
      expect(isSensitivePath(join(actual, 'research', 'finding.md'))).toBe(false);
    });
  });
  describe('blocks', () => {
    const blocked: Array<[string, string]> = [
      ['system shadow file', '/etc/shadow'],
      ['system gshadow file', '/etc/gshadow'],
      ['BSD master password db', '/etc/master.passwd'],

      ['ssh keys in home', `${HOME}/.ssh/id_ed25519`],
      // Not only under homedir(): a deploy key in a project is the same secret,
      // and the old homedir()-anchored pattern was captured at module load.
      ['ssh keys anywhere', '/srv/deploy/.ssh/id_rsa'],
      ['gpg keyring', `${HOME}/.gnupg/private-keys-v1.d/key.key`],

      ['dotenv', '/srv/app/.env'],
      ['suffixed dotenv', '/srv/app/.env.production'],
      // Pre-existing and deliberate: `.env.*` is blocked wholesale, so even a
      // committed `.env.example` is refused rather than risking the one repo
      // whose "example" holds a live key.
      ['a dotenv example', '/srv/app/.env.example'],

      ['generic credentials file', '/srv/app/credentials'],
      ['json credentials', '/srv/app/credentials.json'],
      ['toml credentials', '/srv/app/credentials.toml'],
      ['aws credentials', `${HOME}/.aws/credentials`],
      ['aws config', `${HOME}/.aws/config`],
      ['aws sso cache', `${HOME}/.aws/sso/cache/abc.json`],
      ['legacy gcloud credential db', `${HOME}/.gcloud/credentials.db`],
      ['modern gcloud config tree', `${HOME}/.config/gcloud/application_default_credentials.json`],
      ['azure profile', `${HOME}/.azure/accessTokens.json`],
      ['docker registry auth', `${HOME}/.docker/config.json`],
      ['kubernetes context', `${HOME}/.kube/config`],

      ['npm token', `${HOME}/.npmrc`],
      ['yarn token', `${HOME}/.yarnrc.yml`],
      ['git credential store', `${HOME}/.git-credentials`],
      ['gh cli token', `${HOME}/.config/gh/hosts.yml`],
      ['hub token', `${HOME}/.config/hub`],
      ['netrc', `${HOME}/.netrc`],
      ['windows netrc', `${HOME}/_netrc`],
      ['pypi token', `${HOME}/.pypirc`],
      ['rubygems token', `${HOME}/.gem/credentials`],
      ['cargo token', `${HOME}/.cargo/credentials.toml`],
      ['terraform cli config', `${HOME}/.terraformrc`],
      ['terraform credentials dir', `${HOME}/.terraform.d/credentials.tfrc.json`],

      ['postgres password file', `${HOME}/.pgpass`],
      ['mysql client config', `${HOME}/.my.cnf`],

      ['claude oauth token', `${HOME}/.claude/.credentials.json`],
      ['codeman hook secret', `${HOME}/.codeman/hook-secret`],
      ['codeman user table', `${HOME}/.codeman/users.json`],
      ['codeman hook secret on a named instance', `${HOME}/.codeman-beta/hook-secret`],
      // state.json persists SessionState.envOverrides, and the env allowlist
      // admits key-shaped names (GEMINI_API_KEY, CLAUDE_CODE_*), so it can hold
      // a live credential. Named once .json became previewable from outside the
      // workspace.
      ['codeman state file', `${HOME}/.codeman/state.json`],
      ['codeman state file on a named instance', `${HOME}/.codeman-beta/state.json`],
      ['codeman state sibling (same payload)', `${HOME}/.codeman/state-inner.json`],
      // settings.json holds voiceSettings.apiKey by schema; push-keys.json holds
      // the VAPID PRIVATE key; intents.json is 0600 because captured prompts can
      // contain secrets and is deliberately kept out of /api/search.
      ['codeman settings (Deepgram key)', `${HOME}/.codeman/settings.json`],
      ['codeman push keys (VAPID private)', `${HOME}/.codeman/push-keys.json`],
      ['codeman intent profiles', `${HOME}/.codeman/intents.json`],
      ['codeman intents on a named instance', `${HOME}/.codeman-beta/intents.json`],
    ];

    it.each(blocked)('blocks the %s', (_label, path) => {
      expect(isSensitivePath(path)).toBe(true);
    });
  });

  describe('leaves ordinary files attachable', () => {
    const allowed: Array<[string, string]> = [
      ['a source file', '/srv/app/src/index.ts'],
      ['a dotfile that carries no secret', '/srv/app/.gitignore'],
      ['a hidden CI directory', '/srv/app/.github/workflows/ci.yml'],
      // The publish skill and the review-card loop attach from these trees, so
      // only their named secret members are blocked, never the whole tree.
      ['a codeman screenshot', `${HOME}/.codeman/screenshots/shot.png`],
      ['a codeman lifecycle log', `${HOME}/.codeman/session-lifecycle.jsonl`],
      ['a claude transcript', `${HOME}/.claude/projects/proj/session.jsonl`],
      ['a claude team inbox', `${HOME}/.claude/teams/alpha/inboxes/bob.json`],
      // isUnderTree-style separator awareness: a sibling name that merely starts
      // with a blocked segment must not be caught.
      ['an unrelated sshd notes file', '/srv/notes/.sshd-setup.md'],
      ['a file named credentials-policy.md', '/srv/app/credentials-policy.md'],
    ];

    it.each(allowed)('allows %s', (_label, path) => {
      expect(isSensitivePath(path)).toBe(false);
    });
  });

  it('matches on the resolved path, so callers must realpath first', () => {
    // The function itself is pure string matching; this pins the contract its
    // docblock states, which every caller depends on.
    expect(isSensitivePath('/srv/app/looks-innocent')).toBe(false);
    expect(isSensitivePath(`${HOME}/.ssh/looks-innocent`)).toBe(true);
  });

  describe('home-anchored Claude config (credential-bearing by schema)', () => {
    // ~/.claude/settings.json can hold `env: {ANTHROPIC_API_KEY}` and
    // `apiKeyHelper` by schema (settings.local.json shares it), and
    // ~/.claude.json holds account/OAuth-adjacent state. These are anchored to
    // the REAL homedir, read at CHECK time — test/setup.ts points HOME at a
    // per-file fixture, so a homedir() captured at module load would be a
    // different directory than the one this suite resolves.
    const home = homedir();

    it.each([
      ['claude account state', `${home}/.claude.json`],
      ['claude user settings', `${home}/.claude/settings.json`],
      ['claude user local settings', `${home}/.claude/settings.local.json`],
    ])('blocks the %s', (_label, path) => {
      expect(isSensitivePath(path)).toBe(true);
    });

    // A blanket `/\.claude\/settings\.json$/` would also catch every CASE-level
    // settings file, which users legitimately view and edit in the File Viewer
    // (model override, hooks) — the home anchor is what keeps those servable.
    it.each([
      ['a case-level .claude/settings.json', '/srv/app/.claude/settings.json'],
      ['a case-level .claude/settings.local.json', '/srv/app/.claude/settings.local.json'],
      ['a .claude/settings.json under some OTHER home', `${HOME}/.claude/settings.json`],
      ['a .claude.json under some OTHER home', `${HOME}/.claude.json`],
    ])('keeps %s servable', (_label, path) => {
      expect(isSensitivePath(path)).toBe(false);
    });
  });
});
