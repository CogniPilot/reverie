/** Native-authentication is supplied by the broker; these are producer-boundary controls. */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { CompanyStateSchema, EmployeeSchema } from '../src/company-types.js';
import { CompanyWake } from '../src/company-wake.js';
import { HostResumeHandler, HostWorkerResumeStream, resumeSocketMount, savedResumeDigest } from '../src/host-worker-resume.js';
import type { SessionState } from '../src/types.js';

const EID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const OP = '44444444-4444-4444-8444-444444444444';
const NONCE = '55555555-5555-4555-8555-555555555555';

function fixture() {
  const employee = EmployeeSchema.parse({ id: EID, sessionId: SID, sessionGeneration: 2,
    name: 'Fixture', owner: 'fixture-owner', icon: 'x', position: 'Expert', expertise: ['systems'],
    createdAt: 1, desiredRunning: true, runtimeRecipe: { mode: 'claude', workingDir: '/workspace' } });
  const state = CompanyStateSchema.parse({ version: 1, employees: [employee], settings: [], cycles: [], memories: [] });
  const row = state.employees[0];
  const saved = { id: SID, name: 'Fixture', owner: row.owner, mode: 'claude', workingDir: '/workspace',
    status: 'idle', pid: null, claudeSessionChain: [THREAD] } as SessionState;
  const live = new Set<string>();
  const launch = vi.fn(async (_entry: unknown, allowed: () => boolean) => {
    if (!allowed()) return false;
    live.add(SID); return true;
  });
  const claim = vi.fn(async () => true);
  const normal = new CompanyWake({ company: () => state, saved: id => id === SID ? saved : undefined,
    live: id => live.has(id), closing: () => false, noteRunning: vi.fn(async () => {}),
    begin: () => ({ current: () => true, finish: () => {} }), claim, wake: launch });
  const wake = vi.fn((id: string, current: () => boolean) => normal.wakeOne(id, { stillCurrent: current }));
  const handler = new HostResumeHandler({ company: () => state, saved: id => id === SID ? saved : undefined,
    live: id => live.has(id), wake });
  const request = () => ({ kind: 'wake', nonce: NONCE, expiresAtEpochMs: Date.now() + 60_000,
    operationId: OP, employee: handler.snapshot()[0] });
  return { row, saved, state, handler, wake, claim, launch, live, request };
}

