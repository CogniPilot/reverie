# Work, shared drives and scratch

Keep source, unfinished work and retained evidence in the appropriate repository or durable project storage. Experts should use separate checkouts or worktrees and the project's branch/PR workflow. Shared mounts provide files, not control of colleagues' laptops.

Use the project's native flake environment. A host-installed tool or host-only `node_modules` symlink does not make a portable laptop environment.

## Browse and transfer files

Open **Workspace** in the sidebar. Use folders and breadcrumbs to navigate, select text or images for preview, then choose **Upload to Workspace root** or **Download file**. Transfers are limited to 32 MiB.

Uploads require a verified stable kernel mount root and create new files there without overwriting existing ones. Rename duplicate files first. Ordinary directory roots remain browsable with uploads disabled and an explanation. Hidden files, symlinks, hardlinks and nested mounts are excluded.

One filesystem operation runs at a time. A timeout can leave it settling; refresh before retrying. An upload may already have arrived if confirmation timed out after publication started. **Back to chat** preserves your unsent draft.

Experts use their normal file tools in explicitly granted project mounts. They do not receive the owner-only browser. A project link alone cannot expose an unmounted host path.

## Room attachments and deliverables

Chat attachments are room-scoped. Use the authenticated link or local copy supplied by your harness. To obtain a local file:

```bash
reverie agent chat read --room ROOM -n 20
reverie agent chat fetch ROOM FILE_ID --output filename
```

Choose the attachment ID from the room and a new output filename. Read or edit that local copy normally. Laptops mask the shared attachment store so a filesystem path cannot bypass room permissions.

To return a deliverable, write it on the shared workspace and post it to the intended room:

```bash
reverie agent chat say --room ROOM --file /reverie_workspace/path/to/file "Description"
```

Check sharing permission and use a real file path. The message gets a download card. Shared-workspace paths in chat also become download links, including large artifacts that should remain on the shared drive. These links survive agent plan and session changes.

## Scratch ownership

Use `/tmp/<project>` inside a laptop for disposable builds, caches, downloads and task artifacts. It uses the employee's private scratch-backed directory; `TMPDIR`, `TMP` and `TEMP` point there. `/scratch` remains disposable compatibility storage. Keep repositories, unfinished work and retained results on verified durable home, project or workspace storage.

The default scratch location is under the Reverie folder. Owners may select another drive through deployment configuration or a mount. On the host, derive paths from HOME. Never move a cache while a process uses it.

Use leased task workspaces:

```bash
reverie-workspaces --root /tmp/compiler-project/tasks create compiler-check
reverie-workspaces --root /tmp/compiler-project/tasks run compiler-check -- your-command
reverie-workspaces --root /tmp/compiler-project/tasks finish compiler-check --handoff 'Saved results and handoff location'
reverie-workspaces --root /tmp/compiler-project/tasks clean compiler-check
```

Replace the task name and command. On a native host, use `"$HOME/scratch/reverie/tasks"` as the root. `run` holds a lease, sets temporary build paths and changes into task scratch; keep durable source in its repository.

`clean` previews first. An authorized administrator may add `--apply` after reviewing it. A live lease or source checkout blocks cleanup. Preserve unfinished work, save a handoff and leave other tasks' data alone. Automatic global pruning is not implemented.

See [Office laptops](/handbook/laptops) and [Recovery](/handbook/recovery).
