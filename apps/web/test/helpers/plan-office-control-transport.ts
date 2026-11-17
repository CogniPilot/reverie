/** CI-only raw transport. Engine observations are DATA; the ordinary backend
 * still authenticates and admits every HTTP request. No response is synthesized. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}
const hex = /^[a-f0-9]{64}$/;
function privateIpv4(value: unknown): asserts value is string {
  assert.equal(typeof value, 'string');
  assert.equal(net.isIP(value as string), 4);
  const parts = (value as string).split('.').map(Number);
  assert.equal(parts.join('.'), value);
  assert.ok(
    parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
  );
}
export interface PlanOfficeControlTarget {
  readonly containerId: string;
  readonly imageId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly birthTicks: string;
  readonly sandboxId: string;
  readonly networkId: string;
  readonly endpointId: string;
  readonly address: string;
  readonly macAddress: string;
}
function originalTarget(value: unknown): Readonly<PlanOfficeControlTarget> {
  const v = record(structuredClone(value));
  assert.deepEqual(
    Object.keys(v).sort(),
    [
      'containerId',
      'imageId',
      'pid',
      'startedAt',
      'birthTicks',
      'sandboxId',
      'networkId',
      'endpointId',
      'address',
      'macAddress',
    ].sort()
  );
  for (const key of ['containerId', 'sandboxId', 'networkId', 'endpointId']) {
    assert.equal(typeof v[key], 'string');
    assert.match(v[key] as string, hex);
  }
  assert.equal(typeof v.imageId, 'string');
  assert.match(v.imageId as string, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(v.pid) && Number(v.pid) >= 2);
  assert.equal(typeof v.birthTicks, 'string');
  assert.match(v.birthTicks as string, /^[1-9][0-9]{0,19}$/);
  assert.equal(typeof v.startedAt, 'string');
  assert.match(v.startedAt as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/);
  assert.equal(typeof v.macAddress, 'string');
  assert.match(v.macAddress as string, /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/);
  privateIpv4(v.address);
  return Object.freeze(v) as unknown as Readonly<PlanOfficeControlTarget>;
}
/** Called only with fresh Driver.owned() and owned-network Engine reads. This
 * parser never establishes their provenance or grants backend authority. */
