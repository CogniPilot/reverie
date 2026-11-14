import { expect, it } from 'vitest';
import { containsC0OrDel, containsHandoffControls } from '../src/text-controls.js';

it('keeps the exact C0 and DEL boundaries across every UTF-16 code unit', () => {
  const rejected = new Set([...Array.from({ length: 32 }, (_, code) => code), 127]);
  const whitespace = new Set([9, 10, 13]);
  const mismatch: number[] = [];
  for (let code = 0; code <= 0xffff; code++) {
    const text = 'prefix' + String.fromCharCode(code) + 'suffix';
    if (
      containsC0OrDel(text) !== rejected.has(code) ||
      containsHandoffControls(text) !== (rejected.has(code) && !whitespace.has(code))
    )
      mismatch.push(code);
  }
  expect(mismatch).toEqual([]);
});
it('retains non-ASCII and astral text while rejecting controls anywhere in a handoff', () => {
  for (const text of ['safe\tline\nnext\rline', '\u0080\u0085\u009f', 'emoji😀', '\ud800'])
    expect(containsHandoffControls(text)).toBe(false);
  for (const code of [0, 8, 11, 12, 14, 31, 127])
    expect(containsHandoffControls('safe' + String.fromCharCode(code) + 'tail')).toBe(true);
});
