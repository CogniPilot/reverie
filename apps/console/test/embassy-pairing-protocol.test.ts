import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const source=readFileSync(new URL('../src/web/public/chat-app.js',import.meta.url),'utf8');
const mod={exports:{}};new Function('module',source)(mod);const p:any=mod.exports;
const origin='https://relay.example.test:8443',id='420a20cc-1288-4faa-8f45-b6f908cf4a20';
const invite=`embassy-v2|${origin}|${id}|${'A'.repeat(43)}`;
const request=`embassy-pair-v1|${origin}|${id}|3BCD-5FGH`;
it('keeps invitation and public approval locator protocols distinct and inert',()=>{
 expect(p.caPairInvite(invite)).toEqual({qr:invite,origin,roomId:id});
 expect(p.caPairRequest(request,origin)).toEqual({qr:request,origin,requestId:id,code:'3BCD-5FGH'});
 expect(()=>p.caPairInvite(request)).toThrow();expect(()=>p.caPairRequest(invite,origin)).toThrow();
 expect(()=>p.caEmbassyInvite(invite)).toThrow();
});
for(const host of ['http://relay.example.test','https://relay.example.test/','https://user@relay.example.test','https://relay.example.test/?secret=x','https://relay.example.test/#x','https://127.0.0.1','https://localhost','https://relay.example.test:8443.evil.test','javascript:alert(1)']){
 it(`rejects noncanonical or unsafe origin ${host}`,()=>expect(()=>p.caPairInvite(invite.replace(origin,host))).toThrow());
}
it('binds confirmation to the current authenticated host origin',()=>expect(()=>p.caPairRequest(request,'https://different.example.test')).toThrow());
it('never accepts extra secret/session fields or malformed ids',()=>{
 for(const value of [invite+'|claimSecret',request+'|sessionToken',invite.replace(id,'../other-room'),request.replace(id,'not-a-request'),invite.replace('A'.repeat(43),'short'),'embassy-v2|'+origin+'|'+id+'|'+('A'.repeat(1000))])expect(()=>value.startsWith('embassy-pair')?p.caPairRequest(value,origin):p.caPairInvite(value)).toThrow();
});
it('code fallback has the same bounded alphabet and normalized code',()=>{
 expect(p.caPairCode('3bcd5fgh')).toBe('3BCD-5FGH');expect(p.caPairCode('3BCD-5FGH')).toBe('3BCD-5FGH');
 for(const value of ['IIII-IIII','OOOO-OOOO','1234--5678','1234-56789','1234 5678','<script>','A'.repeat(1000)])expect(()=>p.caPairCode(value)).toThrow();
});
