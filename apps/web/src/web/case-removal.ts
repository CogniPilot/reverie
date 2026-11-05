/**
 * @fileoverview Guarded removal of one case folder, shared by `DELETE /api/cases/:name` and the
 * admin case delete. A case folder is moved to a trash directory, never deleted, and it is refused
 * while it belongs to a company employee or holds a live session: a case holds unique work, and a
 * wrong call must leave it recoverable.
 */

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { dataPath } from '../config/instance.js';
import { ApiErrorCode } from '../types.js';
import { employeeCaseName } from '../company-names.js';

/** Whether `path` is `dir` itself or lies inside it. */
function isWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Count live sessions whose workingDir sits inside `dir`, whoever owns them. */
export function liveSessionsInside(sessions: Iterable<{ workingDir?: string }>, dir: string): number {
  let count = 0;
  for (const session of sessions) if (isWithin(dir, session.workingDir || '')) count++;
  return count;
}

/** The case folder name of every employee on the company roster. */
export function employeeCaseNames(employees: Iterable<{ name: string }>): Set<string> {
  const names = new Set<string>();
  for (const employee of employees) {
    const caseName = employeeCaseName(employee.name);
    if (caseName) names.add(caseName);
  }
  return names;
}

/** What a removal must not disturb: live sessions and the employees' own case folders. */
export interface CaseRemovalGuards {
  sessions: Iterable<{ workingDir?: string }>;
  employeeCases: ReadonlySet<string>;
}

export type CaseRemovalRefusal =
  | 'not-found'
  | 'not-directory'
  | 'escapes-root'
  | 'employee-case'
  | 'in-use'
  | 'cross-device'
  | 'failed';

export type CaseRemoval =
  | { ok: true; trashPath: string }
  | { ok: false; status: 400 | 404 | 409 | 500; refusal: CaseRemovalRefusal; message: string };

/** The API error code a refused removal reports. */
export function removalErrorCode(removal: Extract<CaseRemoval, { ok: false }>): ApiErrorCode {
  switch (removal.status) {
    case 404:
      return ApiErrorCode.NOT_FOUND;
    case 409:
      return ApiErrorCode.CONFLICT;
    case 400:
      return ApiErrorCode.INVALID_INPUT;
    default:
      return ApiErrorCode.OPERATION_FAILED;
  }
}

/**
 * Move the case folder `caseName` of the cases directory `root` into `trashDir`, under a name that
 * cannot collide. Refuses a symlink or non-directory, a path that escapes `root`, a folder that is
 * or contains an employee's case, and a folder a live session works in. A rename across devices is
 * refused rather than replaced by a recursive delete.
 */
export async function removeCaseFolder(
  root: string,
  caseName: string,
  guards: CaseRemovalGuards,
  trashDir: string = dataPath('case-trash')
): Promise<CaseRemoval> {
  const target = join(root, caseName);
  let stats;
  try {
    stats = await fsp.lstat(target);
  } catch {
    return { ok: false, status: 404, refusal: 'not-found', message: `Case "${caseName}" not found` };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return { ok: false, status: 400, refusal: 'not-directory', message: 'Refusing to delete: not a plain directory' };
  }
  const realRoot = await fsp.realpath(root).catch(() => root);
  const realTarget = await fsp.realpath(target);
  const rel = relative(realRoot, realTarget);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, status: 400, refusal: 'escapes-root', message: 'Case folder escapes the cases directory' };
  }
  for (const employeeCase of guards.employeeCases) {
    if (isWithin(realTarget, join(realRoot, employeeCase))) {
      return {
        ok: false,
        status: 409,
        refusal: 'employee-case',
        message: `Case "${caseName}" holds the case of a company employee; remove the employee first`,
      };
    }
  }
  const sessions = [...guards.sessions];
  const inUse = liveSessionsInside(sessions, target) || liveSessionsInside(sessions, realTarget);
  if (inUse > 0) {
    return {
      ok: false,
      status: 409,
      refusal: 'in-use',
      message: `Case folder is in use by ${inUse} live session(s), close them first`,
    };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashPath = join(trashDir, `${caseName}-${stamp}-${randomUUID().slice(0, 8)}`);
  try {
    await fsp.mkdir(trashDir, { recursive: true });
    await fsp.rename(realTarget, trashPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      return {
        ok: false,
        status: 500,
        refusal: 'cross-device',
        message: 'Case folder is on a different filesystem than the trash; refusing to delete it',
      };
    }
    return {
      ok: false,
      status: 500,
      refusal: 'failed',
      message: `Could not move the case folder to trash: ${(err as Error).message}`,
    };
  }
  return { ok: true, trashPath };
}
