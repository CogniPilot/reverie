/**
 * @fileoverview `reverie agent memory` answers as python's `memory_cli` (the `reverie-memory` it replaces) did. Two
 * references from the unmodified python: the legacy recall fixture (27 synthetic stores and what memory_cli printed
 * outside a session) and memory-cli-reference.json (validation, remember, and in-session journal handling with the
 * `reverie agent journal` call stubbed; it records the exact journal argv python ran).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAgentCommands, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';
import { agentJournalRecall, agentJournalSave, type JournalSaveOptions } from '../src/cli-agent-journal.js';
import { agentMemory, MEMORY_INPUT_MAX, readInput, sessionJournal, type MemoryCliDeps } from '../src/cli-agent-memory.js';
import { legacyRecall } from '../src/legacy-recall.js';
import type { JournalPort } from '../src/mcp-memory-tools.js';
import { fakeEmbeddingService, fixture, stage } from './legacy-store-fixture.js';

interface Answer {
  rc: number;
  stdout: string;
  stderr: string;
}
interface CliCase {
  id: string;
  argv?: string[];
  stdin: string;
  names?: string;
  journal?: Answer;
  expect: { code: number; stdout: string; stderr: string };
  argvCalls: string[][];
}
const reference = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'memory-cli-reference.json'), 'utf8')
) as { cases: CliCase[] };
const INSTANCE = { id: 'a1', agent_name: 'Agent', owner_name: 'Owner', data_dir: '../state', persona: 'p' };

/** Deps whose requests are recorded and answered as a journal server that accepts everything would answer. */
function recorder(requests: RequestOptions[]): AgentDeps {
  return {
    ctx: { apiUrl: 'http://journal.invalid', selfId: 'self-session' },
    json: true,
    io: { out: () => {}, err: () => {} },
    request: async (_ctx, options) => {
      requests.push(options);
      return { status: 200, text: '', json: { success: true, data: { entries: [], entryId: 1, turnId: 't', replayed: false, payloadSha256: 'x' } } };
    },
  };
}

/** The journal as python's stub answered it, recording every request the verb would have sent. */
function stubJournal(answer: Answer, requests: RequestOptions[]): JournalPort {
  return async (verb) => {
    await verb(recorder(requests));
    return { code: answer.rc, out: answer.stdout ? [answer.stdout.replace(/\n$/, '')] : [], err: answer.stderr ? [answer.stderr] : [] };
  };
}

/** The requests the real `reverie agent journal ... --json` would send for an argv python ran. */
async function requestsFor(argv: string[]): Promise<RequestOptions[]> {
  const requests: RequestOptions[] = [];
  const [, , , verb, ...rest] = argv;
  expect(rest.at(-1)).toBe('--json');
  const args = rest.slice(0, -1);
  if (verb === 'recall') {
    const project = args.indexOf('--project');
    await agentJournalRecall(recorder(requests), [args[0]], undefined, project >= 0 ? args[project + 1] : undefined);
    return requests;
  }
  expect(verb).toBe('save');
  const options: Record<string, string | string[]> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    options[key] = ['tag', 'source', 'quote', 'ref'].includes(key) ? [...((options[key] as string[]) ?? []), args[i + 1]] : args[i + 1];
  }
  await agentJournalSave(recorder(requests), options as unknown as JournalSaveOptions);
  return requests;
}

async function inRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-')));
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** One run of the verb, printed the way the process prints (a newline after each line), the root masked. */
async function cli(deps: Omit<MemoryCliDeps, 'out' | 'err'>, root: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await agentMemory({ ...deps, out: (line) => out.push(line), err: (line) => err.push(line) });
  const text = (lines: string[]) => lines.map((line) => line + '\n').join('').replaceAll(root, '<root>');
  return { code, stdout: text(out), stderr: text(err) };
}

/** A root laid out as python's reference laid it out: home, the default instance, an empty state directory. */
function layout(root: string, names?: string) {
  const home = path.join(root, 'home');
  const config = path.join(root, 'config', 'agent.json');
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(config));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(config, JSON.stringify(INSTANCE));
  if (names !== undefined) {
    const file = path.join(home, 'reverie', 'companies', 'default', 'data', 'protected-people.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, names);
  }
  return { home, config };
}

let serviceUrl = '';
let closeService = async () => {};
beforeAll(async () => {
  ({ url: serviceUrl, close: closeService } = await fakeEmbeddingService());
});
afterAll(() => closeService());

describe('recall outside a session, as memory_cli printed it for the legacy recall reference', () => {
  for (const c of fixture.cases.filter((x) => !x.refuses)) {
    it(c.id, () =>
      inRoot(async (root) => {
        const { home, config } = await stage(c, root);
        const embedUrl = c.embed === 'service' ? serviceUrl : c.embed === 'down' ? 'http://127.0.0.1:1/v1' : '';
        const scope = c.request.project !== undefined ? { project: c.request.project } : { private: true };
        const got = await cli({
          input: JSON.stringify({ action: 'recall', query: c.request.query, ...scope }),
          instance: config,
          env: { HOME: home },
          recall: (instance, request) => legacyRecall(instance, request, { home, embedUrl, now: () => fixture.now }),
        }, root);
        expect(got).toEqual(c.expect);
      }));
  }
});

/** Python's json module words syntax errors its own way; the code and the error envelope still match. */
const JSON_SYNTAX = new Set(['malformed-json', 'empty-input']);

