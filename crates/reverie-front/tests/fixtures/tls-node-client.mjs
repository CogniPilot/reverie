// Actual Node HTTPS client; trust only the synthetic fixture CA and verify its name.
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
const [certificate, port] = process.argv.slice(2);
await new Promise((resolve, reject) => {
  const request = https.get({ host: '127.0.0.1', port: Number(port), servername: 'localhost',
    ca: readFileSync(certificate), ALPNProtocols: ['http/1.1'] }, response => {
    assert.equal(response.statusCode, 200);
    assert.equal(response.socket.encrypted, true);
    assert.equal(response.socket.alpnProtocol, 'http/1.1');
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () => {
      assert.equal(Buffer.concat(chunks).toString(), 'native TLS');
      console.log(JSON.stringify({ node: process.version, encrypted: true, status: response.statusCode }));
      resolve();
    });
  });
  request.setTimeout(2000, () => request.destroy(new Error('owned TLS client deadline')));
  request.once('error', reject);
});
