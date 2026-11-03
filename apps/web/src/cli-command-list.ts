/**
 * @fileoverview The command paths the agent CLI registers ("agent journal save", "plans show", ...), so a seat's CLI
 * can be compared with the CLI built from the server's own source. A version string cannot show the difference: a
 * stale seat build can report the same version while lacking commands the website documents.
 */
import type { Command } from 'commander';

/** Every command path under `cmd`, parents included, as space-joined names. */
export function commandPaths(cmd: Command, prefix = ''): string[] {
  return cmd.commands.flatMap((child) => {
    const path = prefix ? `${prefix} ${child.name()}` : child.name();
    return [path, ...commandPaths(child, path)];
  });
}

let cached: Promise<string[]> | undefined;

/** The sorted paths registerAgentCommands adds, computed once per process. Imported lazily to keep the CLI out of start-up. */
export function agentCommandPaths(): Promise<string[]> {
  cached ??= (async () => {
    const [{ Command }, { registerAgentCommands }] = await Promise.all([import('commander'), import('./cli-agent.js')]);
    const program = new Command('reverie');
    registerAgentCommands(program);
    return [...new Set(commandPaths(program))].sort();
  })();
  return cached;
}

/** What the server's CLI has and this one lacks, given both lists; an unknown server list reports nothing missing. */
export function missingCommands(server: unknown, local: readonly string[]): string[] {
  if (!Array.isArray(server)) return [];
  const have = new Set(local);
  return server.filter((p): p is string => typeof p === 'string' && p.length <= 200 && !have.has(p)).slice(0, 100);
}
