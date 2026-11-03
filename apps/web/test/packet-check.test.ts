/**
 * @fileoverview The sealed-packet checks in `src/packet-check.ts`: SHA256SUMS, required parts, title, the Branch Naming
 * section, branch-name rules, commit identity and sign-off, public-text scan, diff paths and the room hold scan.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkBranchName,
  checkCommit,
  checkHoldReach,
  checkPacketParts,
  checkPaths,
  checkTitle,
  openHolds,
  parseCommit,
  parseSums,
  scanPublicText,
  splitBranchNaming,
  templateChanges,
  verifySums,
  type RoomMessage,
} from '../src/packet-check.js';

const ID = 'James Goppert <473772+jgoppert@users.noreply.github.com>';
// Built at runtime so this file's own text passes the board-id scan it tests.
const CARD = ['i', '0000beef'].join('-');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('parseSums / verifySums', () => {
  it('reads sha256sum output and verifies each file', () => {
    const files: Record<string, string> = { 'source.bundle': 'bundle bytes', 'PR-TITLE.txt': 'Title\n' };
    const text = Object.entries(files)
      .map(([path, body]) => `${sha(body)}  ${path}`)
      .join('\n');
    const { entries, findings } = parseSums(`${text}\n`);
    expect(findings).toEqual([]);
    expect([...entries.keys()]).toEqual(['source.bundle', 'PR-TITLE.txt']);
    const read = (path: string) => (path in files ? Buffer.from(files[path]) : null);
    expect(verifySums(entries, read)).toEqual([]);
    files['PR-TITLE.txt'] = 'Changed\n';
    expect(verifySums(entries, read)).toEqual([{ check: 'sums', detail: 'PR-TITLE.txt does not match its digest' }]);
    delete files['source.bundle'];
    expect(verifySums(entries, read).map((f) => f.detail)).toContain('source.bundle is missing');
  });

  it('accepts binary-mode and ./ paths, and reports malformed, duplicate and escaping lines', () => {
    const digest = sha('x');
    const { entries, findings } = parseSums(
      [
        `${digest} *./a.bundle`,
        'not a sum line',
        `${digest}  a.bundle`,
        `${digest}  ../outside`,
        `${digest}  /abs`,
      ].join('\n')
    );
    expect([...entries.keys()]).toEqual(['a.bundle']);
    expect(findings.map((f) => f.detail)).toEqual([
      'line 2 is not "<sha256>  <path>"',
      'a.bundle is listed twice',
      '../outside leaves the packet',
      '/abs leaves the packet',
    ]);
  });

  it('treats an empty file as a finding', () => {
    expect(parseSums('\n').findings).toEqual([{ check: 'sums', detail: 'SHA256SUMS lists no files' }]);
  });
});

describe('checkPacketParts', () => {
  it('needs exactly one top-level bundle plus the title and body', () => {
    expect(checkPacketParts(['source.bundle', 'PR-TITLE.txt', 'PR-BODY.md'])).toEqual({
      bundle: 'source.bundle',
      findings: [],
    });
    const missing = checkPacketParts(['a.bundle', 'b.bundle', 'PR-BODY.md']);
    expect(missing.bundle).toBeUndefined();
    expect(missing.findings.map((f) => f.detail)).toEqual([
      'expected one top-level .bundle, found 2',
      'PR-TITLE.txt is not listed in SHA256SUMS',
    ]);
    expect(checkPacketParts(['old/source.bundle', 'PR-TITLE.txt', 'PR-BODY.md']).bundle).toBeUndefined();
  });
});

describe('checkTitle', () => {
  it('takes one non-empty line of at most 256 characters', () => {
    expect(checkTitle('fix(cli): publish sealed packets\n')).toEqual({
      title: 'fix(cli): publish sealed packets',
      findings: [],
    });
    expect(checkTitle('\n').findings[0].detail).toBe('PR-TITLE.txt is empty');
    expect(checkTitle('one\ntwo\n').findings[0].detail).toBe('PR-TITLE.txt has more than one line');
    expect(checkTitle('x'.repeat(257)).findings[0].detail).toBe('PR title is over 256 characters');
  });
});

describe('splitBranchNaming', () => {
  it('takes the branch and strips the section from the posted body', () => {
    const body = '## Branch Naming\n\n`packet-publish`\n\n## Summary\n\nAdds a command.\n';
    expect(splitBranchNaming(body)).toEqual({
      branch: 'packet-publish',
      publicBody: '## Summary\n\nAdds a command.\n',
      findings: [],
    });
  });

  it('refuses a body without the opening section', () => {
    const result = splitBranchNaming('## Summary\n\n## Branch Naming\n\n`x`\n');
    expect(result.branch).toBeUndefined();
    expect(result.findings[0].check).toBe('branch');
  });
});

describe('checkBranchName', () => {
  it('passes plain feature names', () => {
    expect(checkBranchName('packet-publish')).toEqual([]);
    expect(checkBranchName('fix/chat-hold-stream', ['Dana'])).toEqual([]);
  });

  it('refuses assistant, model and team words as whole words only', () => {
    expect(checkBranchName('claude-publish').map((f) => f.detail)).toEqual(['branch name contains "claude"']);
    expect(checkBranchName('ai/publish').map((f) => f.detail)).toEqual(['branch name contains "ai"']);
    expect(checkBranchName('dana-publish', ['Dana']).map((f) => f.detail)).toEqual([
      'branch name contains the team name "dana"',
    ]);
    // "maintain" and "chain" contain "ai" but are not the word.
    expect(checkBranchName('maintain-chain')).toEqual([]);
  });

  it('refuses names git or GitHub would mangle', () => {
    for (const name of ['Packet', '-x', 'a..b', 'a/', 'x.lock', 'has space'])
      expect(checkBranchName(name).length, name).toBeGreaterThan(0);
  });
});

const signed = (subject: string, extra = '') =>
  `tree 1\nparent 2\nauthor ${ID} 1793680000 -0500\ncommitter ${ID} 1793680000 -0500\n\n${subject}\n\n${extra}Signed-off-by: ${ID}\n`;

describe('parseCommit / checkCommit', () => {
  it('passes a commit by the publish identity with one sign-off', () => {
    const commit = parseCommit('0123456789abcdef', signed('feat(cli): publish'));
    expect(commit.author).toBe(ID);
    expect(commit.committer).toBe(ID);
    expect(checkCommit(commit, [ID])).toEqual([]);
  });

  it('reports another author or committer', () => {
    const raw = signed('x').replace(`committer ${ID}`, 'committer Someone <s@example.com>');
    expect(checkCommit(parseCommit('0123456789abcdef', raw), [ID]).map((f) => f.detail)).toEqual([
      '01234567 committer is Someone <s@example.com>',
    ]);
  });

  it('needs exactly one sign-off, by the publish identity', () => {
    const twice = signed('x', `Signed-off-by: ${ID}\n`);
    expect(checkCommit(parseCommit('aaaaaaaa', twice), [ID]).map((f) => f.check)).toEqual(['dco']);
    const other = signed('x').replace(`Signed-off-by: ${ID}`, 'Signed-off-by: Other <o@example.com>');
    expect(checkCommit(parseCommit('aaaaaaaa', other), [ID])[0].detail).toBe(
      'aaaaaaaa is not signed off by its author'
    );
    const none = signed('x').replace(`Signed-off-by: ${ID}\n`, '');
    expect(checkCommit(parseCommit('aaaaaaaa', none), [ID])[0].detail).toBe('aaaaaaaa has 0 Signed-off-by lines');
  });

  it('accepts any configured identity, and needs the sign-off to name the author', () => {
    const other = 'James Goppert <jgoppert@users.noreply.github.com>';
    const raw = signed('x').replace(`author ${ID}`, `author ${other}`);
    expect(checkCommit(parseCommit('aaaaaaaa', raw), [ID, other]).map((f) => f.detail)).toEqual([
      'aaaaaaaa is not signed off by its author',
    ]);
    expect(checkCommit(parseCommit('aaaaaaaa', signed('x')), [other]).map((f) => f.check)).toEqual([
      'identity',
      'identity',
    ]);
  });

  it('refuses attribution trailers', () => {
    const raw = signed('x', 'Co-Authored-By: Helper <h@example.com>\n');
    expect(checkCommit(parseCommit('aaaaaaaa', raw), [ID]).map((f) => f.check)).toEqual(['attribution']);
  });
});

describe('scanPublicText', () => {
  const team = ['Dana', 'Carol', 'Bob'];

  it('finds whole-word team names and board ids', () => {
    expect(scanPublicText('PR body', 'Reviewed by carol.', team)).toEqual([
      { check: 'names', detail: 'PR body names "Carol"' },
    ]);
    expect(scanPublicText('commit 01234567', `Closes ${CARD}`, team)).toEqual([
      { check: 'ids', detail: `commit 01234567 carries the board id ${CARD}` },
    ]);
  });

  it('ignores names inside other words', () => {
    expect(scanPublicText('diff', 'candana boba carolina', team)).toEqual([]);
  });
});

describe('checkPaths / templateChanges', () => {
  it('refuses symlinks and build output', () => {
    expect(
      checkPaths([
        { path: 'apps/web/node_modules', mode: '120000' },
        { path: 'apps/web/dist/index.js', mode: '100644' },
        { path: 'apps/web/src/x.ts', mode: '100644' },
      ]).map((f) => f.detail)
    ).toEqual([
      'apps/web/node_modules is a symlink',
      'apps/web/node_modules is dependency or build output',
      'apps/web/dist/index.js is dependency or build output',
    ]);
  });

  it('lists template and jinja changes', () => {
    expect(templateChanges(['a/templates/x.rs', 'b/y.jinja', 'c/z.ts'])).toEqual(['a/templates/x.rs', 'b/y.jinja']);
  });
});

describe('openHolds', () => {
  const keys = { head: 'abcdef0123456789', branch: 'packet-publish', pr: '240', names: [CARD, 'T1'] };
  let n = 0;
  const msg = (from: string, text: string): RoomMessage => ({ id: `m${++n}`, at: n, from, text });

  it('finds a hold that names the packet by any key', () => {
    for (const text of ['HOLD abcdef01', 'hold on packet-publish', 'blocker on #240', `wait on ${CARD}`]) {
      const hold = msg('Alice', text);
      expect(openHolds([hold], keys), text).toEqual([hold]);
    }
  });

  it('ignores holds on other packets and messages without hold language', () => {
    expect(openHolds([msg('Alice', 'HOLD #241'), msg('Alice', 'packet-publish looks fine')], keys)).toEqual([]);
  });

  it('lets the same sender lift the hold, not someone else', () => {
    const hold = msg('Alice', 'HOLD packet-publish: test fails');
    expect(openHolds([hold, msg('Bob', 'GO abcdef01')], keys)).toEqual([hold]);
    expect(openHolds([hold, msg('Alice', 'GO abcdef01')], keys)).toEqual([]);
    expect(openHolds([hold, msg('Alice', 'packet-publish hold lifted')], keys)).toEqual([]);
  });

  it('lifts only with a GO naming the exact head, and never a negated GO or lift', () => {
    const hold = msg('Alice', 'HOLD packet-publish: hosted CI red');
    expect(openHolds([hold, msg('Alice', 'GO packet-publish')], keys)).toEqual([hold]);
    expect(openHolds([hold, msg('Alice', 'packet-publish: Source GO remains withheld')], keys)).toEqual([hold]);
    expect(openHolds([hold, msg('Alice', 'packet-publish is not a GO until hosted CI passes')], keys)).toEqual([hold]);
    expect(openHolds([hold, msg('Alice', 'abcdef01 approved, pending CI')], keys)).toEqual([hold]);
    const restated = msg('Alice', "packet-publish hold isn't lifted yet");
    expect(openHolds([hold, restated], keys)).toEqual([hold, restated]);
    expect(openHolds([hold, msg('Alice', 'GO abcdef01: CI green')], keys)).toEqual([]);
    expect(openHolds([hold, msg('Alice', 'packet-publish no longer blocked')], keys)).toEqual([]);
  });

  it('does not read a "go" inside a hold as a lift', () => {
    const hold = msg('Alice', "hold packet-publish, don't GO yet");
    expect(openHolds([hold], keys)).toEqual([hold]);
  });

  it('skips holds the publisher accepted by id', () => {
    const hold = msg('Alice', 'HOLD packet-publish');
    expect(openHolds([hold], keys, new Set([hold.id]))).toEqual([]);
  });
});

describe('openHolds: NO-GO and short keys', () => {
  const keys = { head: 'abcdef0123456789', branch: 'packet-publish', names: ['T1'] };
  const msg = (id: string, at: number, from: string, text: string): RoomMessage => ({ id, at, from, text });

  it('treats NO-GO as a hold, and a later NO-GO does not lift an earlier hold', () => {
    const nogo = msg('a', 1, 'Alice', 'NO-GO on abcdef01: the test fails');
    expect(openHolds([nogo], keys)).toEqual([nogo]);
    const hold = msg('b', 2, 'Alice', 'HOLD packet-publish');
    const still = msg('c', 3, 'Alice', 'packet-publish still NO-GO');
    expect(openHolds([hold, still], keys)).toEqual([hold, still]);
    expect(openHolds([hold, still, msg('d', 4, 'Alice', 'GO abcdef01 packet-publish')], keys)).toEqual([]);
  });

  it('matches short slice names and full SHAs as whole tokens', () => {
    expect(openHolds([msg('a', 1, 'Alice', 'T1 HOLD until the rerun')], keys)).toHaveLength(1);
    expect(openHolds([msg('a', 1, 'Alice', 'T12 HOLD'), msg('b', 2, 'Alice', 'ST1 hold')], keys)).toEqual([]);
    expect(openHolds([msg('a', 1, 'Alice', 'HOLD abcdef0123456789aaaa')], keys)).toHaveLength(1);
    expect(openHolds([msg('a', 1, 'Alice', 'HOLD 1abcdef01')], keys)).toEqual([]);
  });
});

describe('checkHoldReach', () => {
  const keys = { head: 'abcdef0123456789', branch: 'packet-publish' };
  const msg = (id: string, text: string): RoomMessage => ({ id, at: 0, from: 'Alice', text });
  const filler = Array.from({ length: 5 }, (_, i) => msg(`f${i}`, 'unrelated'));

  it('passes a complete history, or a window holding a head mention newer than its oldest message', () => {
    expect(checkHoldReach([], true, keys)).toEqual([]);
    expect(checkHoldReach([...filler, msg('s', 'sealed abcdef01')], false, keys)).toEqual([]);
  });

  it('fails closed when the window may cut the packet off', () => {
    expect(checkHoldReach([msg('o', 'HOLD packet-publish'), ...filler], false, keys)[0].detail).toContain(
      'oldest of the'
    );
    expect(checkHoldReach(filler, false, keys)[0].detail).toContain('names abcdef01');
  });

  it('checks an explicit anchor is inside the window and not at its edge', () => {
    expect(checkHoldReach(filler, false, keys, 'f2')).toEqual([]);
    expect(checkHoldReach(filler, false, keys, 'f0')[0].detail).toContain('oldest one read');
    expect(checkHoldReach(filler, false, keys, 'zz')[0].detail).toContain('is not among');
  });
});
