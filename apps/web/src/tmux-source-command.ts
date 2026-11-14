/** Literal tmux config transport. This encodes DATA only; the original
 * publication still owns every physical dispatch. Callers select the fixed
 * commands; their own format semantics remain unchanged.
 */
export const MAX_TMUX_ARGUMENT_BYTES = 96 * 1024;
export function tmuxSourceCommands(commands: readonly (readonly string[])[]): string {
  if (commands.length === 0 || commands.length > 16) throw Error('Bounded tmux command batch required');
  let total = 0;
  return (
    commands
      .map((args) => {
        if (args.length === 0 || args.length > 64) throw Error('Bounded tmux argument count required');
        return args
          .map((value) => {
            const bytes = Buffer.from(value, 'utf8');
            if (value.includes('\0') || bytes.toString('utf8') !== value || bytes.length > MAX_TMUX_ARGUMENT_BYTES)
              throw Error('Bounded exact UTF-8 tmux argument required');
            total += bytes.length;
            if (total > 256 * 1024) throw Error('Bounded tmux batch size required');
            return (
              '"' +
              [...value]
                .map((character) => {
                  // Keep only parser-inert printable characters literal. Octal quotes
                  // all syntax/control bytes without shell or tmux variable interpolation.
                  if (/^[a-zA-Z0-9_:/.,=+ -]$/.test(character) || character.codePointAt(0)! >= 128) return character;
                  return [...Buffer.from(character, 'utf8')]
                    .map((byte) => '\\' + byte.toString(8).padStart(3, '0'))
                    .join('');
                })
                .join('') +
              '"'
            );
          })
          .join(' ');
      })
      .join('\n') + '\n'
  );
}
