/** Actual native bridge CLI/pipe transport, wholly synthetic engine/role receipts.
 * This does not qualify an image, kernel closure receipt, or commercial provider.
 */
import {expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {createConnection, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {setTimeout as delay} from 'node:timers/promises';
import {AttachmentFrames} from '../scripts/operator-viewer-input.js';
const target = {sessionId: '00000001-0001-4000-8000-000000000001', containerId: 'a'.repeat(64),
  startedAt: '2026-11-11T00:00:00.000Z', pid: 1234};
const row = {Id: target.containerId, Name: `/reverie-agent-${target.sessionId}`,
  State: {Running: true, StartedAt: target.startedAt, Pid: target.pid}};
function encoded(kind: string, value: Buffer): Buffer {
  const header = Buffer.alloc(5); header[0] = kind.charCodeAt(0); header.writeUInt32BE(value.length, 1);
  return Buffer.concat([header, value]);
}
async function until(test: () => boolean, milliseconds = 8000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!test()) {if (performance.now() >= end) throw new Error('Bounded synthetic native bridge timed out'); await delay(10);}
}
function fixture(supported = true, startupDelay = 0, handshake: 'valid' | 'foreign' | 'missing' = 'valid') {
  const root = mkdtempSync(join(tmpdir(), 'native-pipe-')); chmodSync(root, 0o700);
  const state = join(root, 'state.json'), received = join(root, 'received'), effects = join(root, 'effects'), probes = join(root, 'probes');
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(state, JSON.stringify({supported, pane: '$0|123|%0|101|0', clients: [], released: false}));
  for (const file of [received, effects, probes]) writeFileSync(file, '');
  writeFileSync(join(root, 'docker'), `#!${process.execPath}
const fs=require('node:fs');
const a=process.argv.slice(2);if(a[0]!=='--host'||a[1]!=='unix:///fixture/docker.sock')process.exit(98);a.splice(0,2);
const state=${JSON.stringify(state)},received=${JSON.stringify(received)},effects=${JSON.stringify(effects)},probes=${JSON.stringify(probes)};
const read=()=>JSON.parse(fs.readFileSync(state,'utf8'));
const save=value=>{const p=state+'.'+process.pid+'.tmp';fs.writeFileSync(p,JSON.stringify(value));fs.renameSync(p,state);};
const words='4321 99 00000000-0000-4000-8000-000000000001 4026532000';
if(a[0]==='inspect'&&a[1]===${JSON.stringify(target.containerId)}){
 fs.appendFileSync(probes,'inspect\\n');setTimeout(()=>process.stdout.write(JSON.stringify([${JSON.stringify(row)}])),75);
}else if(a[0]==='exec'&&a.includes('display-message')){
 fs.appendFileSync(probes,'pane\\n');console.log(read().pane);
}else if(a[0]==='exec'&&a.includes('list-clients')){
 process.stdout.write(read().clients.map(pid=>String(pid)+'\\n').join(''));
}else if(a[0]==='exec'&&a.includes('viewer-v1')){
 const action=a[a.indexOf('viewer-v1')+1],nonce=a[a.indexOf('--nonce')+1];
 if(action==='capabilities'){if(!read().supported){console.error('unsupported fixed viewer role');process.exit(2);}console.log('REVERIE_VIEWER_CHILD_V1');}
 else if(action==='attach'){
  fs.appendFileSync(effects,'attach-dispatched\\n');
  let ended=false;process.stdin.on('end',()=>{ended=true;if(read().nonce===nonce){fs.appendFileSync(effects,'stdin-eof\\n');save({...read(),clients:[]});}});
  setTimeout(()=>{
  fs.appendFileSync(effects,'attach\\n');save({...read(),clients:[1234],nonce});
  const cols=Number(a[a.indexOf('--cols')+1]),rows=Number(a[a.indexOf('--rows')+1]);
  const readyNonce=${JSON.stringify(handshake)}==='foreign'?(nonce[0]==='a'?'b':'a')+nonce.slice(1):nonce;
  if(${JSON.stringify(handshake)}!=='missing')process.stdout.write('READY '+readyNonce+' 1234 '+words+'\\nGEOMETRY:'+rows+' '+cols+'\\n');
  let buffer=Buffer.alloc(0);
  process.stdin.on('data',bytes=>{buffer=Buffer.concat([buffer,bytes]);while(buffer.length>=5){
   const count=buffer.readUInt32BE(1);if(count>262144)process.exit(96);if(buffer.length<5+count)return;
   const kind=buffer[0],payload=buffer.subarray(5,5+count);buffer=buffer.subarray(5+count);
   if(kind===73){fs.appendFileSync(received,payload);fs.appendFileSync(effects,'I\\n');process.stdout.write(payload);}
   else if(kind===82){const pair=JSON.parse(payload);fs.appendFileSync(effects,'R:'+pair.join('x')+'\\n');process.stdout.write('GEOMETRY:'+pair[1]+' '+pair[0]+'\\n');}
   else process.exit(95);
  }});
  if(ended){fs.appendFileSync(effects,'stdin-eof\\n');save({...read(),clients:[]});}
  setInterval(()=>{if(read().released)process.exit(0);},10);
  },${startupDelay});
  process.stdin.resume();
 }else if(action==='close'){
  fs.appendFileSync(effects,'close-attempt\\n');
  if(read().nonce!==nonce)process.exit(94);fs.appendFileSync(effects,'close\\n');save({...read(),clients:[]});console.log('CLOSED '+nonce+' 1234 '+words);
 }else if(action==='status'){
  fs.appendFileSync(effects,'status\\n');
  if(read().nonce!==nonce)process.exit(94);console.log(read().clients.length?'PENDING':'CLOSED '+nonce+' 1234 '+words);
 }else if(action==='release'){
  if(read().nonce!==nonce||read().clients.length)process.exit(93);fs.appendFileSync(effects,'release\\n');save({...read(),released:true});console.log('RELEASED '+nonce+' 1234 '+words);
 }else process.exit(92);
}else{console.error('Unexpected synthetic Docker operation');process.exit(99);}
`, {mode: 0o700});
  const socket = join(root, 'v.sock');
  const source = fileURLToPath(new URL('../scripts/operator-viewer-bridge.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', source, '--session-id', target.sessionId, '--container-id', target.containerId,
    '--started-at', target.startedAt, '--pid', String(target.pid), '--socket', socket], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, REVERIE_OPERATOR_DOCKER_HOST: 'unix:///fixture/docker.sock', PATH: `${root}:${process.env.PATH}`},
  });
  let ready = false, diagnostic = '';
  child.stdout.on('data', bytes => {if (String(bytes).includes('Operator attachment ready')) ready = true;});
  child.stderr.on('data', bytes => {diagnostic += String(bytes);});
  let peer: Socket | undefined;
  return {root, state, effects, probes, received, child, socket,
    ready: () => ready, diagnostic: () => diagnostic,
    async connect() {
      peer = createConnection(socket);
      peer.on('error', () => {});
      await new Promise<void>((resolve, reject) => {peer!.once('connect', resolve); peer!.once('error', reject);});
      return peer;
    },
    async close() {
      peer?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      let settled = false;
      try {await until(() => child.exitCode !== null || child.signalCode !== null); settled = true;} finally {
        if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL'); await until(() => child.signalCode !== null);}
        if (settled) rmSync(root, {recursive: true, force: true});
        else console.error(`Retained uncertain synthetic native fixture: ${root}`);
      }
    },
  };
}

