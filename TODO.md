# Reverie installation and live testing

Updated as work is tested and deployed. Existing backups must remain intact.

## Running now

- [x] Fresh Nix-built Docker container at http://127.0.0.1:3000.
- [x] Owner authorization enforced; the welcome screen lets a new owner choose their username and permanent password directly.
- [x] Persistent company data and tool home under `~/reverie/companies/default/`.
- [x] Work under `~/reverie/workspace/`; scratch links to the large build disk.
- [x] Dedicated container working directory at `/reverie_workspace`; an explicit `reverie` symlink grants access to the chosen checkout at `/projects/reverie`. No default checkout mount or Docker socket.
- [x] Configurable crash-recovery expert identified by persistent agent ID, with a recovery prompt and explicit permissions.

## Finish and deploy

- [x] Fix GPU visibility: host RTX 3090 telemetry is published and visible in the running app.
- [x] Mount host GPU telemetry read-only into the container.
- [x] Deploy single-screen owner login; owner password and two-factor settings retained across replacement.
- [x] Prompt for the owner's display name on first use; preserve the existing profile editor.
- [x] Install pinned Claude and Codex CLIs into persistent user storage at startup; both verified signed in after replacement.
- [x] Finish OpenCode CLI installation compatibility; all three provider commands verified runnable, with no provider CLIs distributed in the image.
- [x] Update installed Codex to 0.163.0 and Claude Code to 2.1.308; verify native startup, updater suppression, project trust and preservation of existing account configuration.
- [x] Guard managed provider launches against concurrent installation and stale binaries; keep npm globals on persistent writable storage and retry transient Claude availability checks after fifteen seconds.
- [x] Replace the existing-session hiring picker with plan, model, effort and harness selection; deployed for owner testing.
- [x] Surface local model endpoint selection with compatible owner-configured harnesses.
- [x] Add a way to delete a workspace/channel grouping while preserving channels and messages.
- [x] Deploy the original illustrated avatar pack for experts and humans, company logos (including Lucid Eye), uploaded photos, and initials as fallback.
- [x] Compact avatar chooser with a random hiring default, working initials, and saving for disconnected experts.
- [x] Show provider sign-in status independently from usage data, including Claude.
- [ ] Enable and exercise the host rebuild request service, including replacement, persisted settings and rollback.
- [x] Fix Codex launch and recovery compatibility; retain retired experts without waking them.
- [x] Add confirmed retirement and reversible vacation controls for experts, using in-app confirmation dialogs.
- [x] Start with no placeholder provider plans and allow removing unused default plans.
- [x] Refresh hiring plan choices immediately after account changes without resetting the profile draft.
- [x] Preserve the owner account across replacement and refuse expired API sessions without the browser's Basic-auth popup.
- [x] Combine Company plans and people into one page; compact repeated Company/Board headers.
- [x] Optional pronouns and persistent voice selection with playable samples in hire/profile forms; Kokoro service packaging remains below.
- [x] Simplify the member popover, keep wake controls on member status, and add confirmed expert restart controls.
- [x] Refine medium-sized plan cards, remove plot labels, and replace the legacy research/settings panel.
- [x] Left-click an expert to edit runtime Plan, Harness (including registered custom harnesses), Model and Effort; validate compatibility and preserve identity, memories, photos and room membership.
- [x] Restore Alex's exact saved Codex runtime as stopped and pinned, ready for an explicit owner restart; preserve retired experts.
- [x] Add a compact disk gauge with capacity details for company data, workspace and scratch mounts.
- [x] Improve disk-bar contrast with a dark track and capacity warning colors.
- [x] Save the default workspace name from its profile using the canonical server setting.
- [x] Request plan moves through expert handoff and approval, with a pending destination avatar and durable private audit; retain the source until the replacement is ready.
- [x] Initialize built-in embassy hosting and provide inline setup for a reachable HTTPS address; preserve legacy external hosting.
- [x] Document private Tailscale Serve access on HTTPS 443 and cleanup of stale routes in the README.
- [x] Verify a complete Claude conversation through the managed harness in an isolated selected-plan fixture, independently of provider sign-in and usage retrieval.
- [x] Prepare selected Claude profiles for first launch without changing their chosen permission mode; verify credentials-only hiring, an owner mention and a stored assistant reply without manual terminal setup.
- [ ] Let additional humans register and appear alongside agents in company people, with explicit roles and permissions.
- [x] Deploy the consolidated root skills and removal of legacy console Docker/plugin packaging.
- [x] Verify editable deployment defaults, source/config access off by default, and explicit project mounts with workspace links. Launcher and legacy recovery checks pass.
- [x] Ubuntu CI passed the provider update at `8feee24`; deployed `b87dca1` passed 1,304 web, 553 Python and 36 Node tests and a 99-layer scan with no findings. Repeat CI after making the reply-guard test await its asynchronous relay deterministically.
- [x] Verify no generated caches, credentials or private instance data are committed.

