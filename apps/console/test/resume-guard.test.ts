/**
 * 82d: every CLI's resume field is guarded, "resume the latest" forms are refused for agents, and a Claude resume never
 * silently starts fresh or picks one of two differing transcript copies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, promises as fsp, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkClaudeResume, hasConversationEntry, requestedResumes, foreignResumes, resolveTakeoverPolicy, resumeAlias, resumeRefusalForAgent, resumeTakeoverRoom } from '../src/web/resume-guard.js';

const MINE = 'mine-0000';
const OTHER = 'other-1111';
const owns = (id: string) => id === MINE;

describe('requestedResumes', () => {
  it('collects every id field and every "latest" form, across all CLIs', () => {
    const r = requestedResumes({
      resumeSessionId: 'a',
      openCodeConfig: { continueSession: 'ses_b' },
      codexConfig: { resumeSessionId: 'c' },
      geminiConfig: { resumeSession: 'd' },
      antigravityConfig: { resumeConversationId: 'e' },
      piConfig: { resumeSessionId: 'f', continueSession: true },
      grokConfig: { resumeSessionId: 'g', continueSession: true },
      ompConfig: { resumeSessionId: 'h', continueSession: true },
      deepSeekConfig: { resumeSessionId: 'i', resumeSession: true },
    });
    expect(r.ids.map((x) => x.id)).toEqual(['a', 'ses_b', 'c', 'e', 'f', 'g', 'h', 'i', 'd']);
    expect(r.latest).toEqual(['piConfig.continueSession', 'grokConfig.continueSession', 'ompConfig.continueSession', 'deepSeekConfig.resumeSession']);
  });

  it('treats a Gemini alias (latest, an index) as "latest", not as an id', () => {
    for (const alias of ['latest', 'LATEST', '3']) {
      const r = requestedResumes({ geminiConfig: { resumeSession: alias } });
      expect(r.ids).toEqual([]);
      expect(r.latest).toEqual(['geminiConfig.resumeSession']);
    }
  });
});

describe('resumeRefusalForAgent', () => {
  const each: Array<[string, object]> = [
    ['top-level', { resumeSessionId: OTHER }],
    ['opencode', { openCodeConfig: { continueSession: OTHER } }],
    ['codex', { codexConfig: { resumeSessionId: OTHER } }],
    ['gemini', { geminiConfig: { resumeSession: OTHER } }],
    ['antigravity', { antigravityConfig: { resumeConversationId: OTHER } }],
    ['pi', { piConfig: { resumeSessionId: OTHER } }],
    ['grok', { grokConfig: { resumeSessionId: OTHER } }],
    ['omp', { ompConfig: { resumeSessionId: OTHER } }],
    ['deepseek', { deepSeekConfig: { resumeSessionId: OTHER } }],
  ];
  it.each(each)('refuses another agent\'s conversation through %s', (_name, body) => {
    expect(resumeRefusalForAgent(body, owns)).toMatch(/only resume a conversation of its own/);
  });
  it.each([
    ['pi continue', { piConfig: { continueSession: true } }],
    ['grok continue', { grokConfig: { continueSession: true } }],
    ['omp continue', { ompConfig: { continueSession: true } }],
    ['deepseek resume', { deepSeekConfig: { resumeSession: true } }],
    ['gemini latest', { geminiConfig: { resumeSession: 'latest' } }],
  ])('refuses "the latest" form %s', (_name, body) => {
    expect(resumeRefusalForAgent(body, owns)).toMatch(/may not resume "the latest"/);
  });
  it('allows its own conversation through any field, and a body with no resume', () => {
    expect(resumeRefusalForAgent({ piConfig: { resumeSessionId: MINE } }, owns)).toBeNull();
    expect(resumeRefusalForAgent({ openCodeConfig: { continueSession: MINE } }, owns)).toBeNull();
    expect(resumeRefusalForAgent({}, owns)).toBeNull();
  });
  it('gives a successor the resumed id as its thread alias, whichever field named it', () => {
    expect(resumeAlias({ piConfig: { resumeSessionId: 'p1' } })).toBe('p1');
    expect(resumeAlias({ openCodeConfig: { continueSession: 'ses_x' } })).toBe('ses_x');
    expect(resumeAlias({ geminiConfig: { resumeSession: 'latest' } })).toBeUndefined();
    expect(resumeAlias({})).toBeUndefined();
  });
});

describe('checkClaudeResume', () => {
  afterEach(() => vi.restoreAllMocks());
  const ID = '00000009-000b-4000-8000-00000000000e';
  /** A transcript body: one real conversation line of this session, plus `extra`. */
  const conv = (extra = '') => JSON.stringify({ type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } }) + '\n' + extra;
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'resume-'));
    const a = join(root, 'acctA');
    const b = join(root, 'acctB');
    const put = (dir: string, body: string, mtimeSec: number, slug = '-work') => {
      mkdirSync(join(dir, 'projects', slug), { recursive: true });
      const f = join(dir, 'projects', slug, `${ID}.jsonl`);
      writeFileSync(f, body);
      utimesSync(f, mtimeSec, mtimeSec);
      return f;
    };
    const sidecar = (dir: string, name: string, body: string, slug = '-work') => {
      mkdirSync(join(dir, 'projects', slug, ID, 'tool-results'), { recursive: true });
      writeFileSync(join(dir, 'projects', slug, ID, 'tool-results', name), body);
    };
    const copiesIn = (dir: string) =>
      readdirSync(join(dir, 'projects')).flatMap((slug) => readdirSync(join(dir, 'projects', slug)).filter((n) => n === `${ID}.jsonl`).map((n) => join(slug, n)));
    return { a, b, put, sidecar, copiesIn };
  };

  it('refuses (404) when there is no transcript anywhere, instead of starting fresh', async () => {
    const { a, b } = setup();
    const r = await checkClaudeResume(ID, a, [b]);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('accepts a single copy in the target, and identical copies in two accounts', async () => {
    const { a, b, put } = setup();
    put(a, conv(), 1000);
    expect(await checkClaudeResume(ID, a, [b])).toEqual({ ok: true });
    put(b, conv(), 2000); // same content, different time
    expect(await checkClaudeResume(ID, a, [b])).toEqual({ ok: true });
  });

  it('an OLDER differing copy in another account (what a switch leaves behind) does not block, and is reported', async () => {
    const { a, b, put } = setup();
    put(a, conv('new work on the live account\n'), 9000);
    const left = put(b, conv(), 1000);
    const r = await checkClaudeResume(ID, a, [b]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.olderElsewhere?.[0]).toContain(left);
  });

  it('differing copies modified within 2 s of each other are ambiguous (409), either way round; 2.001 s is ordered', async () => {
    const { a, b, put } = setup();
    const at = (sec: number) => {
      put(a, conv('target\n'), 10);
      put(b, conv('other\n'), sec);
      return checkClaudeResume(ID, a, [b]);
    };
    for (const sec of [12, 8, 10, 11.5]) {
      const r = await at(sec);
      expect(r, String(sec)).toMatchObject({ ok: false, status: 409 });
      if (!r.ok) expect(r.error).toContain('within 2 s');
    }
    const newer = await at(12.001);
    expect(newer).toMatchObject({ ok: false, status: 409 });
    if (!newer.ok) expect(newer.error).toContain('a newer one is in another account');
    expect((await at(7.999)).ok).toBe(true);
    put(b, conv('target\n'), 11); // same content within 2 s: not ambiguous, nothing differs
    put(a, conv('target\n'), 10);
    expect(await checkClaudeResume(ID, a, [b])).toEqual({ ok: true });
  });

  it('a refresh will not pick between differing newest copies within 2 s (409), and copies nothing', async () => {
    const { a, b, put } = setup();
    const mine = put(a, conv('mine\n'), 10);
    put(b, conv('theirs\n'), 11.5);
    const r = await checkClaudeResume(ID, a, [b], true);
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.error).toContain('cannot be refreshed');
    expect(readFileSync(mine, 'utf8')).toBe(conv('mine\n'));
    expect(readdirSync(join(a, 'projects', '-work'))).toEqual([`${ID}.jsonl`]);
  });

  it('refuses (409) a copy only in another account, naming it, and refreshes only on request, with its sidecar dir', async () => {
    const { a, b, put, sidecar } = setup();
    const theirs = put(b, conv('newest\n'), 2000);
    sidecar(b, 'r1.txt', 'tool output');
    const r = await checkClaudeResume(ID, a, [b]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain(theirs);
      expect(r.error).toContain('not in');
    }
    expect(existsSync(join(a, 'projects'))).toBe(false); // a refusal copies nothing
    const fixed = await checkClaudeResume(ID, a, [b], true);
    expect(fixed.ok).toBe(true);
    expect(readFileSync(join(a, 'projects', '-work', `${ID}.jsonl`), 'utf8')).toBe(conv('newest\n'));
    expect(readFileSync(join(a, 'projects', '-work', ID, 'tool-results', 'r1.txt'), 'utf8')).toBe('tool output');
    expect(readdirSync(join(a, 'projects', '-work')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(await checkClaudeResume(ID, a, [b])).toEqual({ ok: true });
  });

  it('refuses (409) when a NEWER differing copy is elsewhere, naming both with times; a refresh keeps the older target copy and sidecar as backups', async () => {
    const { a, b, put, sidecar } = setup();
    const stale = put(a, conv(), 1000);
    sidecar(a, 'old.txt', 'old');
    const live = put(b, conv('plus three hours of work\n'), 9000);
    sidecar(b, 'new.txt', 'new');
    const r = await checkClaudeResume(ID, a, [b]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain(stale);
      expect(r.error).toContain(live);
      expect(r.error).toContain('copies differ');
      expect(r.error).toContain(new Date(9000 * 1000).toISOString());
    }
    const fixed = await checkClaudeResume(ID, a, [b], true, () => 42);
    expect(fixed).toMatchObject({ ok: true, refreshed: stale });
    expect(readFileSync(stale, 'utf8')).toBe(conv('plus three hours of work\n'));
    expect(readFileSync(`${stale}.bak-42`, 'utf8')).toBe(conv());
    const side = join(a, 'projects', '-work', ID);
    expect(readdirSync(join(side, 'tool-results'))).toEqual(['new.txt']);
    expect(readdirSync(join(`${side}.bak-42`, 'tool-results'))).toEqual(['old.txt']);
  });

  it("carries sidecar dirs from every slug (Claude writes them under the CURRENT cwd's slug, not the transcript's)", async () => {
    const { a, b, put, sidecar } = setup();
    put(b, conv('newest\n'), 9000, '-began-here');
    sidecar(b, 'r.txt', 'from the later cwd', '-resumed-from-here');
    sidecar(a, 'stale.txt', 'stale', '-somewhere-else');
    expect(await checkClaudeResume(ID, a, [b], true, () => 3)).toMatchObject({ ok: true, refreshed: join(a, 'projects', '-began-here', `${ID}.jsonl`) });
    expect(readFileSync(join(a, 'projects', '-resumed-from-here', ID, 'tool-results', 'r.txt'), 'utf8')).toBe('from the later cwd');
    expect(existsSync(join(a, 'projects', '-somewhere-else', ID))).toBe(false);
    expect(existsSync(join(a, 'projects', '-somewhere-else', `${ID}.bak-3`, 'tool-results', 'stale.txt'))).toBe(true);
  });

  it('copies in the target under two project slugs that differ are refused (409); a refresh sets aside every other one, leaving exactly one', async () => {
    const { a, b, put, sidecar, copiesIn } = setup();
    const other = put(a, conv('a different cwd\n'), 3000, '-elsewhere');
    sidecar(a, 'x.txt', 'x', '-elsewhere');
    put(a, conv(), 1000, '-work');
    const newest = put(b, conv('newest\n'), 9000, '-work');
    const r = await checkClaudeResume(ID, a, [b]);
    expect(r).toMatchObject({ ok: false, status: 409 });
    const fixed = await checkClaudeResume(ID, a, [b], true, () => 7);
    expect(fixed).toMatchObject({ ok: true, refreshed: join(a, 'projects', '-work', `${ID}.jsonl`), setAside: [other] });
    expect(copiesIn(a)).toEqual([join('-work', `${ID}.jsonl`)]);
    expect(readFileSync(`${other}.bak-7`, 'utf8')).toBe(conv('a different cwd\n'));
    expect(existsSync(join(a, 'projects', '-elsewhere', `${ID}.bak-7`, 'tool-results', 'x.txt'))).toBe(true);
    expect(readFileSync(join(a, 'projects', '-work', `${ID}.jsonl`), 'utf8')).toBe(readFileSync(newest, 'utf8'));
    expect(await checkClaudeResume(ID, a, [b])).toEqual({ ok: true });
  });

  it('two differing target copies with the newest already in the target: a refresh only sets the other aside', async () => {
    const { a, b, put, copiesIn } = setup();
    const keep = put(a, conv('newest\n'), 9000, '-work');
    const old = put(a, conv(), 1000, '-old');
    expect(await checkClaudeResume(ID, a, [b])).toMatchObject({ ok: false, status: 409 });
    expect(await checkClaudeResume(ID, a, [b], true, () => 5)).toMatchObject({ ok: true, refreshed: keep, setAside: [old] });
    expect(copiesIn(a)).toEqual([join('-work', `${ID}.jsonl`)]);
    expect(readdirSync(join(a, 'projects', '-work'))).toEqual([`${ID}.jsonl`]); // the kept copy is not touched
  });

  it('refuses (422) a transcript with no conversation entry for the id: empty, tiny invalid, metadata only, another id', async () => {
    const { a, b, put } = setup();
    for (const body of [
      '',
      'x\n',
      '{"type":"user","sessionId":', // truncated
      JSON.stringify({ type: 'custom-title', customTitle: 'Coordinator', sessionId: ID }) + '\n',
      JSON.stringify({ type: 'user', sessionId: 'another-id' }) + '\n',
    ]) {
      put(a, body, 1000);
      const r = await checkClaudeResume(ID, a, [b]);
      expect(r, JSON.stringify(body)).toMatchObject({ ok: false, status: 422 });
    }
    put(a, 'garbage first line\n' + conv(), 1000);
    expect(await checkClaudeResume(ID, a, [b])).toEqual({ ok: true });
  });

  it('a refresh from a newest copy with no conversation entry is refused (422) and copies nothing', async () => {
    const { a, b, put } = setup();
    const mine = put(a, conv(), 1000);
    put(b, '', 9000);
    expect(await checkClaudeResume(ID, a, [b], true)).toMatchObject({ ok: false, status: 422 });
    expect(readFileSync(mine, 'utf8')).toBe(conv());
    expect(readdirSync(join(a, 'projects', '-work'))).toEqual([`${ID}.jsonl`]);
  });

  it('a refresh that fails leaves the target transcript and sidecar as they were, and no temp copy behind', async () => {
    const { a, b, put, sidecar } = setup();
    const mine = put(a, conv(), 1000);
    sidecar(a, 'old.txt', 'old');
    put(b, conv('newest\n'), 9000);
    sidecar(b, 'new.txt', 'new');
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.jsonl') && String(from).includes('.tmp-')) throw new Error('disk full');
      return rename(from, to);
    });
    await expect(checkClaudeResume(ID, a, [b], true, () => 9)).rejects.toThrow('disk full');
    expect(readFileSync(mine, 'utf8')).toBe(conv());
    expect(readdirSync(join(a, 'projects', '-work', ID, 'tool-results'))).toEqual(['old.txt']);
    expect(readdirSync(join(a, 'projects', '-work')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(statSync(mine).isFile()).toBe(true);
  });

  it('hasConversationEntry stops at the first match in a long transcript', async () => {
    const { a, put } = setup();
    const f = put(a, conv('#'.repeat(1 << 20) + '\n'), 1000);
    expect(await hasConversationEntry(f, ID)).toBe(true);
  });
});

describe('resume takeover', () => {
  const gone = (id: string) => id === OTHER;
  it('lets a takeover predicate allow a foreign conversation', () => {
    expect(resumeRefusalForAgent({ resumeSessionId: OTHER }, owns, gone)).toBeNull();
    expect(resumeRefusalForAgent({ codexConfig: { resumeSessionId: OTHER } }, owns, gone)).toBeNull();
  });
  it('still refuses a conversation the predicate does not allow', () => {
    expect(resumeRefusalForAgent({ resumeSessionId: 'live-2222' }, owns, gone)).toMatch(/only resume a conversation of its own/);
  });
  it('refuses when any one of several ids is not allowed', () => {
    expect(resumeRefusalForAgent({ resumeSessionId: OTHER, codexConfig: { resumeSessionId: 'live-2222' } }, owns, gone)).toMatch(/of its own/);
  });
  it('never asks the predicate for an owned id, and never allows "latest"', () => {
    const ask = vi.fn(() => true);
    expect(resumeRefusalForAgent({ resumeSessionId: MINE }, owns, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(resumeRefusalForAgent({ piConfig: { continueSession: true } }, owns, () => true)).toMatch(/"the latest"/);
  });
  it('lists the foreign ids to audit', () => {
    expect(foreignResumes({ resumeSessionId: OTHER, codexConfig: { resumeSessionId: MINE } }, owns)).toEqual([OTHER]);
  });
});

describe('resumeTakeoverRoom (a coordinator continues a gone agent)', () => {
  const VERIFIER = { id: 'verifier-row', claudeSessionId: 'thread-01a1', claudeSessionChain: ['thread-old'], isRunning: () => false };
  const room = (over: Partial<{ id: string; name: string; archivedAt: number; members: Array<{ sessionId: string; role: string }> }> = {}) => ({
    id: 'r1',
    name: 'reverie',
    members: [
      { sessionId: 'reviewer', role: 'coordinator' },
      { sessionId: 'verifier-row', role: 'member' },
    ],
    ...over,
  });
  const ask = (over: Partial<Parameters<typeof resumeTakeoverRoom>[0]> = {}) =>
    resumeTakeoverRoom({ policy: 'coordinators', caller: 'reviewer', id: 'thread-01a1', sessions: [VERIFIER], rooms: [room()], ...over });

  it('allows the coordinator of a room the gone agent is in, and names the room and member', () => {
    expect(ask()).toEqual({ roomId: 'r1', roomName: 'reverie', memberSessionId: 'verifier-row' });
  });
  it('matches the row id and an earlier conversation in the chain too', () => {
    expect(ask({ id: 'verifier-row' })).not.toBeNull();
    expect(ask({ id: 'thread-old' })).not.toBeNull();
  });
  it('refuses a caller who is a member but not the coordinator', () => {
    expect(ask({ caller: 'coordinator', rooms: [room({ members: [{ sessionId: 'coordinator', role: 'member' }, { sessionId: 'verifier-row', role: 'member' }] })] })).toBeNull();
  });
  it('refuses a live agent, even if it is the room\'s member', () => {
    expect(ask({ sessions: [{ ...VERIFIER, isRunning: () => true }] })).toBeNull();
  });
  it('refuses when any session holding the conversation is still running', () => {
    expect(ask({ sessions: [VERIFIER, { id: 'verifier-2', claudeSessionId: 'thread-01a1', isRunning: () => true }] })).toBeNull();
  });
  it('refuses a room the caller does not coordinate (the gone agent is elsewhere)', () => {
    const other = room({ id: 'r2', name: 'other', members: [{ sessionId: 'reviewer', role: 'member' }, { sessionId: 'verifier-row', role: 'member' }] });
    expect(ask({ rooms: [other] })).toBeNull();
    const apart = room({ id: 'r3', members: [{ sessionId: 'reviewer', role: 'coordinator' }, { sessionId: 'someone', role: 'member' }] });
    expect(ask({ rooms: [apart] })).toBeNull();
  });
  it('ignores archived rooms, unknown conversations, and the owner-only policy', () => {
    expect(ask({ rooms: [room({ archivedAt: 1 })] })).toBeNull();
    expect(ask({ id: 'thread-unknown' })).toBeNull();
    expect(ask({ policy: 'owner' })).toBeNull();
  });
  it('picks the first qualifying room when the agent is in several', () => {
    const a = room({ id: 'ra', members: [{ sessionId: 'x', role: 'coordinator' }, { sessionId: 'verifier-row', role: 'member' }] });
    const b = room({ id: 'rb' });
    expect(ask({ rooms: [a, b] })?.roomId).toBe('rb');
  });
});

describe('resolveTakeoverPolicy', () => {
  it('defaults to coordinators and accepts only the two known values', () => {
    expect(resolveTakeoverPolicy(undefined)).toBe('coordinators');
    expect(resolveTakeoverPolicy('owner')).toBe('owner');
    expect(resolveTakeoverPolicy('coordinators')).toBe('coordinators');
    expect(resolveTakeoverPolicy('everyone')).toBe('coordinators');
  });
});
