/** Reverie instances have distinct state and tmux sockets; no automatic legacy migration. */
import { envValue } from './fleet-env.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Legacy export name retained for existing internal callers. */
export const CODEMAN_INSTANCE = envValue(process.env, 'INSTANCE') ?? process.env.CODEMAN_INSTANCE ?? '';
const INSTANCE_SUFFIX = CODEMAN_INSTANCE ? `-${CODEMAN_INSTANCE.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)}` : '';
export const DEFAULT_TMUX_SOCKET = `fleet${INSTANCE_SUFFIX}`;
export const SAFE_TMUX_SOCKET_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export function resolveTmuxSocketName(): string {
  const raw = envValue(process.env, 'TMUX_SOCKET') ?? process.env.CODEMAN_TMUX_SOCKET;
  return raw !== undefined && SAFE_TMUX_SOCKET_PATTERN.test(raw) ? raw : DEFAULT_TMUX_SOCKET;
}

let ensuredDir: string | undefined;
export function getDataDir(): string {
  const dir = envValue(process.env, 'DATA_DIR') || process.env.CODEMAN_DATA_DIR || join(homedir(), `.fleet${INSTANCE_SUFFIX}`);
  if (ensuredDir !== dir) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      ensuredDir = dir;
    } catch {
      // Writers report their own persistence errors.
    }
  }
  return dir;
}

export function dataPath(...segments: string[]): string {
  return join(getDataDir(), ...segments);
}
