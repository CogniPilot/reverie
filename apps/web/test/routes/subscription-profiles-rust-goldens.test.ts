/**
 * Byte goldens for the Rust GET /api/subscription-profiles handler, produced by the real TS route.
 *
 * The cases manifest and the goldens live with the Rust crate (crates/reverie-routes); the Rust test reads
 * the same two files, so both implementations answer to one recorded response per case. Each case gets a
 * fresh root with HOME=<root>/home, the data dir at <root>/data and the process cwd at <root>.
 * RECORD_RUST_GOLDENS=1 rewrites goldens.json from this route instead of comparing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Fastify from 'fastify';
import { registerSubscriptionProfileRoutes } from '../../src/web/routes/subscription-profile-routes.js';
import { subscriptionModes } from '../../src/subscription-profiles.js';
import { SubscriptionUsageReader } from '../../src/subscription-usage.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';

// The Nix web derivation is flattened to apps/web, so package.nix copies the two files into test/fixtures.
const copied = resolve(import.meta.dirname, '../fixtures/subscription-profiles');
const source = resolve(import.meta.dirname, '../../../../crates/reverie-routes/tests/fixtures/subscription-profiles');
const fixtures = existsSync(join(copied, 'cases.json')) ? copied : source;
const RECORD = process.env.RECORD_RUST_GOLDENS === '1';
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME'] as const;

type Entry = { path: string; text?: string; hex?: string; dir?: boolean; symlink?: string };
type Case = { name: string; env: Partial<Record<(typeof ENV_KEYS)[number], string>>; tree: Entry[] };
type Golden = { status: number; contentType: string; body: string };
type Goldens = { modes: { anthropic: string[]; openai: string[] }; cases: Record<string, Golden> };

const cases = (JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')) as { cases: Case[] }).cases;
const saved = { cwd: process.cwd(), env: { ...process.env } };
afterEach(() => {
  process.chdir(saved.cwd);
  process.env = { ...saved.env };
});

function materialize(root: string, tree: Entry[]): void {
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'data'));
  for (const entry of tree) {
    const path = join(root, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    if (entry.dir) mkdirSync(path, { recursive: true });
    else if (entry.symlink !== undefined) symlinkSync(entry.symlink.replaceAll('<ROOT>', root), path);
    else writeFileSync(path, entry.hex !== undefined ? Buffer.from(entry.hex, 'hex') : (entry.text ?? ''));
  }
}

async function respond(testCase: Case): Promise<Golden> {
  const root = mkdtempSync(join(tmpdir(), 'sp-golden-'));
  try {
    materialize(root, testCase.tree);
    process.env.HOME = join(root, 'home');
    process.env.REVERIE_DATA_DIR = join(root, 'data');
    for (const key of ENV_KEYS) {
      const value = testCase.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value.replaceAll('<ROOT>', root);
    }
    process.chdir(root);
    const app = Fastify();
    try {
      registerSubscriptionProfileRoutes(app, new SubscriptionUsageReader('test'), async () => [], trustedFixtureOwner);
      installRouteErrorHandler(app);
      await app.ready();
      const reply = await app.inject('/api/subscription-profiles');
      return {
        status: reply.statusCode,
        contentType: String(reply.headers['content-type']),
        body: reply.body.replaceAll(root, '<ROOT>'),
      };
    } finally {
      await app.close();
    }
  } finally {
    process.chdir(saved.cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

describe('subscription profile goldens for the Rust handler', () => {
  it('match the TS route byte for byte', async () => {
    const actual: Goldens = {
      modes: { anthropic: subscriptionModes('anthropic'), openai: subscriptionModes('openai') },
      cases: {},
    };
    for (const testCase of cases) actual.cases[testCase.name] = await respond(testCase);
    const path = join(source, 'goldens.json');
    if (RECORD) {
      writeFileSync(path, JSON.stringify(actual, null, 1) + '\n');
      return;
    }
    expect(actual).toEqual(JSON.parse(readFileSync(join(fixtures, 'goldens.json'), 'utf8')));
  });
});
