import http from 'node:http';
import type { AddressInfo } from 'node:net';

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

const holdFirst = process.argv.includes('--hold-first');
let requests = 0;

function respond(response: http.ServerResponse, stream: boolean): void {
  const event = { choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }] };
  const message = { choices: [{ message: { content: 'Done.' } }] };
  const body = stream ? `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n` : JSON.stringify(message);
  response.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
  const held = holdFirst && ++requests === 1;
  if (held) {
    response.once('close', () => emit({ kind: 'disconnected' }));
  }
  emit({ kind: 'request', path: request.url, payload });
  if (!held) {
    respond(response, payload.stream === true);
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  emit({ kind: 'ready', url: `http://127.0.0.1:${port}/v1` });
});

process.stdin.resume();
process.stdin.on('end', () => {
  server.closeAllConnections();
  server.close();
});
