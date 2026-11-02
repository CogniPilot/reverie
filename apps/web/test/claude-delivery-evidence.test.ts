/** Transcript evidence for a chat delivery: the session's own file, a new turn after the mark, the full line exactly. */
import { appendFile, mkdir, mkdtemp, rm, symlink, truncate, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDeliveredTurn, locateClaudeTranscript, markTranscript } from '../src/claude-delivery-evidence.js';

const ID = '11111111-2222-4333-8444-555555555555';
const LINE = '[Reverie chat "office"] Speaker: "please check" (reply: reverie agent chat say "..."; full history: reverie agent chat read)';
let config: string, file: string;
const row = (value: unknown) => JSON.stringify(value) + '\n';
const user = (content: unknown, extra: Record<string, unknown> = {}) => row({ type: 'user', message: { role: 'user', content }, ...extra });

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), 'claude-evidence-'));
  await mkdir(join(config, 'projects', '-owned-case'), { recursive: true });
  file = join(config, 'projects', '-owned-case', `${ID}.jsonl`);
  await writeFile(file, user('earlier turn') + user(LINE));
});
afterEach(async () => { await rm(config, { recursive: true, force: true }); });

describe('locating the transcript', () => {
  it('finds exactly the session\'s own file and nothing else', async () => {
    expect(await locateClaudeTranscript(ID, config)).toBe(file);
    expect(await locateClaudeTranscript('not-an-id', config)).toBeUndefined();
    expect(await locateClaudeTranscript('99999999-2222-4333-8444-555555555555', config)).toBeUndefined();
  });

  it('refuses two files for one id, and a symlink', async () => {
    await mkdir(join(config, 'projects', '-moved-case'));
    await writeFile(join(config, 'projects', '-moved-case', `${ID}.jsonl`), '');
    expect(await locateClaudeTranscript(ID, config)).toBeUndefined();
    await rm(join(config, 'projects', '-moved-case'), { recursive: true });
    await rm(file); await symlink(join(config, 'elsewhere.jsonl'), file);
    await writeFile(join(config, 'elsewhere.jsonl'), user(LINE));
    expect(await locateClaudeTranscript(ID, config)).toBeUndefined();
    expect(await markTranscript(file)).toBeUndefined();
  });
});

describe('finding the delivered turn', () => {
  it('ignores the same line already in the transcript before the mark', async () => {
    const mark = (await markTranscript(file))!;
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBeUndefined();
    await appendFile(file, user(LINE));
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBe(mark.offset);
  });

  it('matches the full line inside an expanded paste or a text block, never a prefix or another kind of row', async () => {
    const mark = (await markTranscript(file))!;
    await appendFile(file, user(LINE.slice(0, -1)) + row({ type: 'assistant', message: { role: 'assistant', content: LINE } }) +
      user([{ type: 'tool_result', content: LINE }]) + user(LINE, { isSidechain: true }));
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBeUndefined();
    const before = (await markTranscript(file))!.offset;
    const long = 'x'.repeat(5000) + '\nsecond line\nthird line\n' + LINE;
    await appendFile(file, user([{ type: 'text', text: `Pasted:\n${long}\n` }]));
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBe(before);
    expect(await findDeliveredTurn(mark, long, new Set())).toBe(before);
  });

  it('gives each identical delivery its own turn', async () => {
    const mark = (await markTranscript(file))!;
    await appendFile(file, user(LINE));
    const first = await findDeliveredTurn(mark, LINE, new Set());
    expect(first).toBe(mark.offset);
    expect(await findDeliveredTurn(mark, LINE, new Set([first!]))).toBeUndefined();
    await appendFile(file, user(LINE));
    expect(await findDeliveredTurn(mark, LINE, new Set([first!]))).toBeGreaterThan(first!);
  });

  it('waits for a complete row', async () => {
    const mark = (await markTranscript(file))!;
    await appendFile(file, user(LINE).slice(0, -1));
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBeUndefined();
    await appendFile(file, '\n');
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBe(mark.offset);
  });

  it('is no evidence once the transcript was replaced, shrunk or removed', async () => {
    let mark = (await markTranscript(file))!;
    await appendFile(file, user(LINE));
    await writeFile(file + '.new', user(LINE) + user(LINE) + user(LINE)); await rename(file + '.new', file);
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBeUndefined();
    mark = (await markTranscript(file))!;
    await truncate(file, 10);
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBeUndefined();
    await rm(file);
    expect(await findDeliveredTurn(mark, LINE, new Set())).toBeUndefined();
  });
});
