/**
 * @fileoverview `reverie agent publish` and `publish-text`: publish a sealed review packet in two steps.
 *
 * `publish` verifies the packet (SHA256SUMS, parts, title, Branch Naming, branch name, every commit's identity and
 * sign-off, public text, diff paths, a clean merge onto the base, no open hold in the room), then pushes the bundle head
 * to the branch, opens a draft pull request with a holding body, and can watch its checks. `publish-text` puts the
 * reviewed PR-BODY.md on that pull request once its text is approved, then reads the body back and compares it.
 *
 * Nothing here forces: an existing branch is only moved when the new head is a fast-forward of it. git and gh run
 * through an injected `exec` (argv arrays, never a shell), so tests need no repository or network.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { AgentDeps } from './cli-agent.js';
import { resolveChatRoom } from './cli-agent.js';
import { AGENT_EXIT } from './agent-exit-codes.js';
import {
  checkBranchName,
  checkCommit,
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
  type Finding,
  type RoomMessage,
} from './packet-check.js';

/** The body a held draft carries until its text is approved. */
export const HELD_DRAFT_BODY = 'Draft for CI. Description pending review.';
/** How far back the hold scan reads the room. */
export const HOLD_SCAN_MESSAGES = 200;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;

export interface PublishDeps extends AgentDeps {
  exec: Exec;
  /** Reads a packet file; null when it is missing. */
  readFile?: (path: string) => Buffer | null;
  sleep?: (ms: number) => Promise<void>;
}

/** Run a command without a shell; a spawn failure is a nonzero result, never a throw. */
export const spawnExec: Exec = (cmd, args, options = {}) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (err) => done({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });

const readOrNull = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

export interface Packet {
  dir: string;
  bundlePath: string;
  title: string;
  branch: string;
  publicBody: string;
}

/** Read and verify the packet's own files; findings say why it cannot be published. */
export function readPacket(
  dir: string,
  read: (path: string) => Buffer | null = readOrNull
): { packet?: Packet; findings: Finding[] } {
  const sumsName = ['SHA256SUMS', 'SUMS.txt'].find((name) => read(join(dir, name)));
  if (!sumsName) return { findings: [{ check: 'sums', detail: `${dir} has no SHA256SUMS` }] };
  const sums = parseSums(read(join(dir, sumsName))!.toString('utf8'));
  const findings = [...sums.findings, ...verifySums(sums.entries, (path) => read(join(dir, path)))];
  const parts = checkPacketParts(sums.entries.keys());
  findings.push(...parts.findings);
  if (findings.length) return { findings };
  const title = checkTitle(read(join(dir, 'PR-TITLE.txt'))!.toString('utf8'));
  const body = splitBranchNaming(read(join(dir, 'PR-BODY.md'))!.toString('utf8'));
  findings.push(...title.findings, ...body.findings);
  if (findings.length || !title.title || !body.branch) return { findings };
  return {
    packet: {
      dir,
      bundlePath: resolve(dir, parts.bundle!),
      title: title.title,
      branch: body.branch,
      publicBody: body.publicBody,
    },
    findings,
  };
}

/** Employee names from the company roster: what public text must not name. */
async function teamNames(deps: AgentDeps): Promise<string[] | { error: string }> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/company' });
  const employees = (res.json?.data as { employees?: Array<{ name?: unknown }> } | undefined)?.employees;
  if (!res.json?.success || !Array.isArray(employees))
    return { error: 'the company roster could not be read for the name scan' };
  return employees
    .map((e) => e?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 1);
}

