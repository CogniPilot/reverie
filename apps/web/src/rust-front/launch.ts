/**
 * Running `reverie web` behind the native front, when the installed service selected it.
 *
 * `reverie service install --native-front` writes REVERIE_NATIVE_FRONT=1 into the unit, and the Nix launcher exports
 * the front's binary as REVERIE_NATIVE_FRONT_BIN. The selected `reverie web` then replaces its own process with the
 * front (process.execve), with this same Node, entry and web arguments, so the service's main process is the front
 * itself. The front owns the listeners and runs the real server as its child, which finds the channel on fd 3 by
 * REVERIE_FRONT_CHILD (see frontFromEnvironment in web/server.ts).
 */

/** The exit status when the front is selected but cannot be started: nothing listens rather than TS alone. */
export const FRONT_UNAVAILABLE_EXIT = 78;

export interface FrontLaunch {
  command: string;
  args: string[];
}

type Execve = (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;

/**
 * The front command for this `reverie web`, or undefined when it should serve directly: unselected, or already the
 * front's child. Selected without a front binary is an error, never a silent TS-only start.
 */
export function frontLaunch(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  execPath: string
): FrontLaunch | undefined {
  if (env.REVERIE_NATIVE_FRONT !== '1' || env.REVERIE_FRONT_CHILD === '1') return undefined;
  const command = env.REVERIE_NATIVE_FRONT_BIN;
  if (!command) throw new Error('The native front is selected, but REVERIE_NATIVE_FRONT_BIN names no front binary');
  const entry = argv[1];
  if (!entry) throw new Error('The native front is selected, but the reverie entry script is unknown');
  return { command, args: ['--node', execPath, '--entrypoint', entry, '--', ...argv.slice(2)] };
}

/**
 * Replace this process with the front. It returns only by throwing: when this Node has no process.execve, or the
 * exec itself fails (a missing or non-executable front). The front's child is marked REVERIE_FRONT_CHILD.
 */
export function execFront(
  launch: FrontLaunch,
  env: NodeJS.ProcessEnv = process.env,
  execve: Execve | null = (process as { execve?: Execve }).execve?.bind(process) ?? null
): never {
  if (typeof execve !== 'function') {
    throw new Error(`This Node (${process.version}) cannot replace its process; the native front is not started`);
  }
  return execve(launch.command, [launch.command, ...launch.args], { ...env, REVERIE_FRONT_CHILD: '1' });
}
