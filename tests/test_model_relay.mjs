import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelRelay } from '../apps/host/model-relay.mjs';

test('private socket relay preserves authenticated requests, streamed responses and disconnect cancellation', async () => {
 const root = await mkdtemp(join(tmpdir(), 'model-relay-')), socket = join(root, 'model.sock');
 let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
 const upstream = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer synthetic-only');
  if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); res.on('close', resolveClosed); return; }
  let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, body: JSON.parse(body) })); });
 });
 await new Promise(resolve => upstream.listen(socket, resolve)); await chmod(socket, 0o600);
 const relay = modelRelay(socket, 0); await once(relay, 'listening');
 const base = `http://127.0.0.1:${relay.address().port}`;
 try {
  assert.equal(relay.address().address, '127.0.0.1');
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer synthetic-only', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', messages: [] }) });
  assert.deepEqual(await response.json(), { path: '/v1/chat/completions', body: { model: 'fixture', messages: [] } });
  const controller = new AbortController();
  const stream = await fetch(base + '/stream', { headers: { authorization: 'Bearer synthetic-only' }, signal: controller.signal });
  assert.ok((await stream.body.getReader().read()).value.length > 0); controller.abort();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream was not cancelled')), 2000).unref())]);
  await chmod(socket, 0o666); assert.equal((await fetch(base + '/health')).status, 503);
 } finally { relay.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(resolve => relay.close(resolve)), new Promise(resolve => upstream.close(resolve))]); await rm(root, { recursive: true, force: true }); }
});
test('missing model socket returns a useful unavailable response', async () => {
 const root = await mkdtemp(join(tmpdir(), 'no-model-')), server = modelRelay(join(root, 'missing.sock'), 0); await once(server, 'listening');
 try { const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`); assert.equal(response.status, 503); assert.match((await response.json()).error.message, /Start reverie-local-model/); }
 finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
