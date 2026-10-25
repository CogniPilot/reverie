# Reverie service setup

Choose one website deployment. Native `reverie service` manages the existing
website job; a container deployment uses its existing engine lifecycle instead.
Do not install a second native website beside a running container. Both can use
the separately installed existing isolated-laptop broker on supported local Linux.
No command below requires editing a personal NixOS repository or rebuilding the
host. Source examples are not activation of a particular private installation.

## Native website

On a supported Linux Nix host:

```bash
nix profile install .#default
reverie service install --host 127.0.0.1 --port 3000
reverie service status
reverie service stop
reverie service start
reverie service logs --lines 100
reverie service uninstall
```

The existing service uses a systemd **user** unit on Linux or a per-user
LaunchAgent on macOS. The CLI's native macOS support does not imply these
Linux-only flake outputs or isolated-worker backend work through Docker Desktop.
Installation refuses an active native unit or an unmanaged website answering at
the same address. Stop and review the existing deployment before replacing it.
`start` and `stop` control the installed website unit; they do not toggle employee
desired-running or vacation state. Uninstall removes the service, preserving data.

Linux starts the enabled unit with the user manager, normally at login. Keeping
it after logout or starting before login requires an owner-selected linger policy.
Installation only reads that policy; it never silently enables it or requests
sudo. Inspect with `loginctl show-user "$USER" --property=Linger`. If needed, an
owner can separately enable linger using the host's ordinary authentication.
The macOS LaunchAgent starts in the user's login domain, not as a system daemon.
Native service logs are bounded by `--lines`; direct journal/tail commands can be
used for an owner's interactive follow session.

## Container website

For a new reviewed deployment with a running owner-selected engine:

```bash
nix run .#start
```

This is the existing container launcher, not a native website-service install.
Retain and review `deployment.json`; select the configured container name for
normal engine `start`, `stop`, `inspect` and `logs` commands. The launcher uses
`unless-stopped` for the website. An explicit stop stays an owner stop under that
policy. Container removal is not service uninstall: preserve every data/project
bind and reviewed recovery receipt before any recreation. Do not use engine
access as a substitute for host administrator authentication.

## Isolated laptop broker

The Reverie-owned helper manages the existing `reverie-worker-broker.service`;
it does not create another website supervisor. The owner first selects an
existing private broker configuration with durable storage and **admission**
resource policies. It is not generated from an employee request.

```bash
broker_config="$HOME/reverie/runtime/worker-isolation/broker.json"
nix run .#worker-service -- --config "$broker_config" check
nix run .#worker-service -- --config "$broker_config" install
nix run .#worker-service -- --config "$broker_config" start
nix run .#worker-service -- status
nix run .#worker-service -- logs --lines 100
nix run .#worker-service -- stop
nix run .#worker-service -- uninstall
```

The first command checks ordinary-owner Linux, the local Unix-socket engine,
cgroup-v2 RAM/no-swap/PID capability, finite admission policies, host/website
headroom and private durable roots. Unknown or unsupported capability refuses;
there is no unlimited or privileged fallback. Docker Desktop and remote engine
transports are not supported by this host-proc/cgroup backend. Read-only declared
capability is not installed acceptance: independently verify actual kernel limits,
exact mounts and the approved image/security profile after installation.

`install` writes the owner-private config selection, links the exact packaged
unit, retains its transitive Nix closure with a durable owner GC root, and enables
it **without starting it**. It refuses an active broker, a foreign
unit or a different retained config selection; preserve and review those instead
of silently replacing them. `start` repeats capability checks. The same checks run
in the existing unit's `ExecStartPre`, including at login/boot, without waiting on
the target starting them. An empty cleaned disposable root can be recreated
privately on the next laptop creation; missing durable state refuses. Broker start can
recover existing running laptops, but does not wake stopped employees. Stopping
the broker interrupts viewers/phones and needs ordinary coordinated transport
maintenance. Stop/uninstall remain possible when the engine is unavailable.
Uninstall removes only the recognized service link and its service GC root, leaving private configuration,
homes, stores and intent intact. No engine socket or host key is given to a laptop.

Both multi-user Nix (root-owned store files) and ordinary single-user Nix
(owner-owned store files) are supported. The exact packaged unit path remains
pinned and group/world-writable or foreign-owned units are refused. Private
configuration paths preserve spaces, UTF-8 names and literal backslashes; startup
must use the same installed selection that passed validation.

Broker login/linger semantics match other user units. Laptop containers themselves
deliberately have no blind restart policy. Preserve employee OFF/vacation settings
through install, boot and diagnostics. Starting a website or passing a Nix/SSH/
Docker diagnostic is not permission to start a paid model conversation. Normal
same-conversation recovery requires the current owner intent and authorization.

Use project flakes (`nix develop`, `nix build`, `nix run`) first, `nix shell` for
temporary tools and `nix profile install` for persistent tools. Keep the base lean.
Private home/settings and `/nix`, durable projects and retained results survive
recreation; `/tmp/<project>` build/cache/download data are disposable. See
[laptop storage](portable-laptop-storage.md) and the handbook for storage boundaries.
