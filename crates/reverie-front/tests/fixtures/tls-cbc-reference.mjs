// Synthetic compatibility witness, never a product trust policy.
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
const [cert, key] = process.argv.slice(2);
const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const socket = tls.connect({ host: '127.0.0.1', port: server.address().port,
  rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
  ciphers: 'ECDHE-RSA-AES128-SHA256' });
const timer = setTimeout(() => { socket.destroy(); server.close(); process.exitCode = 1; }, 2000);
try {
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  assert.equal(socket.getProtocol(), 'TLSv1.2');
  assert.equal(socket.getCipher().standardName, 'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256');
  console.log(JSON.stringify({ node: process.version, protocol: socket.getProtocol(), cipher: socket.getCipher() }));
} finally {
  clearTimeout(timer); socket.destroy(); server.close();
}
