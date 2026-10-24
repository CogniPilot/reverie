# Optional chat plugins

Open **Plugins** in the conversation header. Python, Modelica and LaTeX are
independent browser preferences and default to off. Turning a language plugin
on adds an assistance button beside explicitly labelled code fences (`python`,
`py`, `modelica` or `mo`). Existing code and its Copy action keep their exact
text. Unlabelled code is never guessed.

The assistance button opens a scratch copy. Edit it and select **Check** for
diagnostics, **Complete** for suggestions at the cursor, or **Hover** for type
information. Suggestions are displayed as text and never applied automatically.
The original message is unchanged. Closing the editor or disabling the plugin
cancels outstanding requests and discards its draft. No draft is stored in
browser storage or sent to an agent/provider. Only boolean plugin preferences
are saved on this browser.

Language assistance requires an owner sign-in. Each assistance action sends
only the scratch snippet and cursor to the same-origin Reverie API. The API
starts one local language server in a fresh temporary workspace, opens a single
in-memory document and destroys it after the response. It gives the server a
temporary HOME without inherited account credentials or workspace paths. It
does not execute snippets, run commands suggested by a server, save workspace
files or resolve links in hover/completion text. Servers have a 10 second
deadline, bounded input/output and at most two concurrent requests. Snippets
are disposable: on POSIX, the server and its descendant processes are terminated
together before the request slot is released. Snippets
are limited to 50,000 UTF-16 code units; diagnostics and completions to 100
entries. Standalone snippets may have unresolved imports or lack project-wide
type information.

## Owner setup

For a container deployment, build the optional server image:

```bash
nix build .#dockerImageWithChatLanguages
```

Deploy it through the normal owner-controlled rollout. It includes the two
language servers and their configured paths inside the image; the default
server image and laptop images stay unchanged. The browser plugins still
default to off. This image provides the tools without granting host access.

For a native deployment, use the individual packages below.

Enabling a plugin never installs, downloads or starts a language server. Optional
tools are separate from Reverie's default runtime and images. Build the pinned
tools explicitly when needed:

```bash
nix build .#chatPythonLsp --out-link "$HOME/scratch/reverie/chat-python-lsp"
nix build .#chatModelicaLsp --out-link "$HOME/scratch/reverie/chat-modelica-lsp"
```

Set these absolute paths in the environment of the next Reverie web process:

```bash
export REVERIE_CHAT_PYTHON_LSP_BINARY="$HOME/scratch/reverie/chat-python-lsp/bin/pyright-langserver"
export REVERIE_CHAT_MODELICA_LSP_BINARY="$HOME/scratch/reverie/chat-modelica-lsp/bin/rumoca-lsp"
```

Use actual installed binaries; do not point these settings at an installer,
`nix run` wrapper or build-on-start launcher. These are trusted owner-selected
programs, running with the web service's operating-system permissions. Reverie
does not expose arbitrary command, environment, file path or JSON-RPC inputs in
the assistance API. Remove the variables to revoke availability on the next
website start; browser toggles immediately remove their controls and cancel
active requests.

Python uses [Microsoft Pyright's stdio language server](https://github.com/microsoft/pyright/blob/main/packages/pyright/langserver.index.js),
with its version and dependencies pinned by the existing nixpkgs flake lock.
Modelica uses [Rumoca LSP 0.9.20](https://github.com/CogniPilot/rumoca/releases/tag/v0.9.20),
with official Linux release binaries pinned by SHA-256 for x86_64 and aarch64.
Rumoca uses its default stdio transport. Tool installation is an owner action;
the chat UI makes no CDN requests or language-server download requests.

After configuring both binaries, an explicit native check exercises real
diagnostics, completion and hover against isolated synthetic snippets:

```bash
nix develop --command bash -c 'cd apps/web && npx tsx scripts/check-chat-language-servers.mts'
```

## Extension interface

`window.ReverieChatPlugins.register({ id, label, description, languages,
enhanceBlock, enable })` registers a bundled extension. `enable(host)` may return
a cleanup function, called on disable. `enhanceBlock({code, pre, language, host})`
may return a cleanup function, called on disable or when the block leaves the
document. `onEnable(host)`/`onDisable(host)` are also supported for extensions
that do not return a cleanup function. The host provides `isEnabled(id)`,
`setEnabled(id, boolean)`, `scan(root)` and `openSettings()`. Registration itself
must not perform I/O. Extensions are bundled trusted source, not downloadable
scripts or user-provided JavaScript.
