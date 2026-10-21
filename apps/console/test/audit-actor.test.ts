/**
 * @fileoverview The employee replacement audit names who asked, not the lineage parent.
 *
 * `resolveParentSessionId` reads a body `parentSessionId` before the caller's
 * `X-Codeman-Parent-Session` header, because lineage is a UI hint any caller may set. The
 * audit actor of a spawn that replaces an employee comes from the header alone
 * (`auditActor`), so an owner request with a body parent stays 'owner' and an agent is never
 * logged as the body parent it named.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditActor, resolveParentSessionId } from '../src/web/route-helpers.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';

const caller = '00000009-000a-4000-8000-00000000000b';
const parent = '0000000c-0010-4000-8000-000000000015';
const ctx = { sessions: new Map([caller, parent].map((id) => [id, { id, owner: undefined }])) } as never;
const request = (headers: Record<string, string>, body?: object) => ({ headers, body }) as never;

/** The third argument of both route `completeSpawn` calls (create and quick-start), as source. */
function auditExpressions(): string[] {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/routes/session-routes.ts'), 'utf8');
  const sf = ts.createSourceFile('session-routes.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'completeSpawn' && n.arguments.length === 3) {
      found.push(n.arguments[2].getText(sf));
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  expect(found).toHaveLength(2);
  return found;
}

/** Each route's actor expression evaluated with the real helpers, a body lineage parent, and `headers`. */
function actors(headers: Record<string, string>): string[] {
  const req = request(headers, { parentSessionId: parent });
  const parentSessionId = resolveParentSessionId(ctx, req, parent, undefined);
  expect(parentSessionId).toBe(parent); // the body parent wins lineage, as before
  return auditExpressions().map((expr) =>
    runInNewContext(expr, { auditActor, resolveParentSessionId, ctx, req, owner: undefined, parentSessionId, qsParentSessionId: parentSessionId })
  );
}

describe('spawn audit actor', () => {
  it('owner request with a lineage parent still records owner as the audit actor in both routes', () => {
    expect(actors({})).toEqual(['owner', 'owner']);
  });

  it('agent request records the actual caller, not a different body lineage parent, in both routes', () => {
    expect(actors({ 'x-codeman-parent-session': caller })).toEqual([caller, caller]);
  });

  it('an agent header alone names that agent; no header and no body names the owner', () => {
    expect(auditActor(ctx, request({ 'x-codeman-parent-session': caller }), undefined)).toBe(caller);
    expect(auditActor(ctx, request({}), undefined)).toBe('owner');
  });

  it('a header naming an unknown or other-owner session is not trusted as the actor', () => {
    expect(auditActor(ctx, request({ 'x-codeman-parent-session': '0000000f-0014-4000-8000-00000000001c' }), undefined)).toBe('owner');
    expect(auditActor(ctx, request({ 'x-codeman-parent-session': caller }), 'someone-else')).toBe('owner');
  });
});

describe('employee replacement audit names the caller', () => {
  let directory: string;

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("records the asking session, and 'owner' for the owner's own request", async () => {
    directory = mkdtempSync(join(tmpdir(), 'fleet-audit-actor-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const rooms = new ChatroomStore();
    const sessions = new Map(['ada-1', 'ada-2', 'ada-3'].map((id) => [id, { id, name: 'Ada', owner: undefined }]));
    const by: string[] = [];
    const service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        replaceSession: async (oldId, newId, asker, canTouch) => {
          by.push(asker);
          return rooms.replaceMember(oldId, newId, rooms.list().filter(canTouch)).map((r) => ({ id: r.id, name: r.name }));
        },
      },
      research: { start: vi.fn(), inspect: vi.fn(async () => undefined), stop: vi.fn(async () => {}) },
    });
    const ada = await service.hire({ name: 'Ada', icon: '🧩', position: 'Lead', expertise: ['ui'], sessionId: 'ada-1', researchEnabled: false });
    await service.completeSpawn('ada-2', service.prepareSpawn({ owner: undefined, employeeId: ada.id }));
    await service.completeSpawn('ada-3', service.prepareSpawn({ owner: undefined, parentSessionId: 'ada-2', employeeId: ada.id }), 'ada-2');
    expect(by).toEqual(['owner', 'ada-2']);
  });
});
