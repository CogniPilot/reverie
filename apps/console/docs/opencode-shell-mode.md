# OpenCode shell mode and chat deliveries

OpenCode's prompt treats a `!` keystroke as "enter shell mode" while its composer is empty. A chat delivery (or an agent's
`reverie agent send`) is typed into the pane as one burst of keys, and the first `!` of the burst can be taken as that key even
though the box is no longer empty. The rest of the line is then typed as a shell command and Enter runs it in bash.

## What Reverie does (OpenCode panes only; Claude and other panes are unchanged)

1. **Always on.** For chat deliveries and for `send` requests that name a calling agent session, every ASCII `!` becomes the
   fullwidth `！` (U+FF01) before typing. It reads the same and is not the shell-mode key. A person's own typing, in the browser or
   with a request that names no agent session, is left exactly as typed.
2. **Always on.** Just before Enter, if the bottom of the pane shows the shell-mode footer (`esc exit shell mode`), Reverie sends
   Escape first. That keeps the text and returns to normal mode, so Enter sends a prompt, not a shell command.
3. **Opt-in.** With `REVERIE_OPENCODE_PASTE=1` in the console's environment, the line goes in as a bracketed paste
   (`tmux load-buffer -b <name> -` then `paste-buffer -p -d`), a 100 ms pause, then Enter. A paste never reaches OpenCode's key
   bindings, so no `!` guard is needed (the guard still applies). **Before turning this on, set
   `experimental.disable_paste_summary: true` in OpenCode's config:** otherwise OpenCode folds a paste longer than about 150
   characters into a `[Pasted ~1 lines]` chip and the delivery no longer reads as plain text. It is off by default for that reason.

Code: `src/opencode-input.ts`, used by `Session.writeViaMux` (option `opencodeGuard`) and `TmuxManager.sendInput`.
