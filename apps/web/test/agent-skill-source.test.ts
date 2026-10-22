import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSkillSourceDir } from '../src/agent-skill-source.js';

let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe('canonical skill source and installed payload', () => {
  it('prefers the single root skill when running from a monorepo checkout', async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-skill-source-'));
    const canonical = join(directory, 'skills', 'reverie');
    const packageRoot = join(directory, 'apps', 'web');
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, 'SKILL.md'), 'canonical');
    expect(agentSkillSourceDir(packageRoot)).toBe(join(packageRoot, '..', '..', 'skills', 'reverie'));
  });
  it('uses the Nix-installed payload beside dist when no checkout root is present', async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-skill-package-'));
    const packageRoot = join(directory, 'lib', 'reverie');
    const payload = join(packageRoot, 'skills', 'reverie');
    await mkdir(payload, { recursive: true });
    await writeFile(join(payload, 'SKILL.md'), 'installed');
    expect(agentSkillSourceDir(packageRoot)).toBe(payload);
  });
});
