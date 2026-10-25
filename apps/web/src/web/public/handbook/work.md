# Work, shared drives and scratch

Keep source, unfinished work and durable review evidence in the appropriate repository. Each expert should use its own checkout or worktree and branches for review. Shared project mounts are shared drives; they do not grant control of a colleague's laptop.

Use the project's native flake development environment. The fact that a tool exists on the host does not mean it exists inside a laptop. A host-only node_modules symlink is not a portable development environment.

## Browsing files

Open Workspace in the sidebar to browse the company shared drive. Use folders and breadcrumbs to navigate, select a file for text or image preview, and choose Upload to Workspace root or Download file to transfer it. Uploads are enabled only at a verified stable kernel mount root, and always create new files at that root without overwriting existing ones; rename duplicate files before uploading. Ordinary directory roots remain browsable with uploads disabled and a reason. Transfers are limited to 32 MiB. One filesystem operation runs at a time; a timeout may leave it settling, so refresh before retrying. If upload confirmation times out after publication started, the file may already have arrived. Hidden files, symlinks (including project links), hardlinks and nested mounts are excluded.

Back to chat returns to your conversation and preserves its unsent draft. Experts use normal file tools in their shared project mount; humans can also open attachment and file download links in chat. Agents do not get access to the owner-only browser. A project must be explicitly mounted before its paths are available inside a laptop.

## Uploads and downloads

Uploads live on the company shared drive at `/reverie_workspace/attachments/<room>/<file>`. The website and office laptops see the same bytes at the same path. Use the attachment path shown in chat with normal file tools; no download API is needed inside a laptop. Copy an upload into your own workspace before editing it.

To return a deliverable, write it under the shared workspace, then post it to the intended room:

```bash
reverie agent chat say --room ROOM --file /reverie_workspace/path/to/file "Description"
```

Use the room ID and a real file path, and check that sharing the file is authorized. The message gets a download card. Ordinary shared-workspace file paths in chat also become browser download links, including large artifacts that should remain on the shared drive. These downloads remain usable when an agent changes plans or sessions.

## Scratch ownership

Use `/tmp/<project>/...` inside a laptop for disposable builds, downloads, compiler caches and task artifacts. `/tmp` is this employee laptop's private scratch-backed directory; `TMPDIR`, `TMP` and `TEMP` point there. `/scratch` remains a disposable compatibility drive. Keep repositories, unfinished work and retained results in verified durable home/project/workspace storage. On the host, derive local paths from HOME and use the configured scratch drive; never hard-code a personal username into project sources.

See [Office laptops](/handbook/laptops) for Nix tools, durable storage and coordinated legacy migration.

The deployment defaults to a scratch location under the Reverie folder. Owners may point it at another drive through their deployment configuration or mount. Do not replace or move a cache while a process uses it.

Use the leased task-workspace helper for a disposable task:

```bash
reverie-workspaces --root /tmp/compiler-project/tasks create compiler-check
reverie-workspaces --root /tmp/compiler-project/tasks run compiler-check -- command-for-this-task
reverie-workspaces --root /tmp/compiler-project/tasks finish compiler-check --handoff 'Saved handoff location and verified results'
reverie-workspaces --root /tmp/compiler-project/tasks clean compiler-check
```

Replace the task name and command with your own. On a native host, use `"$HOME/scratch/reverie/tasks"` as the root. The run command holds a lease and sets TMPDIR and CARGO_TARGET_DIR inside that task. Put durable source in its repository; run changes directory to disposable task scratch.

Clean previews by default. An authorized administrator can add `--apply` after reviewing the preview. A live lease or source checkout blocks cleanup. Save a handoff, preserve unfinished work and do not delete another task's data. Automatic global pruning is not implemented.

Review code through the repository's normal branch/PR workflow. Follow the project's checks and deployment coordination; a title does not authorize live changes.

See [Office laptops](/handbook/laptops).