async function withFixture(f: ReturnType<typeof fixture>, body: () => Promise<void>): Promise<void> {
  let failure: {cause: unknown} | undefined;
  try {await body();} catch (cause) {failure = {cause};}
  try {await f.close();} catch (cleanup) {
    throw new AggregateError(failure ? [failure.cause, cleanup] : [cleanup], `Synthetic native bridge cleanup failed: ${f.diagnostic()}`);
  }
  if (failure) throw failure.cause;
}

it('uses the actual native bridge CLI with ordered sealed I/R batches, UTF8, and changed-pane refusal', async () => {
  const f = fixture();
  await withFixture(f, async () => {
    await until(() => f.ready() || f.child.exitCode !== null); expect(f.child.exitCode, f.diagnostic()).toBe(null);
    const peer = await f.connect();
    let output = '', refused = false;
    const utf8 = new StringDecoder('utf8');
    const decoder = new AttachmentFrames((kind, bytes) => {if (kind === 79) output += utf8.write(bytes); if (kind === 69) refused = true;});
    peer.on('data', bytes => decoder.feed(bytes));
    peer.write(encoded('J', Buffer.from(JSON.stringify({sessionId: target.sessionId, attachOnly: true, cols: 80, rows: 24}))));
    // Queue before READY: no write can bypass its actual native census/admission.
    const text = '漢🙂' + '0123456789'.repeat(100);
    peer.write(Buffer.concat([encoded('R', Buffer.from('[120,40]')),
      ...[...Buffer.from(text)].map(byte => encoded('I', Buffer.from([byte])))]));
    await until(() => readFileSync(f.received).equals(Buffer.from(text)) && output.includes('GEOMETRY:40 120'));
    expect(refused).toBe(false);
    const effects = readFileSync(f.effects, 'utf8').trim().split('\n');
    expect(effects[0]).toBe('attach-dispatched'); expect(effects[1]).toBe('attach'); expect(effects[2]).toBe('R:120x40');
    expect(effects.filter(x => x === 'I').length).toBeLessThan(10);
    expect(readFileSync(f.probes, 'utf8').split('inspect\n').length - 1).toBeLessThan(20);
    const before = readFileSync(f.probes, 'utf8').length;
    peer.write(encoded('I', Buffer.from('must-not-arrive')));
    await until(() => readFileSync(f.probes, 'utf8').length > before);
    const state = JSON.parse(readFileSync(f.state, 'utf8'));
    const changed = f.state + '.changed';
    writeFileSync(changed, JSON.stringify({...state, pane: '$0|123|%0|202|0'}));
    const {renameSync} = await import('node:fs'); renameSync(changed, f.state);
    await until(() => refused);
    await until(() => readFileSync(f.effects, 'utf8').includes('release\n'));
    expect(readFileSync(f.received).equals(Buffer.from(text))).toBe(true);
    expect(readFileSync(f.effects, 'utf8').split('close\n').length - 1).toBe(1);
    expect(readFileSync(f.effects, 'utf8').split('release\n').length - 1).toBe(1);
  });
}, 20000);

