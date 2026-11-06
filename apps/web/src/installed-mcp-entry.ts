/** Raw package entry executed only by the fixed Rust MCP launcher. No console
 * wrapper, interpreter selection, issuer credential or tool-request bootstrap.
 */
import { createRequire } from 'node:module';
import { installedMcpBootstrap } from './installed-mcp-bootstrap.js';
import { runMcpStdio } from './mcp-server.js';

const stop = new AbortController();
let stopped: NodeJS.Signals | undefined;
const onStop = (signal: NodeJS.Signals) => {
  stopped ??= signal;
  stop.abort();
};
const interrupt = () => onStop('SIGINT');
const terminate = () => onStop('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  const require = createRequire(import.meta.url);
  const version = (require('../package.json') as { version: string }).version;
  const { config, memory } = installedMcpBootstrap(process.argv.slice(2), version);
  await runMcpStdio(config, process, { memory, signal: stop.signal });
  process.exitCode = stopped === 'SIGTERM' ? 143 : stopped === 'SIGINT' ? 130 : 0;
} catch {
  // Cleanup belongs to runMcpStdio before this negative result. Avoid a blocking
  // diagnostic transport delaying child settlement or leaking private paths.
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