/** The last messages of a room, oldest first, as the hold scan reads them. */
async function roomMessages(deps: AgentDeps, room: string): Promise<RoomMessage[] | { error: string }> {
  const target = await resolveChatRoom(deps, room);
  if ('error' in target) return { error: target.error };
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages`,
    query: { limit: HOLD_SCAN_MESSAGES },
  });
  const rows = (
    res.json?.data as
      | { messages?: Array<{ id: string; at: number; from?: { name?: string }; text?: string; deleted?: unknown }> }
      | undefined
  )?.messages;
  if (!res.json?.success || !Array.isArray(rows))
    return { error: `the messages of "${room}" could not be read for the hold scan` };
  return rows
    .filter((m) => !m.deleted && typeof m.text === 'string')
    .map((m) => ({ id: m.id, at: m.at, from: m.from?.name ?? '', text: m.text! }))
    .sort((a, b) => a.at - b.at);
}

export interface PublishOptions {
  packetDir: string;
  repo: string;
  room: string;
  /** The git checkout to work in (default: the current directory). */
  cwd?: string;
  remote?: string;
  base?: string;
  card?: string;
  slice?: string;
  holdOk?: string[];
  dryRun?: boolean;
  watch?: boolean;
  minChecks?: number;
  watchTimeoutMinutes?: number;
}

interface Plan {
  head: string;
  branch: string;
  title: string;
  /** The branch's current remote head when it already exists (the push is then a fast-forward of it). */
  remoteHead?: string;
  pr?: number;
  commits: number;
  templates: string[];
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function report(deps: AgentDeps, findings: Finding[], extra: Record<string, unknown> = {}): number {
  if (deps.json) deps.io.out(JSON.stringify({ success: false, findings, ...extra }));
  else {
    deps.io.err(`Not published: ${findings.length} check${findings.length === 1 ? '' : 's'} failed`);
    for (const f of findings) deps.io.err(`  ${f.check}: ${f.detail}`);
  }
  return AGENT_EXIT.refused;
}

/** Every check, in order; returns the plan only when nothing failed. */
async function verify(deps: PublishDeps, o: PublishOptions): Promise<{ plan?: Plan; findings: Finding[] }> {
  const remote = o.remote ?? 'origin';
  const base = o.base ?? 'main';
  const git = (...args: string[]) => deps.exec('git', args, { cwd: o.cwd });
  const { packet, findings } = readPacket(o.packetDir, deps.readFile);
  if (!packet) return { findings };

  const names = await teamNames(deps);
  if (!Array.isArray(names)) return { findings: [{ check: 'names', detail: names.error }] };
  findings.push(...checkBranchName(packet.branch, names));
  findings.push(
    ...scanPublicText('PR title', packet.title, names),
    ...scanPublicText('PR body', packet.publicBody, names)
  );

  const fetched = await git('fetch', '--quiet', remote, base);
  if (fetched.code !== 0)
    return {
      findings: [...findings, { check: 'git', detail: `fetching ${remote}/${base} failed: ${fetched.stderr.trim()}` }],
    };
  const baseRef = `refs/remotes/${remote}/${base}`;

  // An increment on an open branch is a bundle whose prerequisite is that branch's remote head, so fetch it first.
  const listed = await git('ls-remote', '--heads', remote, `refs/heads/${packet.branch}`);
  if (listed.code !== 0)
    return {
      findings: [
        ...findings,
        { check: 'branch', detail: `could not list ${remote} branches: ${listed.stderr.trim()}` },
      ],
    };
  const remoteHead = /^([0-9a-f]{40})\s/.exec(listed.stdout)?.[1];
  if (remoteHead) await git('fetch', '--quiet', remote, `refs/heads/${packet.branch}`);

  const verified = await git('bundle', 'verify', '--quiet', packet.bundlePath);
  if (verified.code !== 0)
    return {
      findings: [
        ...findings,
        {
          check: 'bundle',
          detail: `the bundle does not verify against the base or the branch (a bundle stacked on an unpublished packet needs that packet published first): ${verified.stderr.trim()}`,
        },
      ],
    };
  const heads = (await git('bundle', 'list-heads', packet.bundlePath)).stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => /^[0-9a-f]{40}$/.test(parts[0] ?? ''));
  const shas = [...new Set(heads.map((parts) => parts[0]))];
  if (shas.length !== 1)
    return {
      findings: [...findings, { check: 'bundle', detail: `the bundle carries ${shas.length} heads; expected one` }],
    };
  const head = shas[0];
  const loaded = await git('fetch', '--quiet', '--no-tags', packet.bundlePath, heads[0][1] ?? head);
  if (loaded.code !== 0)
    return {
      findings: [...findings, { check: 'bundle', detail: `fetching the bundle failed: ${loaded.stderr.trim()}` }],
    };

  const revs = (await git('rev-list', '--reverse', `${baseRef}..${head}`)).stdout.split('\n').filter(Boolean);
  if (!revs.length)
    findings.push({ check: 'commits', detail: `${head.slice(0, 8)} adds nothing to ${remote}/${base}` });
  for (const sha of revs) {
    const commit = parseCommit(sha, (await git('cat-file', 'commit', sha)).stdout);
    findings.push(...checkCommit(commit), ...scanPublicText(`commit ${sha.slice(0, 8)}`, commit.message, names));
  }

  const raw = (await git('diff', '--raw', '--no-renames', '--no-abbrev', `${baseRef}...${head}`)).stdout;
  const changes = raw
    .split('\n')
    .map((line) => /^:\d{6} (\d{6}) \S+ \S+ ([A-Z])\t(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && m[2] !== 'D')
    .map((m) => ({ mode: m[1], path: m[3] }));
  findings.push(...checkPaths(changes));
  const patch = (await git('diff', '--no-renames', '--no-color', '-U0', `${baseRef}...${head}`)).stdout;
  for (const [path, added] of addedLinesByFile(patch)) findings.push(...scanPublicText(path, added, names));

  const merge = await git('merge-tree', '--write-tree', baseRef, head);
  if (merge.code !== 0)
    findings.push({ check: 'merge', detail: `${head.slice(0, 8)} does not merge cleanly onto ${remote}/${base}` });

  if (remoteHead && remoteHead !== head) {
    const ancestor = await git('merge-base', '--is-ancestor', remoteHead, head);
    if (ancestor.code !== 0)
      findings.push({
        check: 'branch',
        detail: `${remote}/${packet.branch} is at ${remoteHead.slice(0, 8)}, which ${head.slice(0, 8)} does not fast-forward`,
      });
  }

  let pr: number | undefined;
  const prs = await deps.exec('gh', [
    'pr',
    'list',
    '--repo',
    o.repo,
    '--head',
    packet.branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  if (prs.code !== 0) findings.push({ check: 'gh', detail: `gh pr list failed: ${prs.stderr.trim()}` });
  else pr = (JSON.parse(prs.stdout || '[]') as Array<{ number: number }>)[0]?.number;

  const messages = await roomMessages(deps, o.room);
  if (!Array.isArray(messages)) findings.push({ check: 'hold', detail: messages.error });
  else {
    const holds = openHolds(
      messages,
      { head, branch: packet.branch, pr: pr ? String(pr) : undefined, card: o.card, slice: o.slice },
      new Set(o.holdOk ?? [])
    );
    for (const h of holds)
      findings.push({
        check: 'hold',
        detail: `open hold from ${h.from} (${h.id.slice(0, 8)}): ${h.text.slice(0, 160)}`,
      });
  }

  const paths = changes.map((c) => c.path);
  return {
    plan: findings.length
      ? undefined
      : {
          head,
          branch: packet.branch,
          title: packet.title,
          remoteHead,
          pr,
          commits: revs.length,
          templates: templateChanges(paths),
        },
    findings,
  };
}

/** `+` lines of a unified diff, grouped by the file they are added to. */
export function addedLinesByFile(patch: string): Map<string, string> {
  const files = new Map<string, string>();
  let current: string | undefined;
  for (const line of patch.split('\n')) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      current = header[1] === '/dev/null' ? undefined : header[1];
      continue;
    }
    if (current && line.startsWith('+')) files.set(current, `${files.get(current) ?? ''}${line.slice(1)}\n`);
  }
  return files;
}

/** Cancel runs still going on an old head, so a fast-forward does not leave them using up the queue. */
async function cancelRunsFor(deps: PublishDeps, repo: string, branch: string, oldHead: string): Promise<number> {
  const listed = await deps.exec('gh', [
    'run',
    'list',
    '--repo',
    repo,
    '--branch',
    branch,
    '--json',
    'databaseId,headSha,status',
    '--limit',
    '50',
  ]);
  if (listed.code !== 0) return 0;
  const runs = JSON.parse(listed.stdout || '[]') as Array<{ databaseId: number; headSha: string; status: string }>;
  let cancelled = 0;
  for (const r of runs.filter((r) => r.headSha === oldHead && r.status !== 'completed'))
    if ((await deps.exec('gh', ['run', 'cancel', String(r.databaseId), '--repo', repo])).code === 0) cancelled++;
  return cancelled;
}

export async function agentPublish(deps: PublishDeps, o: PublishOptions): Promise<number> {
  if (!REPO_RE.test(o.repo)) return report(deps, [{ check: 'usage', detail: '--repo takes OWNER/REPO' }]);
  const { plan, findings } = await verify(deps, o);
  if (!plan) return report(deps, findings);
  const say = (line: string) => !deps.json && deps.io.out(line);
  say(
    `✓ ${plan.head.slice(0, 8)} → ${plan.branch}: ${plan.commits} commit${plan.commits === 1 ? '' : 's'}, all checks passed`
  );
  for (const path of plan.templates) say(`  review note: template change ${path}`);
  for (const id of o.holdOk ?? []) say(`  published past hold ${id} (--hold-ok)`);
  if (o.dryRun) {
    if (deps.json) deps.io.out(JSON.stringify({ success: true, dryRun: true, plan, holdOk: o.holdOk ?? [] }));
    return AGENT_EXIT.ok;
  }

  const remote = o.remote ?? 'origin';
  if (plan.remoteHead !== plan.head) {
    if (plan.remoteHead) {
      const cancelled = await cancelRunsFor(deps, o.repo, plan.branch, plan.remoteHead);
      if (cancelled)
        say(`  cancelled ${cancelled} run${cancelled === 1 ? '' : 's'} on the old head ${plan.remoteHead.slice(0, 8)}`);
    }
    const pushed = await deps.exec('git', ['push', '--quiet', remote, `${plan.head}:refs/heads/${plan.branch}`], {
      cwd: o.cwd,
    });
    if (pushed.code !== 0) return report(deps, [{ check: 'push', detail: pushed.stderr.trim() || 'git push failed' }]);
    say(`✓ pushed ${plan.branch}`);
  }

  let pr = plan.pr;
  if (!pr) {
    const created = await deps.exec('gh', [
      'pr',
      'create',
      '--draft',
      '--repo',
      o.repo,
      '--base',
      o.base ?? 'main',
      '--head',
      plan.branch,
      '--title',
      plan.title,
      '--body',
      HELD_DRAFT_BODY,
    ]);
    pr = Number(/\/pull\/(\d+)/.exec(created.stdout)?.[1]);
    if (created.code !== 0 || !pr)
      return report(deps, [{ check: 'pr', detail: created.stderr.trim() || 'gh pr create returned no pull request' }], {
        pushed: plan.head,
      });
    say(`✓ draft #${pr} opened with the holding body; run publish-text after the text is approved`);
  } else say(`✓ draft #${pr} already open for ${plan.branch}`);

  const result = {
    success: true,
    head: plan.head,
    branch: plan.branch,
    pr,
    templates: plan.templates,
    holdOk: o.holdOk ?? [],
  };
  if (!o.watch) {
    if (deps.json) deps.io.out(JSON.stringify(result));
    return AGENT_EXIT.ok;
  }
  const watched = await watchChecks(deps, {
    repo: o.repo,
    pr,
    head: plan.head,
    minChecks: o.minChecks ?? 1,
    timeoutMinutes: o.watchTimeoutMinutes ?? 120,
  });
  if (deps.json) deps.io.out(JSON.stringify({ ...result, watch: watched }));
  return watched.state === 'passed'
    ? AGENT_EXIT.ok
    : watched.state === 'timeout'
      ? AGENT_EXIT.timeout
      : AGENT_EXIT.error;
}