it.each(['foreign', 'missing'] as const)('keeps %s constructor held without CLOSE/replacement until genuine read-only reconciliation', async handshake => {
  const f = fixture(true, 0, handshake);
  await withFixture(f, async () => {
    await until(() => f.ready());
    const peer = await f.connect();
    peer.write(encoded('J', Buffer.from(JSON.stringify({sessionId: target.sessionId, attachOnly: true, cols: 80, rows: 24}))));
    await until(() => f.diagnostic().includes('Original viewer cleanup is unconfirmed'));
    await until(() => readFileSync(f.effects, 'utf8').includes('stdin-eof\n'));
    expect(readFileSync(f.effects, 'utf8')).not.toContain('close-attempt\n');
    expect(readFileSync(f.effects, 'utf8')).not.toContain('release\n');
    const rejected = await f.connect(); let refused = false;
    const refusal = new AttachmentFrames(kind => {if (kind === 69) refused = true;});
    rejected.on('data', bytes => refusal.feed(bytes));
    rejected.write(encoded('J', Buffer.from(JSON.stringify({sessionId: target.sessionId, attachOnly: true, cols: 80, rows: 24}))));
    await until(() => refused);
    expect(readFileSync(f.effects, 'utf8').split('\n').filter(x => x === 'attach')).toHaveLength(1);
    const query = await f.connect(); let settled = false;
    const status = new AttachmentFrames((kind, data) => {if (kind === 83) settled = JSON.parse(data.toString()).attachmentClosed === true;});
    query.on('data', bytes => status.feed(bytes));
    query.write(encoded('K', Buffer.from(JSON.stringify({sessionId: target.sessionId, action: 'reconcile-viewer'}))));
    await until(() => settled);
    const effects = readFileSync(f.effects, 'utf8');
    expect(effects).toContain('status\n'); expect(effects).toContain('release\n');
    expect(effects).not.toContain('close-attempt\n');
    expect(readFileSync(f.received, 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(f.state, 'utf8'))).toMatchObject({clients: [], released: true});
  });
}, 20000);

it('refuses unsupported fixed roles before socket publication or native attachment without fallback', async () => {
  const f = fixture(false);
  await withFixture(f, async () => {
    await until(() => f.child.exitCode !== null);
    expect(f.child.exitCode).toBe(1); expect(existsSync(f.socket)).toBe(false);
    expect(readFileSync(f.effects, 'utf8')).toBe('');
    expect(f.diagnostic()).toContain('unsupported fixed viewer role');
  });
}, 15000);

it.each(['peer-disconnect', 'service-stop'])('joins original delayed startup before the sole CLOSE after %s', async reason => {
  const f = fixture(true, 700);
  await withFixture(f, async () => {
    await until(() => f.ready());
    const peer = await f.connect();
    peer.write(Buffer.concat([
      encoded('J', Buffer.from(JSON.stringify({sessionId: target.sessionId, attachOnly: true, cols: 80, rows: 24}))),
      encoded('I', Buffer.from('never-submit-this')),
    ]));
    await until(() => readFileSync(f.effects, 'utf8').includes('attach-dispatched\n'));
    expect(readFileSync(f.effects, 'utf8')).not.toContain('attach\n');
    if (reason === 'peer-disconnect') peer.destroy(); else f.child.kill('SIGTERM');
    await until(() => readFileSync(f.effects, 'utf8').includes('release\n'));
    const effects = readFileSync(f.effects, 'utf8').trim().split('\n');
    expect(effects.filter(x => x === 'attach')).toHaveLength(1);
    expect(effects.filter(x => x === 'close-attempt')).toHaveLength(1);
    expect(effects.indexOf('close-attempt')).toBeGreaterThan(effects.indexOf('attach'));
    expect(effects.filter(x => x === 'close')).toHaveLength(1);
    expect(effects.filter(x => x === 'release')).toHaveLength(1);
    expect(effects).toContain('stdin-eof');
    expect(readFileSync(f.received, 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(f.state, 'utf8'))).toMatchObject({clients: [], released: true});
  });
}, 20000);
