/**
 * @fileoverview Guarded case-folder removal shared by the user and admin case deletes:
 * employee cases and folders with live sessions are refused, and a removed folder is moved
 * to the trash intact rather than deleted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CASE_FOLDER_NAME,
  employeeCaseNames,
  holdsEmployeeCase,
  liveSessionsInside,
  removalErrorCode,
  removeCaseFolder,
} from '../src/web/case-removal.js';
import { ApiErrorCode } from '../src/types.js';

let base: string;
let root: string;
let trash: string;

const noGuards = { sessions: [], employeeCases: new Set<string>() };

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'case-removal-'));
  root = path.join(base, 'cases');
  trash = path.join(base, 'trash');
  await fs.mkdir(root);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function makeCase(name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
  await fs.writeFile(path.join(dir, 'notes', 'work.md'), 'unique work');
  return dir;
}

describe('removeCaseFolder', () => {
  it('moves the folder into the trash with its contents intact', async () => {
    const dir = await makeCase('proj');
    const removal = await removeCaseFolder(root, 'proj', noGuards, trash);
    expect(removal.ok).toBe(true);
    if (!removal.ok) return;
    expect(path.dirname(removal.trashPath)).toBe(trash);
    expect(path.basename(removal.trashPath).startsWith('proj-')).toBe(true);
    await expect(fs.stat(dir)).rejects.toThrow();
    await expect(fs.readFile(path.join(removal.trashPath, 'notes', 'work.md'), 'utf8')).resolves.toBe('unique work');
  });

  it('gives two removals of the same name distinct trash entries', async () => {
    await makeCase('proj');
    const first = await removeCaseFolder(root, 'proj', noGuards, trash);
    await makeCase('proj');
    const second = await removeCaseFolder(root, 'proj', noGuards, trash);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.trashPath).not.toBe(second.trashPath);
    expect((await fs.readdir(trash)).length).toBe(2);
  });

  it('refuses an employee case with no session open', async () => {
    const dir = await makeCase('expert-robin');
    const removal = await removeCaseFolder(
      root,
      'expert-robin',
      { sessions: [], employeeCases: employeeCaseNames([{ name: 'Robin' }]) },
      trash
    );
    expect(removal).toMatchObject({ ok: false, status: 409, refusal: 'employee-case' });
    await expect(fs.stat(dir)).resolves.toBeTruthy();
    await expect(fs.stat(trash)).rejects.toThrow();
  });

  it('refuses a folder that contains an employee case', async () => {
    await fs.mkdir(path.join(root, 'group', 'expert-robin'), { recursive: true });
    const removal = await removeCaseFolder(
      root,
      'group',
      { sessions: [], employeeCases: new Set(['group/expert-robin']) },
      trash
    );
    expect(removal).toMatchObject({ ok: false, status: 409, refusal: 'employee-case' });
  });

  it('refuses while a live session works inside the folder', async () => {
    const dir = await makeCase('busy');
    const removal = await removeCaseFolder(
      root,
      'busy',
      { sessions: [{ workingDir: path.join(dir, 'notes') }], employeeCases: new Set() },
      trash
    );
    expect(removal).toMatchObject({ ok: false, status: 409, refusal: 'in-use' });
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it('does not count a session in a sibling folder with a shared prefix', async () => {
    await makeCase('proj');
    await makeCase('proj-two');
    const removal = await removeCaseFolder(
      root,
      'proj',
      { sessions: [{ workingDir: path.join(root, 'proj-two') }], employeeCases: new Set() },
      trash
    );
    expect(removal.ok).toBe(true);
  });

  it('refuses a symlink and leaves its target untouched', async () => {
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'link'));
    const removal = await removeCaseFolder(root, 'link', noGuards, trash);
    expect(removal).toMatchObject({ ok: false, status: 400, refusal: 'not-directory' });
    await expect(fs.stat(outside)).resolves.toBeTruthy();
    await expect(fs.lstat(path.join(root, 'link'))).resolves.toBeTruthy();
  });

  it('refuses a plain file', async () => {
    await fs.writeFile(path.join(root, 'file'), 'x');
    const removal = await removeCaseFolder(root, 'file', noGuards, trash);
    expect(removal).toMatchObject({ ok: false, status: 400, refusal: 'not-directory' });
  });

  it('refuses the cases directory itself and its parent', async () => {
    for (const name of ['.', '..', '']) {
      const removal = await removeCaseFolder(root, name, noGuards, trash);
      expect(removal).toMatchObject({ ok: false, status: 400, refusal: 'invalid-name' });
    }
    await expect(fs.stat(root)).resolves.toBeTruthy();
  });

  it('refuses a nested name inside an employee case, even when its trash parent exists', async () => {
    await makeCase('expert-robin/work');
    await fs.mkdir(path.join(trash, 'expert-robin'), { recursive: true });
    const guards = { sessions: [], employeeCases: employeeCaseNames([{ name: 'Robin' }]) };
    for (const name of ['expert-robin/work', 'expert-robin\\work', 'other/../expert-robin']) {
      const removal = await removeCaseFolder(root, name, guards, trash);
      expect(removal).toMatchObject({ ok: false, status: 400, refusal: 'invalid-name' });
    }
    const kept = path.join(root, 'expert-robin', 'work', 'notes', 'work.md');
    await expect(fs.readFile(kept, 'utf8')).resolves.toBe('unique work');
    expect(await fs.readdir(path.join(trash, 'expert-robin'))).toEqual([]);
  });

  it('reports a missing folder as not found', async () => {
    const removal = await removeCaseFolder(root, 'ghost', noGuards, trash);
    expect(removal).toMatchObject({ ok: false, status: 404, refusal: 'not-found' });
  });

  it('reports a failed move and keeps the folder', async () => {
    const dir = await makeCase('proj');
    await fs.writeFile(trash, 'not a directory');
    const removal = await removeCaseFolder(root, 'proj', noGuards, trash);
    expect(removal).toMatchObject({ ok: false, status: 500, refusal: 'failed' });
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });
});

describe('case removal helpers', () => {
  it('finds an employee case on either side of the target', () => {
    const employees = new Set(['expert-robin']);
    expect(holdsEmployeeCase('/c', '/c/expert-robin', employees)).toBe(true);
    expect(holdsEmployeeCase('/c', '/c', employees)).toBe(true);
    expect(holdsEmployeeCase('/c', '/c/expert-robin/work', employees)).toBe(true);
    expect(holdsEmployeeCase('/c', '/c/expert-robin-two', employees)).toBe(false);
    expect(holdsEmployeeCase('/c', '/c/other', employees)).toBe(false);
  });

  it('accepts only single-segment case names', () => {
    for (const name of ['proj', 'proj-1', 'a.b', 'expert-robin']) expect(CASE_FOLDER_NAME.test(name)).toBe(true);
    for (const name of ['', '.', '..', '.claude', 'a/b', 'a\\b', 'x'.repeat(129)]) {
      expect(CASE_FOLDER_NAME.test(name)).toBe(false);
    }
  });

  it('counts sessions inside a folder only', () => {
    const sessions = [{ workingDir: '/c/a' }, { workingDir: '/c/a/sub' }, { workingDir: '/c/ab' }, {}];
    expect(liveSessionsInside(sessions, '/c/a')).toBe(2);
  });

  it('maps refusals to API error codes', () => {
    const refusal = (status: 400 | 404 | 409 | 500) =>
      removalErrorCode({ ok: false, status, refusal: 'failed', message: '' });
    expect(refusal(404)).toBe(ApiErrorCode.NOT_FOUND);
    expect(refusal(409)).toBe(ApiErrorCode.CONFLICT);
    expect(refusal(400)).toBe(ApiErrorCode.INVALID_INPUT);
    expect(refusal(500)).toBe(ApiErrorCode.OPERATION_FAILED);
  });
});
