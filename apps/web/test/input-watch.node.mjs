import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputWatch } from '../src/input-watch.ts';
import { ChatroomService } from '../dist/chatroom-service.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture() {
  const state = { at: Date.parse('2026-10-18T22:00:00Z'), posts: [], failures: [],
    bot: { id: 'input-watch', name: 'Input Watch', icon: '🤖', rooms: ['r'], maxPerHour: 6 },
    employee: { id: 'employee-123', sessionId: 's' },
    rooms: { r: { id: 'r', members: [{ sessionId: 's' }], messages: [] } },
    throwPost: false,
  };
  const watch = createInputWatch({ bot: () => state.bot, employee: () => state.employee,
    timeZone: () => 'America/New_York',
    room: id => state.rooms[id], now: () => state.at,
    post: (bot, roomId, text, recent) => {
      if (state.throwPost) throw Error('private pane content');
      state.posts.push({ bot, roomId, text, recent });
      const message = { id: `message-${state.posts.length}`, at: state.at, from: { kind: 'bot', botId: bot.id } };
      state.rooms[roomId].messages.push(message);
      return message;
    }, failed: text => state.failures.push(text),
  });
  return { state, watch, event: (id = 'event-1', kind = 'permission') => watch.pending({ id, sessionId: 's', kind,
    context: 'SECRET RAW PANE OUTPUT @everyone', toolSummary: 'SECRET COMMAND' }) };
}
test('permission event posts once with fixed safe text and 12-hour time', () => {
  const x = fixture(); x.event(); x.event();
  assert.equal(x.state.posts.length, 1);
  assert.match(x.state.posts[0].text, /6:00:00 PM EDT/);
  assert.match(x.state.posts[0].text, /prompt reported for employee employee/);
  assert.doesNotMatch(x.state.posts[0].text, /SECRET|@everyone|COMMAND/);
});
test('idle and resolving events produce no alert; question does', () => {
  const x = fixture(); x.event('a', 'idle'); x.event('b', 'resolved');
  assert.equal(x.state.posts.length, 0); x.event('c', 'question'); assert.equal(x.state.posts.length, 1);
});
test('owner absence or removing room allowlist disables notification', () => {
  const x = fixture(); x.state.bot = undefined; x.event(); assert.equal(x.state.posts.length, 0);
  const y = fixture(); y.state.bot.rooms = []; y.event(); assert.equal(y.state.posts.length, 0);
});
test('only live employee binding and membership can expose an alert', () => {
  const x = fixture(); x.state.employee = undefined; x.event(); assert.equal(x.state.posts.length, 0);
  const y = fixture(); y.state.employee.sessionId = 'other'; y.event(); assert.equal(y.state.posts.length, 0);
  const z = fixture(); z.state.rooms.r.members = []; z.event(); assert.equal(z.state.posts.length, 0);
});
test('DM and archived rooms are excluded', () => {
  const x = fixture(); x.state.rooms.r.kind = 'dm'; x.event(); assert.equal(x.state.posts.length, 0);
  const y = fixture(); y.state.rooms.r.archivedAt = 1; y.event(); assert.equal(y.state.posts.length, 0);
});
test('hourly cap comes from stored room messages and is shared across rooms', () => {
  const x = fixture(); x.state.bot.maxPerHour = 1;
  x.state.bot.rooms.push('r2'); x.state.rooms.r2 = { id: 'r2', members: [{sessionId:'s'}], messages:[] };
  x.event(); assert.equal(x.state.posts.length, 1); assert.equal(x.state.failures.length, 1);
  const other = createInputWatch({ bot:()=>x.state.bot, employee:()=>x.state.employee, room:id=>x.state.rooms[id],
    now:()=>x.state.at, post:()=>assert.fail('stored cap lost'), failed:()=>{} });
  other.pending({id:'new-event',sessionId:'s',kind:'permission'});
});
test('uncertain failed post is not blindly repeated and failure alerts are bounded', () => {
  const x = fixture(); x.state.throwPost = true; x.event(); x.event(); x.event('e2');
  assert.equal(x.state.posts.length, 0); assert.equal(x.state.failures.length, 1);
  assert.doesNotMatch(x.state.failures[0], /private pane/);
  x.state.at += 31 * 60_000; x.event('e3'); assert.equal(x.state.failures.length, 2);
  assert.match(x.state.failures[1], /2 alert/);
});
test('metadata lookup and fallback failures cannot break the approval callback', () => {
  const watch = createInputWatch({bot:()=>{throw Error('lookup')},employee:()=>undefined,room:()=>undefined,
    post:()=>assert.fail(), failed:()=>{throw Error('alert transport')} });
  assert.doesNotThrow(()=>watch.pending({id:'1',sessionId:'s',kind:'permission'}));
});