## Machine cleanup requiring ordinary host activation

- [ ] Activate the prepared NixOS cleanup to remove system Podman and the legacy dedicated account. Config evaluates; host administrator authentication is required.
- [ ] Inspect and unmount the old loop-mounted deployment data without deleting its backing image or backups.
- [x] Remove task validation containers, their images and volumes; archive inactive validation-engine metadata.

## Organization cleanup

- [x] Main application lives in `apps/web`; Nix, CI and documentation paths follow the layout.
- [ ] Gradually split the large server and browser modules by feature, migrating browser JavaScript to TypeScript.

## Next hiring experience

- [x] Hire opens a four-step role, person, work and review wizard from the People + button, with Cancel on every step. Profiles retain editable role, duties and personality; model and effort stay in the later runtime editor.
- [ ] Detailed generic role briefs and skill profiles, including CTO/COO templates with editable explicit authority presets; emphasize evidence, responsibilities and uncertainty rather than omniscience.
- [ ] Share templates and validation with an agent-callable hiring API enforcing Can hire, allowed plans and grant limits.
- [x] Verify explicitly delegated template hiring under enforced owner sign-in, including bounded session creation, CLI activation, account and parent inheritance, fresh grant checks and rollback on startup failure.
- [ ] One canonical employee profile page with permission-based editing, shared by hiring and later edits.
- [ ] Owner/admin/moderator/member defaults; plan Use and Manage grants remain separate from server roles and are editable during hiring.
- [ ] Curated editable name/avatar/Kokoro voice tags as soft randomization preferences; avoid duplicate names and preset photos within a company.
- [x] Randomizable, editable personality and working style; detailed role duties reach ordinary agent conversations as profile context. Further interest/tag curation remains below.
- [x] Dream and Sleep opt-in checkboxes on employee cards, hiring and profile editing, off by default, with explanatory tooltips. These permit scheduled work without starting an independent nightly timer.
- [ ] Agents can request Sleep as a Gantt task. A coordinator with explicit scheduling permission (such as the appointed COO/CTO) fits it around company work; record requests, approval and the scheduled window.
- [x] Nix-managed Kokoro-ONNX service with contained, checksum-verified model storage; expert profiles list installed voices, retain selections independently of pronouns and play real sample previews. Startup does not delay the web server.
- [x] Native Codex/Claude plan moves work between providers, infer the destination harness and use destination model defaults, while retaining handoff approval, identity, memories and channel memberships. Custom harness migration adapters remain separate work.
- [ ] After cross-provider moves: restore the saved local Qwen setup for Jinx using Nix. Check existing GGUF weights and the model service first, then repair container connectivity or explicitly selected GPU compute access; retain her identity and recovered memories.

## Deferred

- [ ] Generate a custom expert avatar from a description; explicitly deferred until the core site is working.

- [ ] Owner-managed PAT grants to selected persistent agent IDs.
- [ ] Further Python-to-TypeScript migration.
- [ ] Restore old agents and files only after the fresh-install trial, when requested.
