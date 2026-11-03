/**
 * @fileoverview `reverie agent publish` / `publish-text` against a real local git remote: the packet is a real bundle,
 * the publisher a separate clone, and every git call runs for real. Only `gh` and the Reverie API are faked.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HELD_DRAFT_BODY,
  addedLinesByFile,
  agentPublish,
  agentPublishText,
  spawnExec,
  watchChecks,
  type Exec,
  type PublishDeps,
} from '../src/cli-agent-publish.js';

const NAME = 'James Goppert';
const EMAIL = '473772+jgoppert@users.noreply.github.com';
const ID = `${NAME} <${EMAIL}>`;
const BRANCH = 'packet-publish';

let root: string;
let remote: string;
let author: string;
let publisher: string;

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: NAME,
      GIT_AUTHOR_EMAIL: EMAIL,
      GIT_COMMITTER_NAME: NAME,
      GIT_COMMITTER_EMAIL: EMAIL,
      ...env,
    },
  }).trim();
}

function commit(file: string, text: string, message: string, env: Record<string, string> = {}): string {
  writeFileSync(join(author, file), text);
  git(author, ['add', file]);
  git(author, ['commit', '-q', '--cleanup=verbatim', '-m', message], env);
  return git(author, ['rev-parse', 'HEAD']);
}

const signedMessage = (subject: string, extra = '') => `${subject}\n\n${extra}Signed-off-by: ${ID}\n`;

/** A sealed packet for `ref` in a new directory. */
function seal(
  ref: string,
  body = '## Summary\n\nAdds a thing.\n',
  title = 'feat: add a thing',
  branch = BRANCH
): string {
  const dir = mkdtempSync(join(root, 'packet-'));
  git(author, ['bundle', 'create', '-q', join(dir, 'source.bundle'), ref]);
  writeFileSync(join(dir, 'PR-TITLE.txt'), `${title}\n`);
  writeFileSync(join(dir, 'PR-BODY.md'), `## Branch Naming\n\n\`${branch}\`\n\n${body}`);
  const sums = ['source.bundle', 'PR-TITLE.txt', 'PR-BODY.md']
    .map(
      (f) =>
        `${createHash('sha256')
          .update(readFileSync(join(dir, f)))
          .digest('hex')}  ${f}`
    )
    .join('\n');
  writeFileSync(join(dir, 'SHA256SUMS'), `${sums}\n`);
  return dir;
}

interface Fake {
  deps: PublishDeps;
  gh: string[][];
  out: string[];
  err: string[];
}

/** Deps with real git, a scripted gh, and a Reverie API holding one room with `messages`. */
function fake(
  options: {
    messages?: Array<{ id: string; at: number; from: string; text: string }>;
    gh?: (args: string[]) => { code?: number; stdout?: string; stderr?: string };
  } = {}
): Fake {
  const gh: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === 'git') return spawnExec(cmd, args, opts);
    gh.push(args);
    const r = options.gh?.(args) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const request = (async (_ctx: unknown, req: { path: string }) => {
    if (req.path === '/api/company')
      return { status: 200, json: { success: true, data: { employees: [{ name: 'Dana' }] } } };
    if (req.path === '/api/v1/chatrooms')
      return {
        status: 200,
        json: { success: true, data: { rooms: [{ id: 'room-0001-aaaa', name: 'reviews', kind: 'room' }] } },
      };
    if (req.path.endsWith('/messages')) {
      const limit = Number((req as { query?: { limit?: number } }).query?.limit ?? 30);
      const rows = (options.messages ?? []).slice(-limit);
      return {
        status: 200,
        json: {
          success: true,
          data: {
            messages: rows.map((m) => ({ ...m, from: { kind: 'agent', name: m.from }, to: 'all' })),
          },
        },
      };
    }
    return { status: 404, json: { success: false, error: 'not found' } };
  }) as unknown as PublishDeps['request'];
  return {
    deps: {
      ctx: {} as PublishDeps['ctx'],
      request,
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      json: false,
      exec,
      sleep: async () => {},
    },
    gh,
    out,
    err,
  };
}

const ghNoPr = (args: string[]) =>
  args[0] === 'pr' && args[1] === 'list'
    ? { stdout: '[]' }
    : args[1] === 'create'
      ? { stdout: 'https://github.com/o/r/pull/7\n' }
      : {};

