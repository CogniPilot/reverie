/** Guest image purpose only. The build-level module composition is fixed;
 * neither environment nor MCP input selects this path or grants access. */
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';

export function memoryOrigin(executable: string): boolean {
  if (executable !== '/opt/reverie/memory/bin/reverie-memory') return false;
  let parent = dirname(executable);
  for (;;) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    const next = dirname(parent);
    if (next === parent) return true;
    parent = next;
  }
}
