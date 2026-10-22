import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout has one root source; Nix installs its payload beside dist/. */
export function agentSkillSourceDir(packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')): string {
  const canonical = join(packageRoot, '..', '..', 'skills', 'reverie');
  return existsSync(join(canonical, 'SKILL.md')) ? canonical : join(packageRoot, 'skills', 'reverie');
}
