#!/opt/reverie-worker-client/bin/node
/** Build-only external SDK fake. The image, not a production override, selects this executable. */
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BoxedPlanProviderFixture, requirePlanFixtureHooks } from '../helpers/boxed-plan-provider.js';
import {
  planFixtureAccountStatus,
  PlanProviderFixtureFiles,
  type PlanFixtureDiagnosticStage,
} from '../helpers/boxed-plan-provider-files.js';
import { WORKER_CLIENT_ENTRY } from '../../src/worker-client-manifest.js';

export function planProviderLaunch(args: readonly string[], env: NodeJS.ProcessEnv) {
  if (env.HOME !== '/home/agent') throw Error('Fixed synthetic HOME required');
  const one = (flag: string) => {
    const values = args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
    if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 65536)
      throw Error('Canonical synthetic launch refused');
    return values[0];
  };
  const resumes = args.filter((a) => a === '--resume' || a === '--session-id');
  if (resumes.length !== 1) throw Error('Exactly one original provider thread required');
  const providerThread = z.string().uuid().parse(one(resumes[0]!));
  const settings: unknown = JSON.parse(one('--settings'));
  requirePlanFixtureHooks(settings);
  const sessionId = z.string().uuid().parse(env.REVERIE_SESSION_ID);
  const hookGeneration = env.REVERIE_HOOK_GENERATION;
  if (!hookGeneration || !/^[A-Za-z0-9_.:-]{1,256}$/.test(hookGeneration)) throw Error('Managed generation required');
  return { settings, sessionId, providerThread, hookGeneration };
}
/** Fixed argv transport only: no shell, provider/backend emulation, caller token or command from stdin. */
export async function planFixtureCli(args: readonly string[], input?: string) {
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    stdoutSha256: string;
    stderrSha256: string;
  }>((resolve, reject) => {
    const child = spawn(WORKER_CLIENT_ENTRY, [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const chunks: Buffer[][] = [[], []];
    let length = 0,
      failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => fail(Error('Fixed fixture CLI deadline')), 20000);
    for (const [index, stream] of [child.stdout, child.stderr].entries())
      stream.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65536) fail(Error('Fixed fixture CLI output bound'));
        else chunks[index]!.push(chunk);
      });
    child.once('error', fail);
    child.stdin.once('error', () => fail(Error('Fixed fixture CLI stdin unconfirmed')));
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (failed) return;
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(chunks[0]!).toString('utf8'),
        stderr: Buffer.concat(chunks[1]!).toString('utf8'),
        stdoutSha256: createHash('sha256').update(Buffer.concat(chunks[0]!)).digest('hex'),
        stderrSha256: createHash('sha256').update(Buffer.concat(chunks[1]!)).digest('hex'),
      });
    });
    child.stdin.end(input ?? '');
  });
}
export async function planFixtureStage<T>(
  files: Pick<PlanProviderFixtureFiles, 'diagnostic'>,
  stage: PlanFixtureDiagnosticStage,
  run: () => T | Promise<T>
): Promise<T> {
  files.diagnostic(stage, 'issued');
  let value: T;
  try {
    value = await run();
  } catch (error) {
    files.diagnostic(stage, 'failed');
    throw error;
  }
  files.diagnostic(stage, 'returned');
  return value;
}
function probeStage(args: readonly string[]): PlanFixtureDiagnosticStage {
  const command = args.join(' ');
  if (command === 'agent capabilities --json') return 'capabilities';
  if (command === 'worker-callback hook-event --event stop') return 'hook-stop';
  if (command === 'worker-callback hook-event --event prompt_submitted') return 'hook-prompt';
  if (command === 'plans --json') return 'plans';
  if (command === 'agent plan-move list --json') return 'move-list';
  if (args[0] === 'agent' && args[1] === 'plan-move' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(args[3] ?? '')) {
    if (args.length === 5 && args[2] === 'status' && args[4] === '--json') return 'move-status';
    if (
      args.length === 7 &&
      args[2] === 'approve' &&
      args[4] === '--handoff-file' &&
      args[5] === '/home/agent/.fixture/plan-handoff-' + args[3] + '.txt' &&
      args[6] === '--json'
    )
      return 'move-approve';
  }
  throw Error('Fixed fixture diagnostic stage refused');
}
export function observedPlanFixtureCli(
  files: Pick<PlanProviderFixtureFiles, 'diagnostic'>,
  run = planFixtureCli
): typeof planFixtureCli {
  return async (args, input) => {
    const stage = probeStage(args);
    files.diagnostic(stage, 'issued');
    let reply: Awaited<ReturnType<typeof planFixtureCli>>;
    try {
      reply = await run(args, input);
    } catch (error) {
      files.diagnostic(stage, 'failed');
      throw error;
    }
    files.diagnostic(stage, reply.exitCode === 0 && reply.signal === null ? 'returned' : 'failed', {
      exitCode: reply.exitCode,
      signal: reply.signal,
      stdoutSha256: reply.stdoutSha256,
      stderrSha256: reply.stderrSha256,
    });
    return reply;
  };
}
export async function planProviderMain(args = process.argv.slice(2)) {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    process.stdout.write('2.1.251 (Claude Code; synthetic plan fixture)\n');
    return;
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('Synthetic external plan provider; ordinary managed launch only.\n');
    return;
  }
  if (args.length === 3 && args[0] === 'auth' && args[1] === 'status' && args[2] === '--json') {
    const status =
      process.env.HOME === '/home/agent'
        ? new PlanProviderFixtureFiles('/home/agent', process.env.CLAUDE_CONFIG_DIR).authStatus()
        : planFixtureAccountStatus(process.env.CLAUDE_CONFIG_DIR);
    process.stdout.write(JSON.stringify(status) + '\n');
    return;
  }
  const files = new PlanProviderFixtureFiles('/home/agent', process.env.CLAUDE_CONFIG_DIR);
  const launch = await planFixtureStage(files, 'launch-parse', () => planProviderLaunch(args, process.env));
  const contract = await planFixtureStage(files, 'contract-read', () => files.contract());
  // Simulate SDK startup refresh BEFORE the measured request captures source material.
  if (
    contract.refreshAccountId !== null &&
    process.env.CLAUDE_CONFIG_DIR !== undefined &&
    process.env.CLAUDE_CONFIG_DIR !== '/home/agent/.claude'
  )
    await planFixtureStage(files, 'startup-refresh', () => files.refreshAuthOnce(contract.refreshAccountId!));
  let release: { id: string; resolve: () => void } | undefined;
  const fake = new BoxedPlanProviderFixture(
    contract,
    { ...launch, namespacePid: process.pid },
    {
      cli: observedPlanFixtureCli(files),
      prepareApproval: async (id, handoff) => files.prepareApproval(id, handoff),
      refreshAuthOnce: async (id) => {
        // Legacy source auth is NOT installed-generation lineage and never counts as a refresh.
        if (process.env.CLAUDE_CONFIG_DIR === undefined || process.env.CLAUDE_CONFIG_DIR === '/home/agent/.claude')
          return;
        files.refreshAuthOnce(id);
      },
      beforeApproval: async (id) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            release = undefined;
            reject(Error('Synthetic approval pause deadline'));
          }, 30000);
          release = {
            id,
            resolve: () => {
              clearTimeout(timer);
              release = undefined;
              resolve();
            },
          };
          process.stdout.write('BCPLAN_APPROVAL_PAUSED_' + id + '\n');
        });
      },
      record: async (report) => files.record(report),
      output: (text) => process.stdout.write(text),
    },
    launch.settings
  );
  await planFixtureStage(files, 'startup-sequence', () => fake.start());
  let stopped = false;
  let buffer = '',
    serial = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 65536) {
      stopped = true;
      process.stderr.write('Synthetic input bound refused\n');
      process.exitCode = 1;
      process.stdin.destroy();
      return;
    }
    const lines = buffer.split(/[\r\n]/);
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line) continue;
      if (release && line === 'BOXED_PLAN_APPROVAL_RELEASE_' + release.id) {
        release.resolve();
        continue;
      }
      serial = serial
        .then(async () => {
          if (!stopped) await fake.turn();
        })
        .catch(() => {
          // No retry, fabricated idle or diagnostic secret output after an unknown physical callback.
          stopped = true;
          process.stderr.write('Synthetic plan turn unconfirmed\n');
          process.exitCode = 1;
          process.stdin.destroy();
        });
    }
  });
  process.stdin.resume();
}
export function planProviderIsMain(file: string | undefined) {
  if (!file) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(file)).href;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
if (planProviderIsMain(process.argv[1]))
  await planProviderMain().catch(() => {
    process.stderr.write('Synthetic plan provider refused\n');
    process.exitCode = 1;
  });