describe('the memory_cli reference: validation, remember, and the journal inside a session', () => {
  for (const c of reference.cases) {
    it(c.id, () =>
      inRoot(async (root) => {
        const { home } = layout(root, c.names);
        const argv = (c.argv ?? ['--instance', '<root>/config/agent.json']).map((a) => a.replace('<root>', root));
        const requests: RequestOptions[] = [];
        const got = await cli({
          input: c.stdin,
          instance: argv[1],
          env: { HOME: home },
          journal: c.journal ? stubJournal(c.journal, requests) : undefined,
        }, root);
        if (JSON_SYNTAX.has(c.id)) {
          expect(got.code).toBe(c.expect.code);
          expect(got.stdout).toBe('');
          expect(got.stderr).toMatch(/^\{"error": "Expecting [^"]+"\}\n$/);
        } else expect(got).toEqual(c.expect);
        const expected: RequestOptions[] = [];
        for (const call of c.argvCalls) expected.push(...(await requestsFor(call)));
        expect(requests).toEqual(expected);
      }));
  }

  it('covers recall, remember, both scopes and every journal outcome', () => {
    const ids = reference.cases.map((c) => c.id);
    expect(ids.length).toBe(36);
    expect(reference.cases.filter((c) => c.argvCalls.length).length).toBe(12);
  });
});

describe('named differences', () => {
  const remember = (fields: Record<string, unknown>) => JSON.stringify({ action: 'remember', private: true, ...fields });

  it('refuses a text field that is not text, where python used its repr', () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      for (const [key, value] of [['query', 5], ['text', ['a']], ['room', true], ['project', 1]] as const) {
        const input = key === 'query' || key === 'project'
          ? JSON.stringify({ action: 'recall', query: 'q', ...(key === 'project' ? {} : { private: true }), [key]: value })
          : remember({ text: 't', [key]: value });
        expect(await cli({ input, instance: config, env: { HOME: home } }, root)).toEqual({
          code: 1, stdout: '', stderr: `{"error": "${key} must be text"}\n`,
        });
      }
    }));

  it("keeps the memory tools' lengths: a query up to 500 characters, a memory text up to 2000", () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      const recall = async () => '[]';
      const run = (input: string) => cli({ input, instance: config, env: { HOME: home }, recall }, root);
      expect((await run(JSON.stringify({ action: 'recall', private: true, query: 'é'.repeat(500) }))).code).toBe(0);
      expect(await run(JSON.stringify({ action: 'recall', private: true, query: 'é'.repeat(501) }))).toEqual({
        code: 1, stdout: '', stderr: '{"error": "query must be at most 500 characters"}\n',
      });
      expect((await run(remember({ text: 'x'.repeat(2001) }))).stderr).toBe('{"error": "text must be at most 2000 characters"}\n');
      expect((await run(remember({ text: 'x'.repeat(2000) }))).stderr).toMatch(/^\{"error": "remember saves to your office journal/);
    }));

  it('refuses a save when the hard-floor check cannot run, instead of failing with its cause', () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      const screen = () => {
        throw new Error('names unreadable');
      };
      expect(await cli({ input: remember({ text: 'fine' }), instance: config, env: { HOME: home }, screen }, root)).toEqual({
        code: 1, stdout: '', stderr: '{"error": "the hard-floor check did not run; nothing was saved"}\n',
      });
    }));

  it('never creates or writes the old store, where python opened it before either action', () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      await cli({ input: remember({ text: 'fine' }), instance: config, env: { HOME: home } }, root);
      await cli({ input: JSON.stringify({ action: 'recall', private: true, query: 'q' }), instance: config, env: { HOME: home } }, root);
      expect(fs.readdirSync(path.join(root, 'state'))).toEqual([]);
    }));

  it('reads standard input as strict UTF-8 and only up to its bound', async () => {
    expect(await readInput(Readable.from([Buffer.from('{"a": "é"}')]))).toBe('{"a": "é"}');
    await expect(readInput(Readable.from([Buffer.from([0xff])]))).rejects.toThrow();
    await expect(readInput(Readable.from([Buffer.alloc(MEMORY_INPUT_MAX + 1, 0x20)]))).rejects.toThrow(/too large/);
  });
});

describe('the session journal', () => {
  it('is absent without a session id, as python tested', () => {
    expect(sessionJournal({})).toBeUndefined();
  });

  it("answers recall from the old store, with the guard's reason, when the session cannot be proven", () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      const env = { HOME: home, REVERIE_SESSION_ID: 'abc12345' };
      const got = await cli({
        input: JSON.stringify({ action: 'recall', private: true, query: 'q' }), instance: config, env, journal: sessionJournal(env),
      }, root);
      expect(got).toEqual({
        code: 0,
        stdout: '{"journal": [], "legacy": [], "note": "journal lookup failed (Not inside a Reverie-managed session (REVERIE_MUX is not 1); refusing to act.); these are only older, read-only results from the old store"}\n',
        stderr: '',
      });
    }));
});

describe('the command', () => {
  it('is `reverie agent memory`, with --instance', () => {
    const program = new Command();
    registerAgentCommands(program);
    const memory = program.commands.find((c) => c.name() === 'agent')!.commands.find((c) => c.name() === 'memory')!;
    expect(memory.options.map((o) => o.long)).toEqual(['--instance']);
  });
});
