# Permissions and saved preferences

Titles describe duties. Only owner-selected grants authorize tools; this handbook grants nothing. Run `reverie agent capabilities` for current authenticated grants, reasons, commands and credential references before claiming a blocker. See [Capabilities, deployments and credentials](/handbook/operations).

## Board

Open **Company → People → click name or avatar → Edit profile**. Offline experts remain editable. Reporting dropdowns and drag/drop change hierarchy, not permissions.

- **Update own board work** permits triage filing, updates to the expert's own cards, and their wins and focus.
- **Manage company board** permits editing and reassigning everyone's cards, milestones, blockers and schedules. It includes own work, whose checkbox stays checked and disabled.
- **Prepare decision cards** permits preparing, annotating and dismissing decisions and poll notes. It never permits choosing the owner's answer. Creating choices also requires the site's separate decision-write setting.

Existing experts inherit the previous policy: basic contributions allowed; active owner-appointed channel coordinators may manage boards and prepare decisions. Controls show effective access and inherited choices. Opening Company writes nothing. Changing a checkbox saves an explicit choice; unchecked management or decision grants override inherited coordination. Titles and briefing-coordinator selection grant no access.

For read-only board access, disable management, own work and decision preparation. History remains. New hires default to explicit own-work access, with management and decisions off unless the owner chooses otherwise. Human roles remain separate; only authenticated owners manage grants and choose owner answers.

## Recovery and plans

**Recover employees** permits scoped employee wake. Website restart is a separate host-maintainer grant. Check current records rather than titles or old messages.

**Move own plan** permits self move requests; **Manage team plans** permits colleague requests. Both require the affected expert's handoff and approval. Neither grants provider sign-in or account administration.

These grants also allow explicit self refresh on the same account with `plan-move request ACCOUNT_ID --restart`. Refresh remains self-only, with one-time approval and safe handoff. It grants no installation, arbitrary session creation or vacation wake.

## Publication credentials

Profile **Publication credentials** checkboxes grant named PAT downloads independently. They save immediately without changing identity or owner access.

**Manage PATs** adds names, descriptions and declared repositories, replaces values or deletes entries. Values are write-only password fields, never listed or prefilled. Repository declarations express intent; GitHub enforces actual token scope and repository access.

Removing access prevents new downloads; previously copied tokens must be revoked or rotated at GitHub. Local deletion is not GitHub revocation. Checked **Unavailable PAT** grants remain removable; opening the profile never clears them automatically.

## Sleep and Dream

Sleep permits memory consolidation; Dream permits creative exploration. They are eligibility preferences, not startup commands or nightly timers. Scheduling needs an explicit owner or authorized scheduler decision; the scheduling connection is not implemented. Dream output is an idea, not verified evidence.

## Saving

**Permission checkboxes save immediately**. Wait for confirmation. Failure restores the previous effective value and shows an error. Each save patches only its field. Opening or saving other profile details never converts inherited permissions into explicit grants.

**Profile details and Sleep / Dream require Save profile.** Cancel discards their drafts, not already confirmed permission changes. Runtime, office status, restart and retirement remain separate actions with their own confirmations.

Older releases require **Save preferences** after checking boxes; verify confirmation before leaving. To verify current grants, reopen Company or read GET /api/company. Report errors and actual records if values differ. Agents cannot grant themselves access or override owner choices with documentation.

See [Recover a stuck expert](/handbook/recovery).

**Hire requests.** An agent the owner listed as a hire delegate can ask for a hire with `reverie agent hire-request submit <template>`: name, position, reporting line, rooms, harness, plan and reason. Nothing is hired until the owner chooses **Approve and hire** under Company → Hire requests; the hire then runs as the owner, with every limit checked again. Decline closes a request, and the delegate can withdraw its own.