const options = (packetDir: string) => ({ packetDir, repo: 'o/r', room: 'reviews', cwd: publisher });
const remoteBranch = () =>
  git(publisher, ['ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`]).split(/\s/)[0] ?? '';

let good: string;
let goodHead: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'publish-test-'));
  remote = join(root, 'remote.git');
  author = join(root, 'author');
  git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(root, ['clone', '-q', remote, author]);
  commit('README.md', 'base\n', 'base');
  git(author, ['push', '-q', 'origin', 'HEAD:main']);
  git(author, ['switch', '-q', '-c', BRANCH]);
  goodHead = commit('feature.txt', 'feature\n', signedMessage('feat: add a thing'));
  good = seal(BRANCH);
  publisher = clonePublisher('publisher');
});

/** A publisher checkout with the publish identity configured. `--no-local` copies only reachable objects; `lean` clones main only, as a fresh seat might. */
function clonePublisher(name: string, lean = false): string {
  const dir = join(root, name);
  git(root, ['clone', '-q', '--no-local', ...(lean ? ['--single-branch', '--branch', 'main'] : []), remote, dir]);
  git(dir, ['config', 'reverie.publishIdentity', ID]);
  return dir;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('agent publish', () => {
  it('checks everything on a dry run and pushes nothing', async () => {
    const f = fake({ gh: ghNoPr });
    expect(await agentPublish(f.deps, { ...options(good), dryRun: true })).toBe(0);
    expect(f.err).toEqual([]);
    expect(f.out[0]).toContain(`${goodHead.slice(0, 8)} → ${BRANCH}: 1 commit, all checks passed`);
    expect(remoteBranch()).toBe('');
    expect(f.gh.some((a) => a[1] === 'create')).toBe(false);
  });

  it('refuses while the room holds the packet, and publishes past an accepted hold', async () => {
    const messages = [{ id: 'hold-0001', at: 1, from: 'Reviewer', text: `HOLD ${BRANCH}: one test fails` }];
    const held = fake({ messages, gh: ghNoPr });
    expect(await agentPublish(held.deps, { ...options(good), dryRun: true })).toBe(4);
    expect(held.err.join('\n')).toContain('open hold from Reviewer (hold-000)');
    const lifted = fake({
      messages: [...messages, { id: 'go-1', at: 2, from: 'Reviewer', text: `GO ${goodHead.slice(0, 8)}` }],
      gh: ghNoPr,
    });
    expect(await agentPublish(lifted.deps, { ...options(good), dryRun: true })).toBe(0);
    const accepted = fake({ messages, gh: ghNoPr });
    expect(await agentPublish(accepted.deps, { ...options(good), dryRun: true, holdOk: ['hold-0001'] })).toBe(0);
    expect(accepted.out.join('\n')).toContain('published past hold hold-0001');
  });

  it('pushes the head and opens a held draft', async () => {
    const f = fake({ gh: ghNoPr });
    expect(await agentPublish(f.deps, options(good))).toBe(0);
    expect(remoteBranch()).toBe(goodHead);
    const create = f.gh.find((a) => a[1] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--draft', '--head', BRANCH, '--title', 'feat: add a thing']));
    expect(create[create.indexOf('--body') + 1]).toBe(HELD_DRAFT_BODY);
  });

  it('moves an existing branch only by fast-forward, cancelling the old head runs first', async () => {
    git(author, ['switch', '-q', BRANCH]);
    const next = commit('feature.txt', 'feature 2\n', signedMessage('feat: more'));
    // A thin increment: its only prerequisite is the published branch head, which the publisher must fetch.
    const ff = seal(`${goodHead}..${BRANCH}`);
    const lean = clonePublisher('lean', true);
    const f = fake({
      gh: (args) =>
        args[0] === 'pr' && args[1] === 'list'
          ? { stdout: '[{"number":7}]' }
          : args[0] === 'run' && args[1] === 'list'
            ? {
                stdout: JSON.stringify([
                  { databaseId: 11, headSha: goodHead, status: 'in_progress' },
                  { databaseId: 12, headSha: goodHead, status: 'completed' },
                ]),
              }
            : {},
    });
    expect(await agentPublish(f.deps, { ...options(ff), cwd: lean })).toBe(0);
    expect(remoteBranch()).toBe(next);
    expect(f.gh.filter((a) => a[1] === 'cancel')).toEqual([['run', 'cancel', '11', '--repo', 'o/r']]);
    expect(f.gh.some((a) => a[1] === 'create')).toBe(false);

    // A rewritten head that does not contain the remote one is refused.
    git(author, ['switch', '-q', '-c', 'rewrite', 'origin/main']);
    commit('other.txt', 'x\n', signedMessage('feat: rewritten'));
    const rewritten = seal('rewrite', undefined, undefined, BRANCH);
    const r = fake({ gh: ghNoPr });
    expect(await agentPublish(r.deps, { ...options(rewritten), cwd: lean })).toBe(4);
    expect(r.err.join('\n')).toContain('does not fast-forward');
    expect(remoteBranch()).toBe(next);
  });

  it('refuses attribution, a wrong identity, team names and an AI branch name', async () => {
    git(author, ['switch', '-q', '-c', 'bad', 'origin/main']);
    commit('a.txt', 'Dana wrote this\n', signedMessage('feat: a', 'Co-Authored-By: Helper <h@example.com>\n'), {
      GIT_AUTHOR_NAME: 'Someone',
      GIT_AUTHOR_EMAIL: 's@example.com',
    });
    const packet = seal('bad', 'Reviewed by Dana.\n', 'feat: a', 'claude-fix');
    const f = fake({ gh: ghNoPr });
    expect(await agentPublish(f.deps, { ...options(packet), dryRun: true })).toBe(4);
    const text = f.err.join('\n');
    for (const expected of [
      'branch name contains "claude"',
      'PR body names "Dana"',
      'author is Someone',
      'attribution trailer',
      'a.txt names "Dana"',
    ])
      expect(text).toContain(expected);
  });

  it('needs a configured identity, and --identity overrides the checkout config', async () => {
    const bare = join(root, 'no-identity');
    git(root, ['clone', '-q', remote, bare]);
    const f = fake({ gh: ghNoPr });
    expect(await agentPublish(f.deps, { ...options(good), cwd: bare, dryRun: true })).toBe(4);
    expect(f.err.join('\n')).toContain('no publish identity');
    const other = fake({ gh: ghNoPr });
    expect(
      await agentPublish(other.deps, { ...options(good), dryRun: true, identities: ['Someone <s@example.com>'] })
    ).toBe(4);
    expect(other.err.join('\n')).toContain(`author is ${ID}`);
  });

  it('verifies a bundle stacked on another branch only with --prereq', async () => {
    git(author, ['switch', '-q', '-c', 'base-track', 'origin/main']);
    const baseTip = commit('track.txt', 'one\n', signedMessage('feat: track one'));
    git(author, ['push', '-q', 'origin', 'base-track']);
    git(author, ['switch', '-q', '-c', 'track-two']);
    commit('track.txt', 'two\n', signedMessage('feat: track two'));
    const packet = seal(`${baseTip}..track-two`, undefined, undefined, 'track-two');
    const lean = clonePublisher('lean-prereq', true);
    const without = fake({ gh: ghNoPr });
    expect(await agentPublish(without.deps, { ...options(packet), cwd: lean, dryRun: true })).toBe(4);
    expect(without.err.join('\n')).toContain('--prereq');
    const withPrereq = fake({ gh: ghNoPr });
    expect(
      await agentPublish(withPrereq.deps, { ...options(packet), cwd: lean, dryRun: true, prereqs: ['base-track'] })
    ).toBe(0);
  });

  it('anchors the hold scan on room messages, never on commit dates', async () => {
    git(author, ['switch', '-q', '-c', 'future', 'origin/main']);
    const head = commit('future.txt', 'x\n', signedMessage('feat: future'), {
      GIT_AUTHOR_DATE: '2099-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z',
    });
    const packet = seal('future', undefined, undefined, 'future');
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      id: `f${i}`,
      at: 10 + i,
      from: 'Bot',
      text: 'unrelated',
    }));
    // The hold and the seal post sit inside a full window: found and refused, whatever the commit claims its date is.
    const held = [
      ...filler.slice(0, 500),
      { id: 'seal', at: 600, from: 'Author', text: `sealed ${head.slice(0, 8)}` },
      { id: 'hold', at: 601, from: 'Reviewer', text: 'NO-GO future: fails' },
      ...filler.slice(502),
    ];
    const f = fake({ messages: held, gh: ghNoPr });
    expect(await agentPublish(f.deps, { ...options(packet), dryRun: true })).toBe(4);
    expect(f.err.join('\n')).toContain('open hold from Reviewer');
    // A full window that never names the head cannot prove there is no hold.
    const blind = fake({ messages: filler, gh: ghNoPr });
    expect(await agentPublish(blind.deps, { ...options(packet), dryRun: true })).toBe(4);
    expect(blind.err.join('\n')).toContain(`names ${head.slice(0, 8)}`);
  });

  it('refuses a packet whose files do not match SHA256SUMS', async () => {
    const tampered = seal(BRANCH);
    writeFileSync(join(tampered, 'PR-TITLE.txt'), 'something else\n');
    const f = fake({ gh: ghNoPr });
    expect(await agentPublish(f.deps, { ...options(tampered), dryRun: true })).toBe(4);
    expect(f.err.join('\n')).toContain('PR-TITLE.txt does not match its digest');
  });
});

