# Reverie Console

Reverie's company dashboard and agent session runtime, maintained as part of the
[Reverie monorepo](../../README.md). [UPSTREAM.md](UPSTREAM.md) records its
provenance; the original [MIT license](LICENSE) and attribution remain intact.

Install the complete application from the repository root:

```sh
nix profile install .#default
reverie web
```

Build the container with `nix build .#dockerImage`. See the
[monorepo instructions](../../README.md) for running it and configuring credentials.
Update by reviewing monorepo changes and rebuilding; the inherited upstream
self-updater is disabled.

The command is `reverie`. State defaults to `~/.reverie`, with a `reverie` tmux
socket. Set `REVERIE_INSTANCE`, `REVERIE_DATA_DIR`, `REVERIE_TMUX_SOCKET` and
`REVERIE_PORT` for an isolated deployment. Set `REVERIE_CASES_PATH` to choose a
workspace root. Environment variables use the `REVERIE_*` prefix.

For console development, use Node 22 or newer:

```sh
npm ci
npm run build
node dist/index.js web
```

Every permanent expert uses the same employee and memory model. Positions such as
CTO and COO are role labels. They grant no authority automatically: the owner
assigns capabilities such as employee recovery explicitly, and host keeper/admin
grants name exact employee IDs. The owner may choose any expert as the briefing
coordinator; that scheduling choice grants no permissions.

The Company panel manages permanent employees, positions, expertise, curated
notes, expert invitations, nightly research and CTO briefings. Research defaults
to a 60-minute budget, with an owner-selected timezone and schedule. It is off
until configured by the owner. Each cycle uses a fresh dedicated session and
workspace under `~/scratch/reverie/research` (`/scratch/research` in the image;
`REVERIE_RESEARCH_ROOT` overrides it); it never resumes an employee's private conversation. Completed reports
and honest failures remain visible after restart. Research ideas remain hypotheses
until corroborated independently. Standard local provider sessions with a declared
composer readiness marker are supported; custom endpoints and remote/container
employee sessions currently require a separate research adapter.

A Claude session created with `resumeSessionId` must find that conversation's
transcript in its own config dir (its account). It never starts a fresh thread in
its place. No copy anywhere: 404. A copy with no conversation entry for the id: 422.
Missing from the target, differing copies in the target, or a newer differing copy
in another account, or two differing copies modified within 2 s of each other: 409,
naming every copy. An older, different copy elsewhere is resumed past, with a
`warnings` entry naming it. `refreshResumeFromNewest: true` copies
the newest transcript and its sidecar dir (`<id>/`: tool-results, subagents) in
atomically, keeps what it replaces as `*.bak-<time>`, and sets aside every other
copy in the target. The project's `memory/` dir is deliberately not carried, since it
belongs to the project in each account, not to one conversation.

For MCP over stdio, use [config/mcp-client.json](config/mcp-client.json) in your
MCP client's configuration. It runs the locally installed `reverie mcp`; ensure
`reverie` is on that client's PATH. Explicitly set `REVERIE_API_URL` in the MCP client's inherited environment to select the intended
Reverie server. No server URL is guessed. If authentication is enabled, supply
`REVERIE_PASSWORD` through the client's secret environment,
outside the repository. This private fork has no registry publication identity
and the example never downloads an upstream package.

Common dashboard shortcuts are listed below. App Settings → Shortcuts lists the
full set and lets you rebind or disable them. Alt is Option on macOS.

| Shortcut                        | Action                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `Ctrl/Cmd/Option+K`             | Find open session or start a new one                                                   |
| `Alt/Option+[` / `Alt/Option+]` | Previous / next session                                                                |
| `Alt/Option+1`-`Alt/Option+9`   | Select the corresponding session tab                                                   |
| `Ctrl/Cmd+C`                    | Copy the terminal selection; Ctrl+C without a selection interrupts the running process |
| `Ctrl+Shift+C`                  | Copy the terminal selection explicitly                                                 |

```sh
npm run typecheck
npm run lint
npm test
npm run test:browser
```

Historical upstream documents retained under `docs/` describe the imported
implementation. This README and the monorepo instructions define Reverie's packaging
and update process.
