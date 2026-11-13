import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { ChatLanguageRequest, ChatLanguageService } from '../src/chat-language-service.js';
import { ChatPluginSettingsStore } from '../src/chat-plugin-settings.js';
import { registerChatPluginRoutes } from '../src/web/routes/chat-plugin-routes.js';

const request = {
  enabled: true,
  language: 'python',
  source: 'x = "λ"',
  action: 'hover',
  position: { line: 0, character: 3 },
};
let directory: string;
const services: ChatLanguageService[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chat-lsp-test-'));
});
afterEach(async () => {
  services.splice(0).forEach((service) => service.stop());
  await rm(directory, { recursive: true, force: true });
});

/** Each original child publishes a complete receipt before cancellation. */
async function started(file: string, count: number, timeoutMs = 10000): Promise<Array<{pid: number}>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const prefix = basename(file) + '.';
      const names = (await readdir(dirname(file))).filter((name) => name.startsWith(prefix) && name.endsWith('.ready'));
      if (names.length === count)
        return await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dirname(file), name), 'utf8'))));
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error('Original fixture children did not publish readiness');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(mode = 'normal', timeoutMs = 2000, startDelayMs = 0) {
  const binary = join(directory, `server-${services.length}.cjs`);
  const receipt = join(directory, `receipt-${services.length}.json`);
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const receipt = ${JSON.stringify(receipt)}, mode = ${JSON.stringify(mode)};
// A slow start, as on a loaded runner: nothing is written until it has passed.
if (${startDelayMs} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startDelayMs});
const descendant = mode === 'descendant' ? require('node:child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'}) : null;
const audit = JSON.stringify({pid: process.pid, child: descendant?.pid, env: process.env, cwd: process.cwd()});
const ready = receipt+'.'+process.pid+'.ready';
// Another original child may start concurrently. Never expose a truncated
// receipt or replace the only evidence of the first child's identity.
fs.writeFileSync(ready+'.tmp', audit); fs.renameSync(ready+'.tmp', ready);
fs.writeFileSync(receipt+'.'+process.pid+'.tmp', audit); fs.renameSync(receipt+'.'+process.pid+'.tmp', receipt);
let input = Buffer.alloc(0), uri;
function send(msg) { const text=JSON.stringify({jsonrpc:'2.0',...msg}); process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text); }
process.stdin.on('data', data => { input = Buffer.concat([input,data]); while(true) {
 const end=input.indexOf('\\r\\n\\r\\n'); if(end<0)return;
 const size=Number(/Content-Length: (\\d+)/.exec(input.subarray(0,end).toString())[1]); if(input.length<end+4+size)return;
 const message=JSON.parse(input.subarray(end+4,end+4+size)); input=input.subarray(end+4+size);
 if(mode==='hang')continue;
 if(mode==='frame') { process.stdout.write('Content-Length: 99999999\\r\\n\\r\\n'); return; }
 if(mode==='stderr') { process.stderr.write('x'.repeat(5*1024*1024)); return; }
 if(message.method==='initialize') send({id:message.id,result:{capabilities:{}}});
 if(message.method==='textDocument/didOpen') { uri=message.params.textDocument.uri; fs.writeFileSync(receipt+'.source',message.params.textDocument.text);
  send({method:'textDocument/publishDiagnostics',params:{uri:'file:///secret.py',diagnostics:[{message:'wrong document'}]}});
  send({method:'textDocument/publishDiagnostics',params:{uri,diagnostics:[{message:'syntax λ <script>alert(1)</script>',range:{start:{line:0,character:1}},severity:1}]}});
 }
 if(message.method==='textDocument/hover') send({id:message.id,result:{contents:{kind:'markdown',value:'type λ <img src=x>'}}});
 if(message.method==='textDocument/completion') send({id:message.id,result:{items:[{label:'λabel',detail:'safe detail',command:{command:'runCode'},insertText:'execute()'}]}});
}});
`,
    { mode: 0o700 }
  );
  const service = new ChatLanguageService({
    binaries: { python: binary, modelica: binary },
    scratch: join(directory, 'snippets'),
    timeoutMs,
    enabled: () => true,
  });
  services.push(service);
  return { service, receipt };
}

describe('explicit snippet assistance', () => {
  it('fails closed for direct service calls unless enabled by its owner-controlled gate', async () => {
    const service = new ChatLanguageService();
    await expect(service.assist(request)).rejects.toThrow('disabled by the owner');
  });
  it('rejects disabled, malformed, oversized and path/RPC inputs before any server starts', async () => {
    const { service, receipt } = await fixture();
    for (const input of [
      { ...request, enabled: false },
      { ...request, source: 'x'.repeat(50001) },
      { ...request, language: 'sh' },
      { ...request, method: 'workspace/executeCommand' },
      { ...request, uri: 'file:///private.py' },
      { ...request, position: { line: 2, character: 0 } },
    ]) {
      await expect(service.assist(input)).rejects.toThrow();
    }
    await expect(readFile(receipt)).rejects.toThrow();
  });
  it('reports unavailable binaries without starting a process or creating scratch files', async () => {
    const service = new ChatLanguageService({
      binaries: { python: 'relative-command' },
      scratch: join(directory, 'unused'),
      enabled: () => true,
    });
    expect(await service.available()).toEqual({ python: false, modelica: false });
    await expect(service.assist(request)).rejects.toThrow('not configured');
    expect(await readdir(directory)).toEqual([]);
  });
  it('uses UTF-8 framed documents, strips commands from completion, and removes temporary HOME after reaping', async () => {
    const { service, receipt } = await fixture();
    process.env.REVERIE_TEST_PROVIDER_SECRET = 'must-not-leak';
    try {
      const result = await service.assist({ ...request, action: 'completion' });
      expect(result.completions).toEqual([{ label: 'λabel', detail: 'safe detail' }]);
      expect(result.diagnostics.map((item) => item.message)).toEqual(['syntax λ <script>alert(1)</script>']);
      const audit = JSON.parse(await readFile(receipt, 'utf8'));
      expect(audit.env.REVERIE_TEST_PROVIDER_SECRET).toBeUndefined();
      // The host scratch directory may be reached through a symlink.
      expect(await realpath(join(audit.env.HOME, '..'))).toBe(join(audit.cwd, '..'));
      expect(audit.cwd).toContain('/snippets/snippet-');
      expect(await readFile(receipt + '.source', 'utf8')).toBe(request.source);
      await expect(readdir(audit.cwd)).rejects.toThrow();
      expect(() => process.kill(audit.pid, 0)).toThrow();
    } finally {
      delete process.env.REVERIE_TEST_PROVIDER_SECRET;
    }
  });
  it('supports Modelica diagnostics and safe text hover without evaluating either language', async () => {
    const { service } = await fixture();
    const diagnostics = await service.assist({ ...request, language: 'modelica', action: 'diagnostics' });
    expect(diagnostics.diagnosticsReceived).toBe(true);
    expect(diagnostics.diagnostics[0].line).toBe(0);
    expect((await service.assist(request)).hover).toBe('type λ <img src=x>');
  });
  it.skipIf(process.platform !== 'linux')(
    'kills a server wrapper and its child before releasing the request',
    async () => {
      const { service, receipt } = await fixture('descendant');
      await service.assist(request);
      const audit = JSON.parse(await readFile(receipt, 'utf8'));
      expect(audit.child).toBeTypeOf('number');
      try {
        let running = true;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const info = await readFile(`/proc/${audit.child}/stat`, 'utf8');
            running = info.slice(info.lastIndexOf(') ') + 2).split(' ')[0] !== 'Z';
          } catch {
            running = false;
          }
          if (!running) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(running).toBe(false);
        expect(() => process.kill(audit.pid, 0)).toThrow();
      } finally {
        try {
          process.kill(audit.child, 'SIGKILL');
        } catch {
          /* already reaped */
        }
      }
    }
  );
  it('rejects oversized output frames and stderr', async () => {
    for (const mode of ['frame', 'stderr']) {
      const { service } = await fixture(mode);
      await expect(service.assist(request)).rejects.toThrow(/frame|output limit/);
    }
  });
  it('bounds concurrency and kills hung servers on cancellation, shutdown and deadline', async () => {
    // A server that starts slowly, as on a loaded runner: cancelling before it has started would leave no receipt.
    const { service, receipt } = await fixture('hang', 2000, 300);
    const controller = new AbortController();
    const first = service.assist(request, controller.signal).catch((error) => error);
    const second = service.assist(request).catch((error) => error);
    await expect(service.assist(request)).rejects.toThrow('busy');
    const audits = await started(receipt, 2);
    expect(new Set(audits.map((audit) => audit.pid)).size).toBe(2);
    controller.abort();
    expect((await first).message).toContain('cancelled');
    service.stop();
    expect((await second).message).toContain('cancelled');
    for (const audit of audits) expect(() => process.kill(audit.pid, 0)).toThrow();
    const timeout = await fixture('hang', 100);
    await expect(timeout.service.assist(request)).rejects.toThrow(/timed out|deadline/);
  });
});

describe('owner-only plugin routes', () => {
  it('keeps GET read-only and denies agents, disabled requests and raw RPC before starting a server', async () => {
    const { service, receipt } = await fixture();
    const app = Fastify();
    const settings = new ChatPluginSettingsStore(join(directory, 'settings.json'));
    registerChatPluginRoutes(app, (req) => req.headers.authorization === 'owner', service, settings);
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/api/chat-plugins', headers: { authorization: 'owner' } })).json().data
          .available.python
      ).toBe(true);
      const post = (payload: unknown, authorization?: string) =>
        app.inject({
          method: 'POST',
          url: '/api/chat-plugins/lsp',
          payload,
          headers: authorization ? { authorization } : {},
        });
      expect((await post(request)).statusCode).toBe(403);
      expect((await post({ ...request, enabled: false }, 'owner')).statusCode).toBe(400);
      expect((await post({ ...request, command: 'python source.py' }, 'owner')).statusCode).toBe(400);
      await expect(readFile(receipt)).rejects.toThrow();
      expect((await post(request, 'owner')).json().errorCode).toBe('PLUGIN_DISABLED');
      await settings.save({ latex: false, python: true, modelica: false });
      const response = await post(request, 'owner');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().data.hover).toBe('type λ <img src=x>');
    } finally {
      await app.close();
    }
  });
  it('validates cursor positions in UTF-16 LSP units', () => {
    expect(
      ChatLanguageRequest.safeParse({ ...request, source: '😀', position: { line: 0, character: 2 } }).success
    ).toBe(true);
    expect(
      ChatLanguageRequest.safeParse({ ...request, source: '😀', position: { line: 0, character: 3 } }).success
    ).toBe(false);
  });
});