describe('agent publish-text', () => {
  it('sets the approved body without Branch Naming and reads it back', async () => {
    let posted = '';
    const f = fake({
      gh: (args) => {
        if (args[1] === 'view' && args.includes('headRefOid,headRefName'))
          return { stdout: JSON.stringify({ headRefOid: goodHead, headRefName: BRANCH }) };
        if (args[1] === 'edit') {
          posted = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
          return {};
        }
        if (args[1] === 'view') return { stdout: JSON.stringify({ body: posted.replace(/\n/g, '\r\n') }) };
        return {};
      },
    });
    expect(await agentPublishText(f.deps, { packetDir: good, repo: 'o/r', pr: 7 })).toBe(0);
    expect(posted).toBe('## Summary\n\nAdds a thing.\n');
  });

  it('refuses when the pull request has moved off the reviewed head or the body reads back different', async () => {
    const moved = fake({
      gh: (args) =>
        args[1] === 'view' ? { stdout: JSON.stringify({ headRefOid: 'f'.repeat(40), headRefName: BRANCH }) } : {},
    });
    expect(await agentPublishText(moved.deps, { packetDir: good, repo: 'o/r', pr: 7 })).toBe(4);
    expect(moved.gh.some((a) => a[1] === 'edit')).toBe(false);
    const differs = fake({
      gh: (args) =>
        args[1] === 'view'
          ? {
              stdout: JSON.stringify(
                args.includes('body') ? { body: 'edited elsewhere' } : { headRefOid: goodHead, headRefName: BRANCH }
              ),
            }
          : {},
    });
    expect(await agentPublishText(differs.deps, { packetDir: good, repo: 'o/r', pr: 7 })).toBe(4);
    expect(differs.err.join('\n')).toContain('reads back different');
  });
});

