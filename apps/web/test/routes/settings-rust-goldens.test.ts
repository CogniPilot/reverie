/**
 * Byte goldens for the Rust GET /api/settings handler, produced by the real TS route behind the real
 * response envelope and route error handler.
 *
 * The cases manifest and the goldens live with the Rust crate (crates/reverie-routes); the Rust test reads
 * the same two files, so both implementations answer to one recorded response per case. Each case gets a
 * fresh root with the settings file at <root>/data/settings.json (or that path relative to cwd <root>).
 * RECORD_RUST_GOLDENS=1 rewrites goldens.json from this route instead of comparing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { installResponseEnvelope } from '../../src/web/response-envelope.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSettingsGet } from '../../src/web/routes/settings-get-route.js';

// The Nix web derivation is flattened to apps/web, so package.nix copies the two files into test/fixtures.
const copied = resolve(import.meta.dirname, '../fixtures/settings');
const source = resolve(import.meta.dirname, '../../../../crates/reverie-routes/tests/fixtures/settings');
const fixtures = existsSync(join(copied, 'cases.json')) ? copied : source;
const RECORD = process.env.RECORD_RUST_GOLDENS === '1';
/** Bodies longer than this are pinned by length and digest instead of their bytes. */
const INLINE_BYTES = 8192;

type Case = {
  name: string;
  kind: 'file' | 'missing' | 'dir' | 'unreadable';
  text?: string;
  hex?: string;
  nest?: { open: string; inner?: string; close: string; depth: number };
  fill?: { prefix: string; char: string; suffix: string; bytes: number };
  relative?: boolean;
  deviation?: string;
};
type Golden = { status: number; contentType: string; bodyHex?: string; bodyLength?: number; bodySha256?: string };

const cases = (JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')) as { cases: Case[] }).cases;
const saved = process.cwd();
afterEach(() => process.chdir(saved));

/** The file's bytes; every generated shape is ASCII outside `text` and `hex`. */
export function contents(testCase: Case): Buffer {
  if (testCase.hex !== undefined) return Buffer.from(testCase.hex, 'hex');
  if (testCase.nest) {
    const { open, inner = '', close, depth } = testCase.nest;
    return Buffer.from(open.repeat(depth) + inner + close.repeat(depth));
  }
  if (testCase.fill) {
    const { prefix, char, suffix, bytes } = testCase.fill;
    return Buffer.from(prefix + char.repeat(bytes - prefix.length - suffix.length) + suffix);
  }
  return Buffer.from(testCase.text ?? '');
}

async function respond(testCase: Case): Promise<Golden> {
  const root = mkdtempSync(join(tmpdir(), 'settings-golden-'));
  try {
    mkdirSync(join(root, 'data'));
    const absolute = join(root, 'data', 'settings.json');
    if (testCase.kind === 'dir') mkdirSync(absolute);
    if (testCase.kind === 'file' || testCase.kind === 'unreadable') writeFileSync(absolute, contents(testCase));
    if (testCase.kind === 'unreadable') chmodSync(absolute, 0o000);
    process.chdir(root);
    const app = Fastify();
    try {
      installResponseEnvelope(app, '');
      registerSettingsGet(app, {
        settingsPath: testCase.relative ? join('data', 'settings.json') : absolute,
        verifiedOwner: () => false,
      });
      installRouteErrorHandler(app);
      await app.ready();
      const reply = await app.inject('/api/settings');
      const body = reply.rawPayload;
      return {
        status: reply.statusCode,
        contentType: String(reply.headers['content-type']),
        ...(body.length <= INLINE_BYTES
          ? { bodyHex: body.toString('hex') }
          : { bodyLength: body.length, bodySha256: createHash('sha256').update(body).digest('hex') }),
      };
    } finally {
      await app.close();
    }
  } finally {
    process.chdir(saved);
    rmSync(root, { recursive: true, force: true });
  }
}

describe('GET /api/settings goldens for the Rust handler', () => {
  it('records or matches every case', async () => {
    const answers: Record<string, Golden> = {};
    for (const testCase of cases) answers[testCase.name] = await respond(testCase);
    const path = join(fixtures, 'goldens.json');
    if (RECORD) writeFileSync(path, JSON.stringify({ cases: answers }, null, 1) + '\n');
    const goldens = JSON.parse(readFileSync(path, 'utf8')) as { cases: Record<string, Golden> };
    expect(answers).toEqual(goldens.cases);
  }, 120_000);
});
