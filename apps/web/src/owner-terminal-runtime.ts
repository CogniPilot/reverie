/** Optional fixed early-start socket. Absent/unqualified installation is unavailable.
 * No env-selected FD, socket path, owner bool, executable or observer callback.
 */
import { Socket } from 'node:net';
import { lstatSync, readFileSync } from 'node:fs';
import { OwnerLaptopTerminalAuthority, type AuthorityDependencies, type AuthorityRequest } from './owner-laptop-terminal-authority.js';
import { OwnerLedgerBridge } from './owner-ledger-bridge.js';

let socket: Socket | undefined, attempted = false;
export function installOwnerTerminalSocket(value: Socket): void {
  if (attempted || !(value instanceof Socket) || !value.isPaused() || value.destroyed) throw new Error('Owner terminal startup unavailable');
  attempted = true; socket = value;
}
interface Projection {
  version: 1; available: boolean; atEpochMs: number; externalOrigin: string;
  ingressPeers: Array<{address: string; localPort: number; encrypted: boolean}>;
  targets: Record<string, unknown>;
}
function projection(): Projection {
  const path = '/run/reverie-owner-terminal/current.json', before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.()
    || (before.mode & 0o777) !== 0o600 || before.size > 131072) throw new Error('Owner terminal native projection unavailable');
  const raw = readFileSync(path), after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new Error('Owner terminal native projection changed');
  const value = JSON.parse(raw.toString('utf8')) as Projection;
  if (value.version !== 1 || value.available !== true || !Number.isSafeInteger(value.atEpochMs)
    || Date.now() - value.atEpochMs < -100 || Date.now() - value.atEpochMs > 2000
    || !Array.isArray(value.ingressPeers) || value.ingressPeers.length < 1 || value.ingressPeers.length > 8
    || typeof value.targets !== 'object' || value.targets === null) throw new Error('Owner terminal native projection expired');
  return value;
}
export type TerminalRequest = AuthorityRequest & {raw: {socket: {remoteAddress?: string; localPort?: number; encrypted?: boolean}}};
export function createOwnerTerminalRuntime<R extends TerminalRequest>(
  verifiedOwner: (request: R) => boolean, officeAuth: AuthorityDependencies<R>['officeAuth']
): {authority: OwnerLaptopTerminalAuthority<R>; bridge: OwnerLedgerBridge<R>} | undefined {
  if (!socket) return undefined;
  const selected = socket; socket = undefined;
  const initial = projection();
  let bridge: OwnerLedgerBridge<R>;
  const authority = new OwnerLaptopTerminalAuthority<R>({verifiedOwner, officeAuth,
    ingress: {externalOrigin: initial.externalOrigin, assertRequestBinding(request) {
      const current = projection();
      if (current.externalOrigin !== initial.externalOrigin || JSON.stringify(current.ingressPeers) !== JSON.stringify(initial.ingressPeers)
        || !current.ingressPeers.some(peer => peer.address === request.raw.socket.remoteAddress
          && peer.localPort === request.raw.socket.localPort && peer.encrypted === Boolean(request.raw.socket.encrypted)))
        throw new Error('Trusted owner terminal ingress unavailable');
    }},
    observeLaptop: async employeeId => projection().targets[employeeId],
    protectedChannel: {async assertCurrent() { bridge.assertCurrent(); projection(); }},
    contextLifetimeMs: 300_000,
  });
  bridge = new OwnerLedgerBridge(selected, authority);
  return {authority, bridge};
}
