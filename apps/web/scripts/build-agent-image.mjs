#!/usr/bin/env node
/** Build the same complete Nix runtime used by the server, then load/tag it. */
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let engine = 'docker';
let image = 'reverie/agent:base';
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--engine') engine = process.argv[++i];
  else if (arg === '--image') image = process.argv[++i];
  else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node scripts/build-agent-image.mjs [--engine docker|podman] [--image REF]');
    process.exit(0);
  } else {
    console.error(`Unsupported option: ${arg}. Nix uses its locked dependency cache.`);
    process.exit(2);
  }
}
if (!['docker', 'podman'].includes(engine) || !image) process.exit(2);
const build = process.env.REVERIE_BUILD_DIR || join(homedir(), 'scratch/reverie/build');
mkdirSync(build, { recursive: true });
const archive = join(build, 'docker-image');
for (const [command, args] of [
  ['nix', ['build', `${root}#dockerImage`, '--out-link', archive]],
  [engine, ['load', '--input', archive]],
  [engine, ['tag', 'reverie:latest', image]],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Built ${image} from the shared Reverie runtime.`);
