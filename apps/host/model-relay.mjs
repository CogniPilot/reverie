/** Container loopback HTTP -> owner-mounted Unix socket. Credentials stay end-to-end. */
import http from 'node:http';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export function modelRelay(socketPath, port = 8092) {
  const server = http.createServer(async (request, response) => {
    try {
      const info = await lstat(socketPath);
      if (!info.isSocket() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Unavailable');
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Local model service is unavailable. Start reverie-local-model on the host.' } }));
      return;
    }
    const headers = { ...request.headers, host: 'localhost' };
    delete headers.connection;
    const upstream = http.request({ socketPath, path: request.url, method: request.method, headers }, result => {
      const outgoing = { ...result.headers }; delete outgoing.connection;
      response.writeHead(result.statusCode ?? 502, outgoing);
      result.pipe(response);
      result.on('error', () => response.destroy());
    });
    upstream.setTimeout(300000, () => upstream.destroy(new Error('Model request timed out')));
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":{"message":"Local model service is unavailable"}}'); }
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.requestTimeout = 300000;
  server.listen(port, '127.0.0.1');
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = modelRelay(process.env.REVERIE_MODEL_SOCKET ?? '/run/reverie-control/models/default.sock');
  server.on('error', () => { process.stderr.write('Local model relay could not start\n'); process.exitCode = 1; });
}