export interface WatchResult {
  state: 'passed' | 'failed' | 'head-moved' | 'timeout' | 'error';
  checks: number;
  failed: string[];
}

/** Poll the pull request until at least `minChecks` checks have run and none is pending, or its head moves. */
export async function watchChecks(
  deps: PublishDeps,
  o: { repo: string; pr: number; head: string; minChecks: number; timeoutMinutes: number; intervalMs?: number }
): Promise<WatchResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = (deps.now?.() ?? Date.now()) + o.timeoutMinutes * 60_000;
  const say = (line: string) => !deps.json && deps.io.out(line);
  let last = '';
  for (;;) {
    const viewed = await deps.exec('gh', [
      'pr',
      'view',
      String(o.pr),
      '--repo',
      o.repo,
      '--json',
      'headRefOid,statusCheckRollup',
    ]);
    if (viewed.code !== 0) return { state: 'error', checks: 0, failed: [viewed.stderr.trim()] };
    const data = JSON.parse(viewed.stdout) as {
      headRefOid: string;
      statusCheckRollup?: Array<{
        name?: string;
        context?: string;
        status?: string;
        conclusion?: string;
        state?: string;
      }>;
    };
    if (data.headRefOid !== o.head) {
      say(`head moved to ${data.headRefOid.slice(0, 8)}; stopped watching`);
      return { state: 'head-moved', checks: 0, failed: [] };
    }
    const checks = data.statusCheckRollup ?? [];
    // Check runs carry status/conclusion; commit statuses carry state.
    const pending = checks.filter((c) =>
      c.status ? c.status !== 'COMPLETED' : c.state === 'PENDING' || c.state === 'EXPECTED'
    );
    const failed = checks
      .filter((c) =>
        c.status
          ? ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.conclusion ?? '')
          : ['FAILURE', 'ERROR'].includes(c.state ?? '')
      )
      .map((c) => c.name ?? c.context ?? 'check');
    const line = `#${o.pr} ${o.head.slice(0, 8)}: ${checks.length} checks, ${pending.length} pending, ${failed.length} failed`;
    if (line !== last) say((last = line));
    if (checks.length >= o.minChecks && pending.length === 0)
      return { state: failed.length ? 'failed' : 'passed', checks: checks.length, failed };
    if ((deps.now?.() ?? Date.now()) >= deadline) return { state: 'timeout', checks: checks.length, failed };
    await sleep(o.intervalMs ?? 60_000);
  }
}

