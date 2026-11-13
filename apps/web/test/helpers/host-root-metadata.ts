/** Test-only trusted host-root model for Nix's UID65534 sandbox root.
 * Descendant metadata, private files and opened descriptors remain actual.
 */
import type { Stats, BigIntStats } from 'node:fs';

export interface HostRootMetadata {
  uid: number;
  mode?: number;
}

export function hostRootMetadata<T extends Stats | BigIntStats>(
  file: unknown,
  entry: T,
  selected: HostRootMetadata
): T {
  if (file !== '/') return entry;
  return Object.assign(entry, {
    uid: typeof entry.uid === 'bigint' ? BigInt(selected.uid) : selected.uid,
    ...(selected.mode === undefined
      ? {}
      : { mode: typeof entry.mode === 'bigint' ? BigInt(selected.mode) : selected.mode }),
  });
}
