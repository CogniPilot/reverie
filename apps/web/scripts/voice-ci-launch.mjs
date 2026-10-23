import { accessSync, constants, statSync } from 'node:fs';

/** Explicit, sandboxed browser selection, matching the SLAM worker pattern. */
export function chromiumLaunchOptions(env = process.env) {
  const executablePath = env.CHROMIUM_PATH;
  if (!executablePath) throw new Error('Set CHROMIUM_PATH from nix develop .#voice-ci');
  accessSync(executablePath, constants.X_OK);
  if (!statSync(executablePath).isFile()) throw new Error('CHROMIUM_PATH must be an executable file');
  return { executablePath, chromiumSandbox: true };
}