describe('native maintenance resume uses the normal employee producer', () => {
  it('resumes the saved native conversation without changing its recipe or owner choices', async () => {
    const f = fixture(); const before = structuredClone(f.saved); const request = f.request();
    expect(await f.handler.dispatch(request)).toEqual({ employeeId: EID, sessionId: SID, generation: 2, state: 'awakened' });
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.launch.mock.calls[0][0]).toMatchObject({ sessionId: SID, mode: 'claude' });
    expect(f.saved).toEqual(before); expect(f.row.desiredRunning).toBe(true);
    await expect(f.handler.dispatch(request)).rejects.toThrow('not replayable');
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it.each(['stopped', 'vacation', 'generation', 'session', 'conversation', 'account', 'advisor'] as const)(
    'refuses changed %s before the normal producer is called', async change => {
      const f = fixture(); const request = f.request();
      if (change === 'stopped') f.row.desiredRunning = false;
      if (change === 'vacation') f.row.onVacation = true;
      if (change === 'generation') f.row.sessionGeneration++;
      if (change === 'session') f.row.sessionId = '66666666-6666-4666-8666-666666666666';
      if (change === 'conversation') f.saved.claudeSessionChain = ['77777777-7777-4777-8777-777777777777'];
      if (change === 'account') f.saved.subscriptionProfile = { id: 'different-account', label: 'Different', provider: 'anthropic' };
      if (change === 'advisor') f.saved.advisorModel = 'changed-advisor-model';
      await expect(f.handler.dispatch(request)).rejects.toThrow();
      expect(f.wake).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    });

  it('does not override a deliberately stopped saved session', async () => {
    const f = fixture(); f.saved.status = 'stopped';
    await expect(f.handler.dispatch(f.request())).rejects.toThrow();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.saved.status).toBe('stopped');
  });

  it('rechecks stream lifetime after the normal claim awaits', async () => {
    const f = fixture(); let current = true; let release!: () => void; let entered!: () => void;
    const claiming = new Promise<void>(resolve => { entered = resolve; });
    f.claim.mockImplementation(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return true; });
    const result = f.handler.dispatch(f.request(), () => current);
    await claiming; current = false; release();
    await expect(result).rejects.toThrow(); expect(f.launch).not.toHaveBeenCalled();
  });

  it('lets an owner stop received during the claim prevent actual launch', async () => {
    const f = fixture();
    f.claim.mockImplementation(async () => { f.row.desiredRunning = false; return true; });
    await expect(f.handler.dispatch(f.request())).rejects.toThrow();
    expect(f.launch).not.toHaveBeenCalled(); expect(f.row.desiredRunning).toBe(false);
  });

  it('refuses commands, owner assertions and invalid finite windows', async () => {
    for (const extra of [{ command: 'never-executed' }, { owner: true }, { expiresAtEpochMs: Date.now() - 1 },
      { expiresAtEpochMs: Date.now() + 180_000 }]) {
      const f = fixture(); await expect(f.handler.dispatch({ ...f.request(), ...extra })).rejects.toThrow();
      expect(f.wake).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    }
  });

  it('keeps transcripts, environment and credential values out of the saved recipe fingerprint', () => {
    const f = fixture(); const record = f.saved as unknown as Record<string, unknown>;
    record.codexConfig = {};
    const before = savedResumeDigest(f.saved);
    record.terminalBuffer = 'private-transcript-value'; record.__envOverrides = { TOKEN: 'private-credential-value' };
    record.codexConfig = { apiKey: 'private-credential-value' };
    expect(savedResumeDigest(f.saved)).toBe(before);
    expect(JSON.stringify(f.handler.snapshot())).not.toContain('private-');
  });

  it('rejects an expired or disconnected describe request', async () => {
    const f = fixture(); const cohort = f.handler.snapshot().map(({ savedDigest: _saved, ...row }) => row);
    const describe = { kind: 'describe', nonce: NONCE, expiresAtEpochMs: Date.now() - 1, cohort };
    await expect(f.handler.dispatch(describe)).rejects.toThrow();
    await expect(f.handler.dispatch({ ...describe, expiresAtEpochMs: Date.now() + 1000 }, () => false)).rejects.toThrow();
    expect(f.wake).not.toHaveBeenCalled();
  });
});

