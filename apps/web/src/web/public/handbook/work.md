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

Use task-specific `/tmp/<task>` for temporary builds, disposable checkouts, caches and regenerable downloads. Check shared disk capacity before heavy work. Temporary storage may be wiped: recreate and verify source revisions, input hashes and tools each run. Use normal project commands and provided defaults. See [Laptop storage](/handbook/laptops) for the full rule.

Keep unique data, unpushed or uncommitted work, cited evidence, results and one-attempt latches durable. Configuration, credentials and installed tools stay outside disposable roots. Save and verify a handoff before cleanup; remove task-owned registered outputs after sealing. Registration, names and gitignore alone do not prove disposability. Respect live leases; protect sockets and runtime state. Never move a cache in use or a live socket by hand.

Owners may select another drive through deployment configuration or a mount. On the host, derive paths from HOME.

Use leased task workspaces:

```bash
reverie-workspaces --root "/tmp/<task>/tasks" create check
reverie-workspaces --root "/tmp/<task>/tasks" run check -- your-command
reverie-workspaces --root "/tmp/<task>/tasks" finish check --handoff 'Saved results and handoff location'
reverie-workspaces --root "/tmp/<task>/tasks" clean check
```

Replace `<task>` with a task-specific name and replace `your-command`. Use the same task-specific `/tmp` root on a native host. `run` holds a lease, sets temporary build paths and changes into task scratch; keep durable source in its repository.

`clean` previews first. An authorized administrator may add `--apply` after reviewing it. A live lease or source checkout blocks cleanup. Preserve unfinished work, save a handoff and leave other tasks' data alone. Automatic global pruning is not implemented.

See [Office laptops](/handbook/laptops) and [Recovery](/handbook/recovery).
