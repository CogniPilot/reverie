import { describe,it,expect } from 'vitest';
import {readFileSync} from 'node:fs';
import {composerBody,composerIsEmpty,promptStillInComposer} from '../src/session-submit-verifier.js';
const f=readFileSync(new URL('./fixtures/codex-0.163-ambiguous-echo.ansi',import.meta.url),'utf8');
const rows=f.split('\n'),e='\x1b';
const body=(s:string)=>rows.map((l,i)=>i===26?`${e}[0;1m›${e}[0m ${s}`:l).join('\n');
describe('Codex echoed-prompt composer: independent acceptance cases',()=>{
 it('never calls ordinary text or opaque chip empty',()=>{for(const s of ['x','owned exact text','[Pasted Content 22 chars]'])expect(composerIsEmpty(body(s),'›')).toBe(false);});
 it('only exact owned text matches and chip needs prior empty evidence',()=>{const owned='owned exact text';expect(promptStillInComposer(body(owned),owned,'›')).toBe(true);for(const s of [owned+'!',owned.slice(1),owned+' suffix','prefix '+owned,'owned  exact text','other text','[Pasted Content 16 chars]'])expect(promptStillInComposer(body(s),owned,'›')).toBeUndefined();expect(promptStillInComposer(f,owned,'›')).toBe(false);});
 it('keeps continuation text nonempty',()=>{const s=rows.map((l,i)=>i===27?'  still a draft':l).join('\n');expect(composerIsEmpty(s,'›')).toBe(false);});
 it('does not erase rapid-blink with unrelated SGR26',()=>{const s=rows.map((l,i)=>i===26?l.replace(`${e}[0;1m`,`${e}[0;1;6;26m`):l).join('\n');expect(composerBody(s,'›')).toBeUndefined();});
 it('does not ignore inherited italic style before lower glyph',()=>{const s=rows.map((l,i)=>i===25?`${e}[3m`:i===26?l.replace(`${e}[0;1m`,`${e}[1m`):l).join('\n');expect(composerBody(s,'›')).toBeUndefined();});
});
