/** Read-only help over the existing Commander metadata; no action is invoked here. */
import type { Command } from 'commander';
import { toolHelpIndex } from './cli-tool-index.js';

export interface HelpIO {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  out(text: string): void;
  err(text: string): void;
  prompt(question: string): Promise<string>;
}

function commandPath(command: Command): string {
  const names = [command.name()];
  for (let parent = command.parent; parent; parent = parent.parent) names.unshift(parent.name());
  return names.join(' ');
}

/** A browser for metadata only. Choosing a command displays help, never its action. */
export async function browseCommandHelp(root: Command, io: HelpIO): Promise<number> {
  if (!io.inputIsTTY || !io.outputIsTTY) {
    io.err('Interactive help requires a terminal for input and output. Use --help or tools --json.');
    return 2;
  }
  let current = root;
  for (;;) {
    io.out(current.helpInformation());
    const children = [...current.commands].sort((a, b) => a.name().localeCompare(b.name()));
    children.forEach((child, index) => io.out(`${index + 1}. ${child.name()} — ${child.summary() || child.description()}`));
    let answer: string;
    try { answer = (await io.prompt('Help: number to inspect, b back, q quit: ')).trim(); }
    catch { return 0; } // Closed input ends this read-only browser.
    if (/^(q|quit)$/i.test(answer)) return 0;
    if (/^(b|back)$/i.test(answer)) { current = current.parent || root; continue; }
    if (/^[1-9][0-9]*$/.test(answer) && children[Number(answer) - 1]) current = children[Number(answer) - 1];
    else io.err('Choose a listed number, b, or q. Commands and shell text are not executed.');
  }
}

export function printToolIndex(json: boolean, out: (text: string) => void): void {
  const entries = toolHelpIndex();
  out(json ? JSON.stringify(entries) : entries.map(entry => `${entry.description}\n  ${entry.helpCommand}`).join('\n'));
}

async function terminalBrowser(program: Command): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Interactive help requires a terminal for input and output. Use --help or tools --json.');
    return 2;
  }
  const { createInterface } = await import('node:readline/promises');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  terminal.on('close', () => abort.abort());
  terminal.on('SIGINT', () => abort.abort());
  try {
    return await browseCommandHelp(program, {
      inputIsTTY: true, outputIsTTY: true,
      out: text => console.log(text), err: text => console.error(text),
      prompt: question => terminal.question(question, { signal: abort.signal }),
    });
  } finally { terminal.close(); }
}

export function registerHelpCommands(program: Command): void {
  program.command('tools').description('Discover tool topics and their help commands')
    .option('--json', 'Only description/helpCommand pairs as JSON')
    .option('--interactive', 'Browse command help in a terminal; never executes commands')
    .action(async (options: { json?: boolean; interactive?: boolean }) => {
      if (options.json && options.interactive) { console.error('Choose --json or --interactive.'); process.exitCode = 2; return; }
      if (options.interactive) { process.exitCode = await terminalBrowser(program); return; }
      printToolIndex(Boolean(options.json), text => console.log(text));
    });

  // One source for index descriptions and concise command-family summaries.
  for (const entry of toolHelpIndex()) {
    const parts = entry.helpCommand.split(' ');
    if (parts.shift() !== program.name()) continue; // Separate installed Python entrypoint.
    parts.pop(); // --help
    let command: Command | undefined = program;
    for (const name of parts) command = command?.commands.find(child => child.name() === name);
    command?.summary(entry.description);
  }
  const configure = (command: Command) => {
    command.configureHelp({ sortSubcommands: true, showGlobalOptions: true });
    command.showHelpAfterError();
    const children = command.commands.length ? `\nMore: ${commandPath(command)} <command> --help` : '';
    command.addHelpText('after', `${children}\nInteractive help: ${program.name()} tools --interactive (terminal only; displays help, never runs commands).`);
    command.commands.forEach(configure);
  };
  configure(program);
}
