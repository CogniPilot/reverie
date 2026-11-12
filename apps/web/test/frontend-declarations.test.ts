import {expect, it} from 'vitest';
import vm from 'node:vm';
import {frontendCallStatements, frontendDeclarations, frontendPrototypeMethods} from './helpers/frontend-declarations.js';

it('extracts complete multiline declarations and requested bindings without running unrelated startup', () => {
  const source = `const unrelated = fail(), esc = (value) =>\n String(value).replace(/</g, '&lt;');\nfunction render(value) { return esc(value); }\nfail();`;
  const selected = frontendDeclarations(source, ['esc', 'render']);
  expect(vm.runInNewContext(`${selected}; render('<tag>')`)).toBe('&lt;tag>');
  expect(selected).not.toContain('unrelated');
  expect(selected).not.toContain('fail');
});
it('refuses absent, nested-only, duplicate and syntactically broken declaration sources', () => {
  for (const source of ['', 'function outer(){const wanted=1;}', 'var wanted=1; var wanted=2;', 'const wanted = {',
    'const wanted: number=1;', 'export const wanted = {'])
    expect(() => frontendDeclarations(source, ['wanted'])).toThrow();
});
it('counts only callable instance declarations on the actual target prototype', () => {
  const source = `class App { _first(){} static _static(){} field=1; _arrow=()=>{} }
    class Other { _first(){} }
    Object.assign(App.prototype, {async _second(){}, '_third': function(){}, value: 1});
    App.prototype._fourth = () => {};
    function _first(){}; _first(); function nested(){class App{_unrelated(){}}}`;
  expect(frontendPrototypeMethods(source, 'App')).toEqual(['_first', '_arrow', '_second', '_third', '_fourth']);
});
it('selects real top-level startup calls without matching nested calls or string/comment lookalikes', () => {
  const source = `// setInterval(fake,1);\nconst example='setInterval(fake,2)';\nfunction nested(){setInterval(fake,3);}\nsetInterval(() => run(),\n 10e3);`;
  const calls = frontendCallStatements(source, 'setInterval');
  expect(calls).toHaveLength(1);
  const seen: number[] = [];
  vm.runInNewContext(calls[0], {setInterval: (_callback: unknown, delay: number) => seen.push(delay)});
  expect(seen).toEqual([10000]);
});
it('retains duplicate actual prototype definitions so the caller detects shadowing', () => {
  expect(frontendPrototypeMethods(`class App{_same(){}} Object.assign(App.prototype,{_same(){}});`, 'App'))
    .toEqual(['_same', '_same']);
});
it('distinguishes proven original-handler delegation from blind or conditional shadowing', () => {
  const prefix = `class App{_same(data){seen.push(['base',data]);return data;}} const previous=App.prototype._same;`;
  const wrapper = `App.prototype._same=function(data){seen.push(['extension',data]);return previous.call(this,data);};`;
  expect(frontendPrototypeMethods(prefix + wrapper, 'App')).toEqual(['_same']);
  const seen: unknown[] = [];
  expect(vm.runInNewContext(`${prefix}${wrapper}new App()._same(7);`, {seen})).toBe(7);
  expect(seen).toEqual([['extension',7],['base',7]]);
  for (const body of ['return 0;', 'if(data)return 0;return previous.call(this,data);',
    'return previous.call(other,data);', 'return previous.call(this,other);',
    'throw new Error("stop");return previous.call(this,data);',
    'while(true){}return previous.call(this,data);'])
    expect(frontendPrototypeMethods(`${prefix}App.prototype._same=function(data){${body}};`, 'App'))
      .toEqual(['_same','_same']);
});
it('refuses late captures and shadowed original references instead of qualifying a recursive or unrelated wrapper', () => {
  const base = 'class App{_same(){}}';
  for (const extension of [
    'App.prototype._same=function(data){return previous.call(this,data);};const previous=App.prototype._same;',
    'const previous=App.prototype._same;App.prototype._same=function(previous){return previous.call(this,previous);};',
    'const previous=App.prototype._same;App.prototype._same=function(data){const previous=other;return previous.call(this,data);};',
    'const previous=App.prototype._same;App.prototype._same=function(...data){return previous.call(this,data);};',
  ]) expect(frontendPrototypeMethods(base + extension, 'App')).toEqual(['_same','_same']);
});
it('distinguishes immediately invoked setup from unexecuted functions', () => {
  expect(frontendPrototypeMethods('function unused(){Object.assign(App.prototype,{_wanted(){}})}', 'App')).toEqual([]);
  expect(frontendPrototypeMethods('(function(){Object.assign(App.prototype,{_wanted(){}})})();', 'App')).toEqual(['_wanted']);
  expect(frontendPrototypeMethods('(()=>Object.assign(App.prototype,{_wanted(){}}))();', 'App')).toEqual(['_wanted']);
});
it('refuses unresolved prototype mixins and spreads instead of inventing successful static coverage', () => {
  for (const source of ['Object.assign(App.prototype, unknown);', 'Object.assign(App.prototype, {...unknown});'])
    expect(() => frontendPrototypeMethods(source, 'App')).toThrow('Unresolved');
});
