/** Deterministic provider stand-in; executes the actual prepared hook, never a model API. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected fixture object');
  return value as Record<string, unknown>;
}
async function main() {
  if (process.argv.includes('--version')) {
    console.log('2.1.100 (Synthetic provider fixture)');
    return;
  }
  if (process.env.REVERIE_WORKER !== '1') throw new Error('Provider fixture requires the actual guest child');
  const control = record(JSON.parse(readFileSync(join(process.cwd(), '.native-hook-control.json'), 'utf8')));
  if (!['stop', 'permission_prompt'].includes(String(control.event))) throw new Error('Unsupported fixture event');
  const bytes = readFileSync(join(process.cwd(), '.claude/settings.local.json'));
  const settings = record(JSON.parse(bytes.toString('utf8')));
  const hooks = record(settings.hooks);
  const commands: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) throw new Error('Malformed prepared hooks');
    for (const group of groups) {
      const entries = record(group).hooks;
      if (!Array.isArray(entries)) throw new Error('Malformed prepared hook group');
      for (const entry of entries) {
        const value = record(entry);
        if (
          typeof value.command === 'string' &&
          value.command.includes('"event":"' + control.event + '"') &&
          value.command.includes('$REVERIE_API_URL/api/hook-event')
        )
          commands.push(value.command);
      }
    }
  }
  if (commands.length !== 1) throw new Error('Expected exactly one prepared fixture hook');
  const end = Date.now() + 3000;
  for (;;) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: 8093 });
      socket.setTimeout(100);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) break;
    if (Date.now() >= end) throw new Error('Packaged Office relay did not listen');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const environment = { ...process.env };
  if (control.wrongSession === true) environment.REVERIE_SESSION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const response = execFileSync('/bin/bash', ['-c', commands[0]], {
    env: environment,
    input: JSON.stringify({ message: 'Synthetic permission prompt', session_id: process.env.REVERIE_SESSION_ID }),
    timeout: 5000,
    maxBuffer: 32 * 1024,
    encoding: 'utf8',
  });
  console.log(
    JSON.stringify({
      event: control.event,
      settingsSha256: createHash('sha256').update(bytes).digest('hex'),
      executableSha256: createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'),
      commandSha256: createHash('sha256').update(commands[0]).digest('hex'),
      response: JSON.parse(response),
    })
  );
  process.stdout.write('\n────────────────────────────\n❯\n────────────────────────────\n  ? for shortcuts\n');
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Native hook provider fixture failed');
  process.exitCode = 1;
});
