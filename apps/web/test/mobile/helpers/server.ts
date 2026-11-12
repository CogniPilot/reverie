import { WebServer } from '../../../src/web/server.js';

const servers = new Set<WebServer>();

/** A test server on an ephemeral port; read the port from `server.boundPort` once this resolves. */
export async function createTestServer(options: { titleHostname?: string } = {}): Promise<WebServer> {
  const server = new WebServer(0, false, true, '127.0.0.1', options.titleHostname); // testMode = true
  await server.start();
  servers.add(server);
  return server;
}

export async function stopTestServer(server: WebServer): Promise<void> {
  await server.stop();
  servers.delete(server);
}

export async function stopAllTestServers(): Promise<void> {
  for (const server of servers) {
    await server.stop();
  }
  servers.clear();
}
