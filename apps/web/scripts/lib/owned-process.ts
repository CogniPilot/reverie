/** Bounded POSIX subprocess owner for disposable acceptance fixtures. */
import { spawn } from 'node:child_process';

export class OwnedProcessError extends Error {
  constructor(
    message: string,
    readonly quiescence: 'confirmed' | 'unknown'
  ) {
    super(`${message}; process-group settlement ${quiescence}`);
  }
}
export async function runOwnedProcess(
  program: string,
  args: string[],
  options: {
    timeout?: number;
    environment?: NodeJS.ProcessEnv;
    allowed?: number[];
    outputLimit?: number;
  } = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const end = Date.now() + (options.timeout ?? 30_000),
    settleEnd = end + 1000;
  const limit = options.outputLimit ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    // The PGID is derived only from this fresh child. Callers cannot supply a
    // group ID. Escaped descendants are not claimed by process-group custody.
    const child = spawn(program, args, {
      env: options.environment ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let code: number | null = null,
      exited = false;
    let fault: string | undefined,
      failureEnd = settleEnd,
      killed = false,
      finished = false;
    const alive = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    };
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fault ??= 'Owned process group signal failed';
      }
    };
    const finish = (quiescent: boolean) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      const stdout = Buffer.concat(output.stdout).toString(),
        stderr = Buffer.concat(output.stderr).toString();
      if (fault || !quiescent || code === null || !(options.allowed ?? [0]).includes(code))
        reject(
          new OwnedProcessError(
            `${fault ?? 'Owned process failed'} (${code ?? 'signal'}); ${stderr.slice(-2000)}`,
            quiescent ? 'confirmed' : 'unknown'
          )
        );
      else resolve({ stdout, stderr, code });
    };
    const collect = (which: 'stdout' | 'stderr', data: Buffer) => {
      if (sizes[which] + data.length > limit) {
        fault ??= 'Owned process output limit';
        return;
      }
      output[which].push(data);
      sizes[which] += data.length;
    };
    child.stdout.on('data', (data) => collect('stdout', data));
    child.stderr.on('data', (data) => collect('stderr', data));
    child.stdout.on('error', () => {
      fault ??= 'Owned stdout failed';
    });
    child.stderr.on('error', () => {
      fault ??= 'Owned stderr failed';
    });
    child.once('error', () => {
      fault ??= 'Owned process spawn failed';
      exited = true;
    });
    child.once('exit', (value) => {
      code = value;
      exited = true;
    });
    const timer = setInterval(() => {
      let group: boolean;
      try {
        group = alive();
      } catch {
        fault ??= 'Owned process group status unknown';
        group = true;
      }
      const quiescent = exited && !group && child.stdout.readableEnded && child.stderr.readableEnded;
      if (quiescent) return finish(true);
      if (Date.now() >= end) fault ??= 'Owned process deadline';
      if (fault && !killed) {
        killed = true;
        failureEnd = Math.min(settleEnd, Date.now() + 1000);
        signal('SIGKILL');
      }
      if (Date.now() >= failureEnd) finish(false);
    }, 10);
  });
}