describe('host resume endpoint custody',()=>{
  const mount=(point:string,options='ro')=>`40 20 0:20 / ${point} ${options},nosuid - tmpfs tmpfs rw\n`;
  it('requires one exact read-only kernel mount and refuses masked or duplicate mounts',()=>{
    expect(resumeSocketMount(mount('/run/workers'),'/run/workers')).toContain('ro');
    for(const value of [mount('/run/workers','rw'),mount('/run'),mount('/run/workers')+mount('/run/workers'),
      'malformed',mount('/run/workers','ro,rw')])expect(()=>resumeSocketMount(value,'/run/workers')).toThrow();
  });
  it('does not connect to an actual guest-created writable Unix endpoint',async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hrs-'));fs.chmodSync(directory,0o700);
    const socketPath=path.join(directory,'s'),accepted=vi.fn(),server=net.createServer(accepted);
    await new Promise<void>(resolve=>server.listen(socketPath,resolve));fs.chmodSync(socketPath,0o600);
    const stream=new HostWorkerResumeStream(socketPath,fixture().handler);
    try{stream.start();await new Promise(resolve=>setTimeout(resolve,20));expect(accepted).not.toHaveBeenCalled();}
    finally{stream.close();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true});}
  });
  it('uses real framed IO with controlled mount facts and refuses a replaced socket before wake',async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hrs-'));fs.chmodSync(directory,0o700);
    const socketPath=path.join(directory,'s'),f=fixture();let peer:net.Socket|undefined;
    let gotReply!:(value:unknown)=>void;const reply=new Promise(resolve=>{gotReply=resolve;});
    const server=net.createServer(socket=>{peer=socket;let data=Buffer.alloc(0),registered=false;
      socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);
        if(!registered){if(data.length<5||data.length<5+data.readUInt32BE(1))return;
          expect(data.subarray(0,1).toString()).toBe('Y');
          const n=data.readUInt32BE(1);expect(JSON.parse(data.subarray(5,5+n).toString())).toEqual({version:1,purpose:'host-worker-resume-v1',kind:'register'});
          data=data.subarray(5+n);registered=true;socket.write('HOST_RESUME_READY\n');
          const cohort=f.handler.snapshot().map(({savedDigest:_saved,...row})=>row);
          const raw=Buffer.from(JSON.stringify({kind:'describe',nonce:NONCE,expiresAtEpochMs:Date.now()+1000,cohort}));
          const head=Buffer.alloc(4);head.writeUInt32BE(raw.length);socket.write(Buffer.concat([head,raw]));}
        if(data.length>=4&&data.length>=data.readUInt32BE(0)+4){const n=data.readUInt32BE(0);
          const value=JSON.parse(data.subarray(4,4+n).toString());data=data.subarray(4+n);
          if(value.kind==='result')gotReply(value);}
      });});
    await new Promise<void>(resolve=>server.listen(socketPath,resolve));fs.chmodSync(socketPath,0o600);
    // Only kernel mount metadata is controlled. The socket, inode replacement,
    // framing, handler and canonical normal-wake producer are real owned fixtures.
    const originalOpen=fs.openSync,originalRead=fs.readSync,originalClose=fs.closeSync;
    const readers=new Map<number,number>();
    vi.spyOn(fs,'openSync').mockImplementation(((name:fs.PathLike,...args:unknown[])=>{
      if(name==='/proc/self/mountinfo'){const fd=originalOpen('/dev/null','r');readers.set(fd,0);return fd;}
      return (originalOpen as (...values:unknown[])=>number)(name,...args);
    }) as typeof fs.openSync);
    vi.spyOn(fs,'readSync').mockImplementation(((fd:number,buffer:Buffer,offset:number,length:number,position:unknown)=>{
      if(readers.has(fd)){const raw=Buffer.from(mount(directory)),start=readers.get(fd)!;
        const count=Math.min(length,raw.length-start);raw.copy(buffer,offset,start,start+count);readers.set(fd,start+count);return count;}
      return (originalRead as (...values:unknown[])=>number)(fd,buffer,offset,length,position);
    }) as typeof fs.readSync);
    vi.spyOn(fs,'closeSync').mockImplementation(fd=>{readers.delete(fd);originalClose(fd);});
    const stream=new HostWorkerResumeStream(socketPath,f.handler);
    try{stream.start();expect(await Promise.race([reply,new Promise((_,reject)=>setTimeout(()=>reject(new Error('reply deadline')),2000))]))
        .toMatchObject({kind:'result',nonce:NONCE,value:{snapshotDigest:expect.any(String)}});
      fs.renameSync(socketPath,socketPath+'.old');fs.writeFileSync(socketPath,'foreign');
      const raw=Buffer.from(JSON.stringify(f.request())),head=Buffer.alloc(4);head.writeUInt32BE(raw.length);
      peer!.write(Buffer.concat([head,raw]));await new Promise(resolve=>setTimeout(resolve,20));
      expect(f.wake).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled();
    }finally{stream.close();peer?.destroy();vi.restoreAllMocks();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true});}
  });
});