describe('watchChecks', () => {
  const rollup = (head: string, checks: Array<{ status: string; conclusion?: string }>) =>
    JSON.stringify({ headRefOid: head, statusCheckRollup: checks.map((c, i) => ({ name: `c${i}`, ...c })) });

  it('waits until enough checks ran and none is pending', async () => {
    const frames = [
      rollup('a'.repeat(40), [{ status: 'IN_PROGRESS' }]),
      rollup('a'.repeat(40), [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]),
      rollup('a'.repeat(40), [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ];
    const f = fake({ gh: () => ({ stdout: frames.shift() }) });
    const result = await watchChecks(f.deps, {
      repo: 'o/r',
      pr: 7,
      head: 'a'.repeat(40),
      minChecks: 2,
      timeoutMinutes: 5,
    });
    expect(result).toEqual({ state: 'failed', checks: 2, failed: ['c1'] });
  });

  it('stops when the head moves', async () => {
    const f = fake({ gh: () => ({ stdout: rollup('b'.repeat(40), []) }) });
    expect(
      (await watchChecks(f.deps, { repo: 'o/r', pr: 7, head: 'a'.repeat(40), minChecks: 1, timeoutMinutes: 5 })).state
    ).toBe('head-moved');
  });
});

describe('addedLinesByFile', () => {
  it('groups added lines by file and skips deletions', () => {
    const patch = ['--- a/x', '+++ b/x', '@@ -0,0 +1 @@', '+one', '--- a/y', '+++ /dev/null', '-gone'].join('\n');
    expect([...addedLinesByFile(patch)]).toEqual([['x', 'one\n']]);
  });
});
