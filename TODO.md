# Reverie installation and live testing

Updated as work is tested and deployed. Existing backups must remain intact.

## Running now

- [x] Fresh Nix-built Docker container at http://127.0.0.1:3000.
- [x] Owner authorization enforced; the welcome screen lets a new owner choose their username and permanent password directly.
- [x] Persistent company data and tool home under `~/reverie/companies/default/`.
- [x] Work under `~/reverie/workspace/`; scratch links to the large build disk.
- [x] Explicit writable source mount at `/workspace`; no Docker socket exposed.
- [x] Configurable crash-recovery expert identified by persistent agent ID, with a recovery prompt and explicit permissions.

## Finish and deploy

- [x] Fix GPU visibility: host RTX 3090 telemetry is published and visible in the running app.
- [x] Mount host GPU telemetry read-only into the container.
- [x] Deploy single-screen owner login; owner password and two-factor settings retained across replacement.
- [x] Prompt for the owner's display name on first use; preserve the existing profile editor.
- [x] Install pinned Claude and Codex CLIs into persistent user storage at startup; both verified signed in after replacement.
- [x] Finish OpenCode CLI installation compatibility; all three provider commands verified runnable, with no provider CLIs distributed in the image.
- [x] Replace the existing-session hiring picker with plan, model, effort and harness selection; deployed for owner testing.
- [x] Surface local model endpoint selection with compatible owner-configured harnesses.
- [x] Add a way to delete a workspace/channel grouping while preserving channels and messages.
- [x] Keep Unicode profile icons with a curated picker; uploaded photos or original portraits override the icon and can be cleared.
- [x] Show provider sign-in status independently from usage data, including Claude.
- [ ] Enable and exercise the host rebuild request service, including replacement, persisted settings and rollback.
- [ ] Start with no placeholder provider plans and allow removing unused default plans.
- [ ] Let additional humans register and appear alongside agents in company people, with explicit roles and permissions.
- [x] Deploy the consolidated root skills and removal of legacy console Docker/plugin packaging.
- [ ] Finish first-run bootstrap checks: editable deployment defaults, source/config access off by default, multiple mounts supported.
- [x] Actual Ubuntu CI passed Nix builds, login, persistence and crash restart for `6bff236`; rerun browser-first signup checks for the next commit.
- [x] Verify no generated caches, credentials or private instance data are committed.

## Machine cleanup requiring ordinary host activation

- [ ] Activate the prepared NixOS cleanup to remove system Podman and the legacy dedicated account. Config evaluates; host administrator authentication is required.
- [ ] Inspect and unmount the old loop-mounted deployment data without deleting its backing image or backups.
- [x] Remove task validation containers, their images and volumes; archive inactive validation-engine metadata.

## Deferred

- [ ] Owner-managed PAT grants to selected persistent agent IDs.
- [ ] Further Python-to-TypeScript migration.
- [ ] Restore old agents and files only after the fresh-install trial, when requested.
