/**
 * @fileoverview The in-process hard floors match the python `floors.violates` they replace. The fixture was produced by
 * the unmodified python reference on synthetic names and texts; nothing here reads a real protected-people list.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROTECTED_PEOPLE_MAX_BYTES,
  protectedPeoplePath,
  readProtectedNames,
  screenMemoryText,
  violates,
} from '../src/memory-floors.js';

interface Reference {
  names: string[];
  texts: Array<{ text: string; floor: string }>;
  files: Array<{ id: string; hex?: string; names?: string[]; error?: string }>;
}
const reference = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'memory-floors-reference.json'), 'utf8')
) as Reference;

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-floors-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parity with the python reference', () => {
  it('gives the same floor for every reference text', () => {
    expect(reference.texts.filter((t) => t.floor).length).toBeGreaterThan(30);
    for (const { text, floor } of reference.texts)
      expect(violates(text, reference.names), JSON.stringify(text)).toBe(floor);
  });

  it('parses every reference protected-people file the same way, refusing where python raised', () => {
    for (const file of reference.files.filter((f) => f.hex !== undefined)) {
      const target = path.join(dir, file.id);
      fs.writeFileSync(target, Buffer.from(file.hex!, 'hex'));
      if (file.error) expect(() => readProtectedNames(target), file.id).toThrow();
      else expect(readProtectedNames(target), file.id).toEqual(file.names);
    }
  });
});

describe('the protected-people list', () => {
  it('is read from the place the bridge read it', () => {
    expect(protectedPeoplePath('/home/agent')).toBe('/home/agent/reverie/companies/default/data/protected-people.txt');
  });

  it('holds no names when it is missing, a directory or a FIFO, and never blocks on a FIFO', () => {
    expect(readProtectedNames(path.join(dir, 'absent'))).toEqual([]);
    expect(readProtectedNames(dir)).toEqual([]);
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(readProtectedNames(fifo)).toEqual([]);
  });

  it('refuses a list over the size bound instead of reading it', () => {
    const big = path.join(dir, 'big');
    fs.writeFileSync(big, Buffer.alloc(PROTECTED_PEOPLE_MAX_BYTES + 1, 0x41));
    expect(() => readProtectedNames(big)).toThrow(/too large/);
  });
});

describe('screening a memory text', () => {
  const list = (home: string, text: string) => {
    const file = protectedPeoplePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  it('passes ordinary text and names the floor a protected name with abuse crosses', () => {
    list(dir, '# synthetic\nRobin Example\n');
    expect(screenMemoryText('Compiler parity passed', dir)).toBe('');
    expect(screenMemoryText('Robin Example lives at the old mill.', dir)).toBe('targeting a real private person');
  });

  it('cannot run on missing or blank text', () => {
    for (const text of [undefined, 3, '', ' \t\n '])
      expect(() => screenMemoryText(text, dir)).toThrow('screen needs text');
  });

  it('keeps the configured output policy inert, as it was on the bridge path', () => {
    const before = process.env.REVERIE_OUTPUT_POLICY;
    process.env.REVERIE_OUTPUT_POLICY = JSON.stringify({ denied_patterns: ['forbidden'] });
    try {
      expect(screenMemoryText('the forbidden plan', dir)).toBe('');
    } finally {
      if (before === undefined) delete process.env.REVERIE_OUTPUT_POLICY;
      else process.env.REVERIE_OUTPUT_POLICY = before;
    }
  });
});