test('real chat service stores the named alert with zero pane delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'input-watch-'));
  let paneWrites = 0;
  const service = new ChatroomService({ file: dir + '/chatrooms.json',
    getSession: () => ({ id:'s', name:'Fixture', mode:'claude', pid:123,
      write:()=>{paneWrites++;return true}, writeViaMux:()=>{paneWrites++;return true} }),
    broadcast:()=>{},
  });
  await service.init();
  try {
    const room = service.createRoom('Synthetic input notification', undefined);
    room.members.push({sessionId:'s',role:'member',joinedAt:Date.now()});
    const bot = {id:'input-watch',name:'Input Watch',icon:'🤖',rooms:[room.id],maxPerHour:6};
    const watch = createInputWatch({ bot:()=>bot, employee:()=>({id:'employee-123',sessionId:'s'}),
      room:id=>service.room(id), failed:()=>assert.fail('unexpected failure'),
      post:(b,id,text,recent)=>{
        service.checkBotPost(b,id,recent);
        return service.post(id,{kind:'bot',botId:b.id,name:b.name,icon:b.icon},text,'all',{deliver:false});
      },
    });
    watch.pending({id:'real-service-event',sessionId:'s',kind:'permission'});
    assert.equal(room.messages.length,1);
    assert.equal(room.messages[0].from.kind,'bot');
    assert.equal(room.messages[0].from.name,'Input Watch');
    assert.equal(room.messages[0].from.icon,'🤖');
    assert.equal(paneWrites,0);
    assert.equal(service.delivery.pendingFor('s'),0);
  } finally { await service.stop(); }
});

test('real archive retention and restart cannot reopen an hourly quota slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'input-watch-archive-'));
  let at = Date.parse('2026-10-18T22:00:00Z');
  const failures = [];
  const service = new ChatroomService({file:dir+'/rooms.json',now:()=>at,
    getSession:()=>undefined,broadcast:()=>{}});
  await service.init();
  try {
    const room = service.createRoom('Archive quota fixture',undefined);
    room.members.push({sessionId:'s',role:'member',joinedAt:at});
    const bot = {id:'input-watch',name:'Input Watch',icon:'🤖',rooms:[room.id],maxPerHour:1};
    const makeWatch = () => createInputWatch({bot:()=>bot,employee:()=>({id:'employee-123',sessionId:'s'}),
      room:id=>service.room(id),now:()=>at,ledgerFile:dir+'/ledger.json',failed:text=>failures.push(text),
      post:(b,id,text,recent)=>{
        service.checkBotPost(b,id,recent);
        return service.post(id,{kind:'bot',botId:b.id,name:b.name,icon:b.icon},text,'all',{deliver:false});
      }});
    const first = makeWatch();
    first.pending({id:'first',sessionId:'s',kind:'permission'});
    assert.equal(room.messages.filter(m=>m.from.kind==='bot').length,1);
    for(let i=0;i<1000;i++) service.post(room.id,{kind:'system',name:'fixture'},'ordinary '+i,'all',{deliver:false});
    await service.save(); // Real ChatroomService archiveOverflow + dropArchived.
    assert.equal(room.messages.filter(m=>m.from.kind==='bot').length,0);
    first.pending({id:'after-archive',sessionId:'s',kind:'permission'});
    assert.equal(room.messages.filter(m=>m.from.kind==='bot').length,0);
    assert.equal(failures.length,1);
    const restarted = makeWatch();
    restarted.pending({id:'after-restart',sessionId:'s',kind:'permission'});
    assert.equal(room.messages.filter(m=>m.from.kind==='bot').length,0);
    assert.equal(failures.length,2);
    const ledger = JSON.parse(readFileSync(dir+'/ledger.json','utf8'));
    assert.equal(ledger.entries.length,1);
    at += 3_600_001;
    restarted.pending({id:'after-expiry',sessionId:'s',kind:'permission'});
    assert.equal(room.messages.filter(m=>m.from.kind==='bot').length,1);
  } finally {await service.stop();}
});

test('failed post reservations survive restart and expire after one hour', () => {
  const dir=mkdtempSync(join(tmpdir(),'input-watch-failure-'));
  const x=fixture();x.state.bot.maxPerHour=1;
  let posts=0;
  const deps={bot:()=>x.state.bot,employee:()=>x.state.employee,room:id=>x.state.rooms[id],
    now:()=>x.state.at,ledgerFile:dir+'/ledger.json',failed:()=>{},
    post:()=>{posts++;throw Error('uncertain stored result')}};
  createInputWatch(deps).pending({id:'a',sessionId:'s',kind:'permission'});
  assert.equal(posts,1);
  createInputWatch(deps).pending({id:'b',sessionId:'s',kind:'permission'});
  assert.equal(posts,1);
  x.state.at+=3_600_001;
  createInputWatch(deps).pending({id:'c',sessionId:'s',kind:'permission'});
  assert.equal(posts,2);
});

test('invalid or unwritable ledger refuses posting and reports a bounded failure', () => {
  const dir=mkdtempSync(join(tmpdir(),'input-watch-invalid-'));
  const x=fixture();let posted=0;const failures=[];
  writeFileSync(dir+'/bad.json','invalid json');
  for (const ledgerFile of [dir+'/bad.json',dir+'/missing-parent/ledger.json']) {
    const watch=createInputWatch({bot:()=>x.state.bot,employee:()=>x.state.employee,room:id=>x.state.rooms[id],
      now:()=>x.state.at,ledgerFile,failed:text=>failures.push(text),
      post:()=>{posted++;return{id:'unexpected',at:x.state.at}}});
    watch.pending({id:'a',sessionId:'s',kind:'permission'});
    watch.pending({id:'b',sessionId:'s',kind:'permission'});
  }
  assert.equal(posted,0);assert.equal(failures.length,2);
});
