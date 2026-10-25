/** Small Nix-built add-on for existing laptops; no laptop/provider restart required. */
import { spawnSync } from 'node:child_process';
import { agentCapabilities } from './cli-agent-capabilities.js';
import type { AgentDeps } from './cli-agent.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'reverie agent capabilities [--json]\nRead authenticated current capabilities; no mutation or token reads.'
  );
} else if (args.some((arg) => arg !== '--json') || args.filter((arg) => arg === '--json').length > 1) {
  console.error('Usage: reverie agent capabilities [--json]');
  process.exitCode = 4;
} else if (process.env.REVERIE_MUX !== '1' || !process.env.REVERIE_API_URL || !process.env.REVERIE_SESSION_ID) {
  console.error('Not inside a Reverie-managed session; refusing to guess an office or identity.');
  process.exitCode = 4;
} else {
  const deps: AgentDeps = {
    ctx: { selfId: process.env.REVERIE_SESSION_ID, apiUrl: process.env.REVERIE_API_URL },
    json: args.includes('--json'),
    io: { out: (text) => console.log(text), err: (text) => console.error(text) },
    request: async (_context, request) => {
      if (request.method !== 'GET' || request.path !== '/api/board') throw new Error('Unexpected add-on request');
      // The installed CLI retains its existing scoped phone/auth/guard implementation.
      const result = spawnSync('/bin/reverie', ['board', 'show', '--json'], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      });
      if (result.error || result.status !== 0)
        return {
          status: result.status === 4 ? 403 : 503,
          text: '',
          json: {
            success: false,
            error: 'The installed CLI could not read the Board through this laptop office phone.',
          },
        };
      try {
        return { status: 200, text: '', json: { success: true, data: JSON.parse(result.stdout) } };
      } catch {
        return {
          status: 502,
          text: '',
          json: { success: false, error: 'The installed Board command returned invalid JSON.' },
        };
      }
    },
  };
  process.exitCode = await agentCapabilities(deps);
}
