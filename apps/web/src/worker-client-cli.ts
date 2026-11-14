/** Standalone worker client entry. No web server, host broker or startup script. */
import { Command } from 'commander';
import { workerCallback, workerHookSettings } from './worker-client-callback.js';
import { workerClientStatus } from './worker-client-manifest.js';
const program = new Command().name('reverie');
if (!['worker-client', 'worker-callback', '--help', '-h'].includes(process.argv[2] ?? '')) {
  const { registerAgentCommands } = await import('./cli-agent.js');
  registerAgentCommands(program);
}
const client = program
  .command('worker-client')
  .description('Read the fixed worker client capsule; no instance effects');
client
  .command('status')
  .requiredOption('--expected-digest <sha256>', 'Exact selected immutable manifest digest')
  .action((options: { expectedDigest: string }) => {
    try {
      console.log(JSON.stringify(workerClientStatus(options.expectedDigest)));
    } catch {
      console.error('Worker client qualification refused');
      process.exitCode = 1;
    }
  });
client
  .command('hook-settings')
  .description('Print the fixed managed Claude report configuration')
  .action(() => console.log(JSON.stringify(workerHookSettings())));
const callback = program.command('worker-callback').description('Bound callback on JSON stdin; token file only');
for (const kind of ['hook-event', 'status-telemetry'] as const) {
  const command = callback.command(kind);
  if (kind === 'hook-event') command.requiredOption('--event <name>', 'Closed hook event name');
  command.action(async (options: { event?: string }) => {
    try {
      const output = await workerCallback(kind, options.event);
      if (output !== undefined) console.log(output);
    } catch {
      console.error('Worker callback unconfirmed; inspect the current session');
      process.exitCode = 1;
    }
  });
}
await program.parseAsync(process.argv);
