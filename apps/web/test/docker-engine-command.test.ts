/** The real transport callback is driven by a module-mocked physical HTTP port.
 * No socket, daemon, Docker command, runtime state or provider is accessed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, RequestOptions } from 'node:http';
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('node:http', async (original) => ({ ...(await original<typeof import('node:http')>()), request: requestMock }));
import { PackagedDockerEngineCommand } from '../src/docker-engine-command.js';
import {
  DockerEmployeeContinuationError,
  dockerContinuationFailureCauses,
} from '../src/docker-employee-continuation.js';
const name = 'reverie-boxed-' + 'a'.repeat(64),
  id = 'b'.repeat(64),
  secret = 'PRIVATE_ENV_SENTINEL /private/host/source';
const unknown = 'DOCKER_CONTINUATION_CREATE_UNCONFIRMED';
class PhysicalRequest extends EventEmitter {
  timeout?: () => void;
  end = vi.fn((_body: Buffer) => this);
  destroy = vi.fn(() => {
    this.emit('close');
    return this;
  });
  setTimeout = vi.fn((_ms: number, callback: () => void) => {
    this.timeout = callback;
    return this;
  });
}
class PhysicalResponse extends EventEmitter {
  complete = true;
  constructor(readonly statusCode: number) {
    super();
  }
}
function fixture(current: () => void = () => {}) {
  const call = new PhysicalRequest();
  let receive: ((response: IncomingMessage) => void) | undefined;
  requestMock.mockImplementation((_options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    receive = callback;
    return call;
  });
  const command = new PackagedDockerEngineCommand();
  return {
    call,
    command,
    start: () => command.create(name, { Image: 'sha256:' + 'c'.repeat(64), Env: ['TOKEN=' + secret] }, current),
    respond: (status: number, body: string | Buffer = JSON.stringify({ message: secret }), complete = true) => {
      const response = new PhysicalResponse(status);
      response.complete = complete;
      receive!(response as unknown as IncomingMessage);
      response.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body));
      response.emit('end');
      return response;
    },
    receive: (response: PhysicalResponse) => receive!(response as unknown as IncomingMessage),
  };
}
async function refusal(promise: Promise<string>, code = unknown) {
  const error = await promise.catch((error) => error);
  expect(error).toBeInstanceOf(DockerEmployeeContinuationError);
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error) + String(error.stack)).not.toContain(secret);
  return error;
}
afterEach(() => {
  requestMock.mockReset();
  vi.useRealTimers();
});
describe('fixed packaged Engine creation response', () => {
  it('accepts one complete201 identifier and keeps the endpoint/body private to the fixed port', async () => {
    const current = vi.fn(),
      f = fixture(current),
      pending = f.start();
    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      socketPath: '/run/reverie-engine/docker.sock',
      method: 'POST',
      path: '/v1.45/containers/create?name=' + name,
    });
    f.respond(201, JSON.stringify({ Id: id, Warnings: null }));
    expect(await pending).toBe(id);
    expect(current).toHaveBeenCalledTimes(3);
    expect(f.call.end).toHaveBeenCalledOnce();
    expect(f.call.destroy).not.toHaveBeenCalled();
  });
  it.each([
    [400, 'DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED'],
    [404, 'DOCKER_CONTINUATION_CREATE_DEPENDENCY_MISSING'],
    [409, 'DOCKER_CONTINUATION_CREATE_NAME_CONFLICT'],
  ])('classifies complete HTTP%s without retaining daemon text', async (status, code) => {
    const f = fixture(),
      pending = f.start();
    f.respond(status as number);
    await refusal(pending, code as string);
    expect(requestMock).toHaveBeenCalledOnce();
    expect(f.call.end).toHaveBeenCalledOnce();
  });
  it.each([200, 202, 302, 401, 500, 503])('keeps HTTP%s unknown, without an implicit retry', async (status) => {
    const f = fixture(),
      pending = f.start();
    f.respond(status);
    await refusal(pending);
    expect(requestMock).toHaveBeenCalledOnce();
  });
  it.each([
    '{}',
    'null',
    '[]',
    '{',
    '{"Id":"wrong"}',
    JSON.stringify({ Id: 'B'.repeat(64) }),
    JSON.stringify({ Id: 17 }),
  ])('keeps malformed201 body %s unknown', async (body) => {
    const f = fixture(),
      pending = f.start();
    f.respond(201, body);
    await refusal(pending);
    expect(requestMock).toHaveBeenCalledOnce();
  });
  it('refuses invalid UTF8 even if201 was observed', async () => {
    const f = fixture(),
      pending = f.start();
    f.respond(201, Buffer.from([0xff]));
    await refusal(pending);
  });
  it.each([201, 400, 404, 409, 500])('does not treat truncated HTTP%s as a definitive result', async (status) => {
    const f = fixture(),
      pending = f.start();
    f.respond(status, JSON.stringify({ Id: id, message: secret }), false);
    await refusal(pending);
  });
  it.each(['error', 'aborted', 'close'])(
    'holds an incomplete response after %s and ignores later successful-looking events',
    async (event) => {
      const f = fixture(),
        pending = f.start(),
        response = new PhysicalResponse(400);
      f.receive(response);
      response.emit(event, ...(event === 'error' ? [Error(secret)] : []));
      response.emit('error', Error(secret));
      response.emit('data', Buffer.from(JSON.stringify({ Id: id })));
      response.emit('end');
      await refusal(pending);
      expect(requestMock).toHaveBeenCalledOnce();
      expect(f.call.destroy).toHaveBeenCalledOnce();
    }
  );
  it('holds an oversized response before any partial body can qualify', async () => {
    const f = fixture(),
      pending = f.start();
    f.respond(201, Buffer.alloc(65537));
    await refusal(pending);
    expect(f.call.destroy).toHaveBeenCalledOnce();
  });
  it('holds a request error without retaining its message or retrying', async () => {
    const f = fixture(),
      pending = f.start();
    f.call.emit('error', Error(secret));
    f.call.emit('error', Error(secret));
    await refusal(pending);
    expect(requestMock).toHaveBeenCalledOnce();
  });
  it('holds socket timeout and a headerless close', async () => {
    for (const event of ['timeout', 'close']) {
      const f = fixture(),
        pending = f.start();
      if (event === 'timeout') f.call.timeout!();
      else f.call.emit('close');
      await refusal(pending);
      expect(f.call.end).toHaveBeenCalledOnce();
      requestMock.mockClear();
    }
  });
  it('bounds the whole request even if a peer never triggers socket timeout', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = f.start();
    const failed = refusal(pending);
    await vi.advanceTimersByTimeAsync(30001);
    await failed;
    expect(f.call.destroy).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledOnce();
  });
  it('does not dispatch if initial or final pre-dispatch currency is revoked', async () => {
    const changed = new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
    const first = fixture(() => {
      throw changed;
    });
    expect(() => first.start()).toThrow(changed);
    expect(requestMock).not.toHaveBeenCalled();
    let checks = 0;
    const second = fixture(() => {
      if (++checks === 2) throw changed;
    });
    await expect(second.start()).rejects.toBe(changed);
    expect(second.call.end).not.toHaveBeenCalled();
    expect(second.call.destroy).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledOnce();
  });
  it('does not publish a201 identifier into revoked authority', async () => {
    let active = true;
    const changed = new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
    const f = fixture(() => {
        if (!active) throw changed;
      }),
      pending = f.start();
    active = false;
    f.respond(201, JSON.stringify({ Id: id }));
    await expect(pending).rejects.toBe(changed);
    expect(requestMock).toHaveBeenCalledOnce();
    expect(f.call.end).toHaveBeenCalledOnce();
  });
  it('keeps synchronous physical request/end failures unknown and does not retry', async () => {
    const f = fixture();
    requestMock.mockImplementationOnce(() => {
      throw Error(secret);
    });
    await refusal(f.start());
    expect(requestMock).toHaveBeenCalledOnce();
    requestMock.mockClear();
    const g = fixture();
    g.call.end.mockImplementationOnce(() => {
      throw Error(secret);
    });
    await refusal(g.start());
    expect(requestMock).toHaveBeenCalledOnce();
  });
  it('does not admit caller-selected endpoints or overbound requests', () => {
    expect(() => new PackagedDockerEngineCommand('unix:///tmp/other.sock')).toThrow();
    const f = fixture();
    expect(() => f.command.create(name, { Env: ['x'.repeat(1024 * 1024)] }, () => {})).toThrow();
    expect(() => f.command.create('bad?name', {}, () => {})).toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });
  it('reports only allowlisted module locations for a typed create failure', async () => {
    const f = fixture(),
      pending = f.start();
    f.respond(400);
    const error = await refusal(pending, 'DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED');
    const diagnostic = dockerContinuationFailureCauses(error);
    expect(diagnostic[0]!.locations.some((x) => x.module === 'docker-engine-command')).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(JSON.stringify(diagnostic)).not.toContain('message');
  });
});