export function planOfficeControlTarget(
  scope: { instance: string; containerId: string; imageId: string; networkId: string },
  containerValue: unknown,
  networkValue: unknown,
  birthTicks: string
): Readonly<PlanOfficeControlTarget> {
  assert.match(scope.instance, /^[a-f0-9]{32}$/);
  assert.match(scope.containerId, hex);
  assert.match(scope.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(scope.networkId, hex);
  assert.match(birthTicks, /^[1-9][0-9]{0,19}$/);
  const container = record(containerValue),
    network = record(networkValue),
    config = record(container.Config),
    state = record(container.State),
    settings = record(container.NetworkSettings),
    host = record(container.HostConfig),
    networkName = 'reverie-ci-plan-office-' + scope.instance + '-front';
  assert.equal(container.Id, scope.containerId);
  assert.equal(container.Image, scope.imageId);
  assert.equal(record(config.Labels)['reverie.disposable'], scope.instance);
  assert.equal(record(config.Labels)['reverie.task'], 'plan-office-baseline-v1');
  assert.equal(record(config.Labels)['reverie.role'], 'control');
  assert.equal(state.Running, true);
  assert.equal(state.Status, 'running');
  assert.ok(Number.isSafeInteger(state.Pid) && Number(state.Pid) >= 2);
  assert.equal(typeof state.StartedAt, 'string');
  assert.match(state.StartedAt as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/);
  assert.match(String(settings.SandboxID), hex);
  assert.equal(host.NetworkMode, scope.networkId);
  assert.deepEqual(host.PortBindings ?? {}, {}, 'Internal control must not request unsupported host publication');
  assert.ok(record(settings.Ports)['3000/tcp'] == null, 'Internal control must not publish an API port');
  assert.equal(network.Id, scope.networkId);
  assert.equal(network.Name, networkName);
  assert.equal(network.Driver, 'bridge');
  assert.equal(network.Internal, true);
  assert.equal(record(network.Labels)['reverie.disposable'], scope.instance);
  assert.equal(record(network.Labels)['reverie.task'], 'plan-office-baseline-v1');
  const endpoint = record(record(settings.Networks)[networkName]),
    member = record(record(network.Containers)[scope.containerId]);
  assert.equal(endpoint.NetworkID, scope.networkId);
  assert.match(String(endpoint.EndpointID), hex);
  assert.equal(member.EndpointID, endpoint.EndpointID);
  privateIpv4(endpoint.IPAddress);
  assert.ok(
    Number.isSafeInteger(endpoint.IPPrefixLen) &&
      Number(endpoint.IPPrefixLen) >= 1 &&
      Number(endpoint.IPPrefixLen) <= 32
  );
  assert.equal(member.IPv4Address, endpoint.IPAddress + '/' + endpoint.IPPrefixLen);
  assert.match(String(endpoint.MacAddress), /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/);
  assert.equal(member.MacAddress, endpoint.MacAddress);
  return Object.freeze({
    containerId: scope.containerId,
    imageId: scope.imageId,
    pid: Number(state.Pid),
    startedAt: state.StartedAt as string,
    birthTicks,
    sandboxId: settings.SandboxID as string,
    networkId: scope.networkId,
    endpointId: endpoint.EndpointID as string,
    address: endpoint.IPAddress,
    macAddress: endpoint.MacAddress as string,
  });
}
export interface PlanOfficeControlTransport {
  readonly endpoint: string;
  requireCurrent(): void;
  close(): Promise<void>;
}
/** One fixed private IPv4:3000 target, one owned loopback listener. Drift is
 * sticky; original socket errors reach callers without invented HTTP replies. */
export async function openPlanOfficeControlTransport(
  readCurrent: () => Readonly<PlanOfficeControlTarget>
): Promise<PlanOfficeControlTransport> {
  const target = originalTarget(readCurrent());
  const sockets = new Set<net.Socket>(),
    pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined,
    failed: unknown,
    stopped = false;
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('error', () => {}); // Paired handlers close streams; unpaired refusals still consume errors.
    const done = new Promise<void>((resolve) =>
      socket.once('close', () => {
        sockets.delete(socket);
        resolve();
      })
    );
    pending.add(done);
    void done.then(() => pending.delete(done));
    return socket;
  };
  const close = () => {
    if (closing) return closing;
    stopped = true;
    const serverClosed = new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      })
    );
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Control transport cleanup unconfirmed')), 5000);
      void Promise.all([serverClosed, ...pending]).then(
        () => {
          clearTimeout(timer);
          if (sockets.size !== 0) reject(Error('Control transport streams remain unconfirmed'));
          else resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
    return closing;
  };
  const current = () => {
    assert.equal(stopped, false, 'Control transport is closed');
    if (failed) throw failed;
    try {
      assert.ok(isDeepStrictEqual(originalTarget(readCurrent()), target), 'Original control endpoint changed');
    } catch (error) {
      failed = error;
      void close().catch(() => {});
      throw error;
    }
  };
  const server = net.createServer({ allowHalfOpen: true }, (incoming) => {
    const client = track(incoming);
    client.pause();
    if (sockets.size > 64) {
      client.destroy();
      return;
    }
    try {
      current();
    } catch {
      client.destroy();
      return;
    }
    let upstream: net.Socket;
    try {
      upstream = track(net.createConnection({ host: target.address, port: 3000, family: 4 }));
    } catch {
      client.destroy();
      return;
    }
    upstream.pause();
    const destroy = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', destroy);
    upstream.on('error', destroy);
    const aborted = (socket: net.Socket) => {
      if (!socket.readableEnded || !socket.writableFinished) destroy();
    };
    client.once('close', () => aborted(client));
    upstream.once('close', () => aborted(upstream));
    // The existing API transport is bounded at 30s. This is inactivity only;
    // active backpressured bytes retain their ordinary backend outcome.
    client.setTimeout(30_000, destroy);
    upstream.setTimeout(30_000, destroy);
    const timer = setTimeout(destroy, 5000);
    upstream.once('close', () => clearTimeout(timer));
    upstream.once('connect', () => {
      clearTimeout(timer);
      try {
        current();
      } catch {
        destroy();
        return;
      }
      const relay = (from: net.Socket, to: net.Socket) => {
        from.on('data', (bytes: Buffer) => {
          try {
            current();
          } catch {
            destroy();
            return;
          }
          if (!to.write(bytes)) from.pause();
        });
        to.on('drain', () => {
          if (!stopped && !from.destroyed) from.resume();
        });
        from.once('end', () => {
          try {
            current();
          } catch {
            destroy();
            return;
          }
          to.end();
        });
      };
      relay(client, upstream);
      relay(upstream, client);
      client.resume();
      upstream.resume();
    });
  });
  server.on('error', (error) => {
    failed = error;
    void close().catch(() => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    current();
    const address = server.address();
    assert.ok(address && typeof address === 'object' && address.address === '127.0.0.1' && address.port >= 1024);
    return Object.freeze({ endpoint: 'http://127.0.0.1:' + address.port, requireCurrent: current, close });
  } catch (error) {
    await close();
    throw error;
  }
}