export interface PublishTextOptions {
  packetDir: string;
  repo: string;
  pr?: number;
}

/** Normalize a body for the read-back comparison: GitHub stores CRLF and may trim the final newline. */
const normalizeBody = (text: string) => text.replace(/\r\n/g, '\n').replace(/\s+$/, '');

export async function agentPublishText(deps: PublishDeps, o: PublishTextOptions): Promise<number> {
  if (!REPO_RE.test(o.repo)) return report(deps, [{ check: 'usage', detail: '--repo takes OWNER/REPO' }]);
  const { packet, findings } = readPacket(o.packetDir, deps.readFile);
  if (!packet) return report(deps, findings);
  const names = await teamNames(deps);
  if (!Array.isArray(names)) return report(deps, [{ check: 'names', detail: names.error }]);
  findings.push(...scanPublicText('PR body', packet.publicBody, names));
  const heads =
    (await deps.exec('git', ['bundle', 'list-heads', packet.bundlePath])).stdout.match(/^[0-9a-f]{40}/gm) ?? [];
  if (new Set(heads).size !== 1) findings.push({ check: 'bundle', detail: 'the bundle head could not be read' });

  let pr = o.pr;
  if (!pr) {
    const prs = await deps.exec('gh', [
      'pr',
      'list',
      '--repo',
      o.repo,
      '--head',
      packet.branch,
      '--state',
      'open',
      '--json',
      'number',
    ]);
    pr = (JSON.parse(prs.code === 0 ? prs.stdout || '[]' : '[]') as Array<{ number: number }>)[0]?.number;
    if (!pr) findings.push({ check: 'pr', detail: `no open pull request for ${packet.branch}` });
  }
  if (pr && heads[0]) {
    const viewed = await deps.exec('gh', [
      'pr',
      'view',
      String(pr),
      '--repo',
      o.repo,
      '--json',
      'headRefOid,headRefName',
    ]);
    const data = viewed.code === 0 ? (JSON.parse(viewed.stdout) as { headRefOid?: string; headRefName?: string }) : {};
    if (data.headRefName !== packet.branch) findings.push({ check: 'pr', detail: `#${pr} is not on ${packet.branch}` });
    else if (data.headRefOid !== heads[0])
      findings.push({
        check: 'pr',
        detail: `#${pr} is at ${String(data.headRefOid).slice(0, 8)}, not the reviewed ${heads[0].slice(0, 8)}`,
      });
  }
  if (findings.length || !pr) return report(deps, findings);

  const dir = mkdtempSync(join(tmpdir(), 'reverie-publish-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, packet.publicBody);
    const edited = await deps.exec('gh', ['pr', 'edit', String(pr), '--repo', o.repo, '--body-file', bodyFile]);
    if (edited.code !== 0) return report(deps, [{ check: 'pr', detail: edited.stderr.trim() || 'gh pr edit failed' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const back = await deps.exec('gh', ['pr', 'view', String(pr), '--repo', o.repo, '--json', 'body']);
  const live = back.code === 0 ? ((JSON.parse(back.stdout) as { body?: string }).body ?? '') : '';
  if (normalizeBody(live) !== normalizeBody(packet.publicBody))
    return report(deps, [{ check: 'pr', detail: `#${pr}'s body reads back different from PR-BODY.md` }]);
  if (deps.json) deps.io.out(JSON.stringify({ success: true, pr, head: heads[0] }));
  else deps.io.out(`✓ #${pr} body set from PR-BODY.md and read back identical`);
  return AGENT_EXIT.ok;
}

const repeat = (value: string, all: string[] = []) => [...all, value];

export function registerPublishCommands(
  agent: Command,
  run: (json: boolean, verb: (deps: AgentDeps) => Promise<number>) => Promise<void>
): void {
  agent
    .command('publish <packet-dir>')
    .description('Verify a sealed packet, push its head to its branch, open a held draft PR and optionally watch CI')
    .requiredOption('--repo <owner/repo>', 'GitHub repository')
    .requiredOption('-r, --room <room>', 'Room to scan for an open hold on this packet')
    .option('-C, --cwd <dir>', 'Git checkout to work in (default: the current directory)')
    .option('--remote <name>', 'Git remote', 'origin')
    .option('--base <branch>', 'Base branch', 'main')
    .option('--card <id>', 'Board card the hold scan also matches')
    .option('--slice <name>', 'Slice name the hold scan also matches')
    .option('--hold-ok <message-id>', 'Publish past this hold message (repeat); recorded in the output', repeat)
    .option('--dry-run', 'Run every check and stop before pushing')
    .option('--watch', 'Watch the checks after opening the draft')
    .option('--min-checks <n>', 'With --watch: checks that must have run before it counts as done', '1')
    .option('--watch-timeout <minutes>', 'With --watch: give up after this long', '120')
    .option('--json', 'Machine-readable result')
    .action(
      (
        packetDir: string,
        o: {
          repo: string;
          room: string;
          cwd?: string;
          remote: string;
          base: string;
          card?: string;
          slice?: string;
          holdOk?: string[];
          dryRun?: boolean;
          watch?: boolean;
          minChecks: string;
          watchTimeout: string;
          json?: boolean;
        }
      ) =>
        run(Boolean(o.json), (deps) =>
          agentPublish(
            { ...deps, exec: spawnExec },
            {
              packetDir: resolve(packetDir),
              repo: o.repo,
              room: o.room,
              cwd: o.cwd,
              remote: o.remote,
              base: o.base,
              card: o.card,
              slice: o.slice,
              holdOk: o.holdOk,
              dryRun: o.dryRun,
              watch: o.watch,
              minChecks: Number(o.minChecks) || 1,
              watchTimeoutMinutes: Number(o.watchTimeout) || 120,
            }
          )
        )
    );
  agent
    .command('publish-text <packet-dir>')
    .description(
      "After the text is approved: set the draft PR's body from PR-BODY.md (Branch Naming removed) and read it back"
    )
    .requiredOption('--repo <owner/repo>', 'GitHub repository')
    .option('--pr <number>', 'Pull request (default: the open one for the packet branch)')
    .option('--json', 'Machine-readable result')
    .action((packetDir: string, o: { repo: string; pr?: string; json?: boolean }) =>
      run(Boolean(o.json), (deps) =>
        agentPublishText(
          { ...deps, exec: spawnExec },
          { packetDir: resolve(packetDir), repo: o.repo, pr: o.pr ? Number(o.pr) : undefined }
        )
      )
    );
}
