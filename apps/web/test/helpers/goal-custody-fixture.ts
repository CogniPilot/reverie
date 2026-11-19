import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const brokerTest = 'installing_broker::goal_custody::tests::web_fixture::serve_web_goal_fixture';

export type GoalInventoryRecord = {
  Id: string;
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
  [key: string]: unknown;
};

export function goalCustodyClientBinary(): string {
  const root = resolve(import.meta.dirname, '../../../..');
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
  const binary = process.env.NIX_TEST_GOAL_WORKER_EXEC ?? resolve(target, 'debug/reverie-worker-exec');
  if (!existsSync(binary)) {
    throw Error('Build the Goal custody client with cargo build -p reverie-worker-client --bin reverie-worker-exec');
  }
  return binary;
}

export function writeGoalWorkerPolicy(root: string, goalPrivateConfig: string, companyFile: string): void {
  const policy = {
    version: 1,
    goalPrivateConfig,
    companyFile,
    stateRoot: join(root, 'workers'),
    socket: join(root, 'control', 'broker.sock'),
    mounts: [{ source: join(root, 'public'), destination: '/workspace', readOnly: false }],
    uid: process.getuid!(),
    gid: process.getgid!(),
    maxWorkers: 4,
    deployment: 'synthetic',
    serverContainer: 'synthetic-console',
    apiSocketRoot: join(root, 'office'),
    companyRoot: join(root, 'private'),
    scratchRoot: join(root, 'scratch'),
    image: 'sha256:' + 'd'.repeat(64),
    budgetMode: 'pool',
    cgroupParent: 'reverie-workers.slice',
    memoryMiB: 0,
    cpus: 0,
    pidsLimit: 128,
    poolMemoryMiB: 4096,
    poolTasksMax: 1024,
    maintenanceSessions: [],
  };
  writeFileSync(join(root, 'worker.json'), JSON.stringify(policy), { mode: 0o600 });
}

export function writeGoalInventory(root: string, inventory: GoalInventoryRecord[]): void {
  writeFileSync(join(root, 'goal-ids.out'), inventory.map(({ Id }) => Id).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(root, 'goal-inventory.out'), JSON.stringify(inventory), { mode: 0o600 });
}

export function startGoalBroker(root: string): ChildProcessWithoutNullStreams {
  const binary = process.env.NIX_TEST_GOAL_FIXTURE;
  if (!binary || !existsSync(binary)) {
    throw Error('Build the native Goal fixture with nix build .#checks.x86_64-linux.goalCustodyFixture');
  }
  writeFileSync(join(root, 'goal-inventory-control'), '', { mode: 0o600 });
  const child = spawn(binary, ['--exact', brokerTest, '--ignored', '--nocapture'], {
    env: { ...process.env, REVERIE_GOAL_FIXTURE_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Drain libtest output for the lifetime of this subprocess.
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

export async function waitForGoalBroker(child: ChildProcessWithoutNullStreams): Promise<void> {
  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const collect = (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-2000);
    };
    const deadline = setTimeout(() => finish(Error(`Owned Goal broker readiness bound: ${stderr}`)), 8000);
    const exited = (status: number | null) =>
      finish(Error(`Owned Goal broker exited before readiness (${status}): ${stderr}`));
    const finish = (error?: Error) => {
      clearTimeout(deadline);
      child.off('close', exited);
      child.off('error', finish);
      child.stderr.off('data', collect);
      lines.close();
      if (error) reject(error);
      else resolve();
    };
    child.once('error', finish);
    child.once('close', exited);
    child.stderr.on('data', collect);
    lines.on('line', (line) => {
      if (line === 'READY') finish();
    });
  });
}

export async function stopGoalBroker(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin.end();
  const deadline = setTimeout(() => child.kill(), 4000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}
