import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolHelpIndex } from '../src/cli-tool-index.js';
import { browseCommandHelp, printToolIndex, registerHelpCommands } from '../src/cli-help.js';
import { program } from '../src/cli.js';
const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('small shared tool index', () => {
  it('has only topic descriptions and help commands, with independent returned copies', () => {
    const entries = toolHelpIndex();
    expect(entries.length).toBeGreaterThanOrEqual(6); expect(entries.length).toBeLessThanOrEqual(10);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'helpCommand']);
      expect(entry.description.trim()).not.toBe(''); expect(entry.helpCommand).toMatch(/^reverie(?:-memory|(?: [a-z-]+)+) --help$/);
    }
    expect(Buffer.byteLength(entries.map(entry => entry.description + '\n' + entry.helpCommand).join('\n'))).toBeLessThan(1024);
    entries[0].description = 'Changed local copy'; expect(toolHelpIndex()[0].description).not.toBe('Changed local copy');
  });
  it('uses the same topic metadata in registered command-family help', () => {
    for (const entry of toolHelpIndex()) {
      const words = entry.helpCommand.split(' '); if (words.shift() !== 'reverie') continue;
      words.pop(); let command = program;
      for (const word of words) command = command.commands.find(child => child.name() === word)!;
      expect(command).toBeDefined(); expect(command.summary()).toBe(entry.description);
      expect(command.helpInformation()).toContain('--help');
    }
  });
  it('prints deterministic JSON without terminal formatting or permission claims', () => {
    const output = vi.fn(); printToolIndex(true, output);
    expect(output).toHaveBeenCalledOnce(); expect(JSON.parse(output.mock.calls[0][0])).toEqual(toolHelpIndex());
    expect(output.mock.calls[0][0]).not.toMatch(/\x1b/);
    const plain = vi.fn(); printToolIndex(false, plain);
    for (const entry of toolHelpIndex()) expect(plain.mock.calls[0][0]).toContain(entry.helpCommand);
  });
});

describe('explicit terminal help browser', () => {
  it.each([[false, true], [true, false], [false, false]])('never reads stdin unless both streams are terminals (%s,%s)', async (inputIsTTY, outputIsTTY) => {
    const prompt = vi.fn(); const out = vi.fn(), err = vi.fn();
    expect(await browseCommandHelp(program, { inputIsTTY, outputIsTTY, prompt, out, err })).toBe(2);
    expect(prompt).not.toHaveBeenCalled(); expect(out).not.toHaveBeenCalled(); expect(err).toHaveBeenCalledOnce();
  });
  it('navigates every level without ever executing the selected command or shell input', async () => {
    const root = new Command('fixture'); const execute = vi.fn(() => { throw Error('An action must never run'); });
    root.command('group').description('A group').command('destroy <id>').description('A dangerous action').action(execute);
    registerHelpCommands(root);
    const answers = ['1', '1', '$(touch unexpected)', 'b', 'b', 'q'];
    const out = vi.fn(), err = vi.fn();
    expect(await browseCommandHelp(root, { inputIsTTY: true, outputIsTTY: true, out, err, prompt: async () => answers.shift()! })).toBe(0);
    expect(execute).not.toHaveBeenCalled(); expect(err).toHaveBeenCalledOnce();
    expect(out.mock.calls.some(([text]) => text.includes('destroy [options] <id>'))).toBe(true);
  });
  it('ends safely when the terminal closes', async () => {
    expect(await browseCommandHelp(program, { inputIsTTY: true, outputIsTTY: true, out: vi.fn(), err: vi.fn(), prompt: async () => { throw Error('Input closed'); } })).toBe(0);
  });
  it('keeps ordinary command help plain and exposes opt-in browsing separately', () => {
    const tools = program.commands.find(command => command.name() === 'tools')!;
    expect(tools.options.map(option => option.long)).toEqual(expect.arrayContaining(['--json', '--interactive']));
    const help = tools.helpInformation(); expect(help).toContain('never executes commands'); expect(help).not.toMatch(/\x1b/);
  });
});

it('can import and render the complete real help tree without state writes, API calls or subprocess actions', () => {
  const home = mkdtempSync(join(tmpdir(), 'reverie-help-only-')); temporary.push(home);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const script = `
    import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import child from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const forbidden=()=>{throw Error('Help invoked a write, network request or process action')};
    for(const key of ['mkdirSync','writeFileSync','appendFileSync','renameSync','unlinkSync','rmSync'])fs[key]=forbidden;
    for(const key of ['mkdir','writeFile','appendFile','rename','unlink','rm'])fs.promises[key]=forbidden;
    for(const transport of [http,https])for(const key of ['get','request'])transport[key]=forbidden;
    for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync','fork'])child[key]=forbidden;
    globalThis.fetch=forbidden;syncBuiltinESMExports();
    const {program}=await import(${JSON.stringify(cli)});let count=0;
    function walk(command){command.helpInformation();count++;for(const child of command.commands)walk(child)}walk(program);
    console.log(JSON.stringify({count}));`;
  const output = execFileSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', script], {
    env: { HOME: home, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout: 15000,
  });
  expect(JSON.parse(output).count).toBeGreaterThan(100); expect(readdirSync(home)).toEqual([]);
});
