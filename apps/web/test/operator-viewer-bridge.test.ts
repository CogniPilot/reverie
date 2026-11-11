import {expect, it} from 'vitest';
import {attachmentCommand, attachRequest, inspectTarget, validateTarget, type Target} from '../scripts/operator-viewer-bridge.js';
const target: Target = {sessionId: '00000001-0001-4000-8000-000000000001', containerId: 'a'.repeat(64), startedAt: '2026-11-11T00:00:00.000Z', pid: 1234, socket: '/tmp/private/operator.sock'};
const row = {Id: target.containerId, Name: `/reverie-agent-${target.sessionId}`, State: {Running: true, StartedAt: target.startedAt, Pid: target.pid}};
it('pins exact original container incarnation and never selects by mutable name', () => {
  expect(() => inspectTarget(target, row)).not.toThrow();
  for (const changed of [{...row, Id: 'b'.repeat(64)}, {...row, Name: '/foreign'}, {...row, State: {...row.State, Running: false}}, {...row, State: {...row.State, StartedAt: '2026-11-12T00:00:00.000Z'}}, {...row, State: {...row.State, Pid: 5678}}]) expect(() => inspectTarget(target, changed)).toThrow();
});
it('rejects abbreviated IDs, shell metacharacters and socket traversal', () => {
  for (const changed of [{...target, containerId: 'aaaa'}, {...target, containerId: ';touch /tmp/escape'}, {...target, socket: '/tmp/private/../operator.sock'}]) expect(() => validateTarget(changed)).toThrow();
});
it('accepts only exact-session attach-only J and never executes supplied commands', () => {
  const request = {sessionId: target.sessionId, attachOnly: true, cols: 120, rows: 40, command: 'DO NOT RUN', cwd: '/foreign', env: {PATH: '/foreign'}};
  expect(attachRequest(target, 74, Buffer.from(JSON.stringify(request)))).toEqual({cols: 120, rows: 40});
  expect(attachmentCommand(target, 120, 40)).toBe(`stty cols 120 rows 40; exec docker exec -it ${target.containerId} /bin/tmux -u -L reverie-laptop attach-session -t =office`);
  for (const changed of [{...request, attachOnly: false}, {...request, sessionId: 'foreign'}, {...request, cols: '120'}, {...request, rows: 0}]) expect(() => attachRequest(target, 74, Buffer.from(JSON.stringify(changed)))).toThrow();
  expect(() => attachRequest(target, 67, Buffer.from('{}'))).toThrow();
});
