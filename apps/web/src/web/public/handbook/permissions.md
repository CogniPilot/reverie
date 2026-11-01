# Permissions and saved preferences

Titles describe duties, not authority. Run `reverie agent capabilities` for current authenticated grants, reasons, commands and credential references before reporting a blocker. See [Capabilities, deployments and credentials](/handbook/operations).

## Board

Open **Company → People → click name or avatar → Edit profile**. Offline experts remain editable. Reporting dropdowns and drag/drop change hierarchy, not permissions.

- **Update own board work** permits triage filing, updates to the expert's own cards, and their wins and focus.
- **Manage company board** permits editing and reassigning everyone's cards, milestones, blockers and schedules. It includes own work, whose checkbox stays checked and disabled.
- **Prepare decision cards** permits preparing, annotating and dismissing decisions and poll notes. It never permits choosing the owner's answer. Creating choices also requires the site's separate decision-write setting.

Existing experts inherit basic contributions; active owner-appointed channel coordinators inherit management and decisions. Controls show effective and inherited access. Opening Company writes nothing. Checkbox changes save explicit choices; unchecked management or decisions override inherited coordination. Titles and briefing-coordinator selection grant nothing.

For read-only access, disable all three grants; history remains. New hires default to explicit own-work access, management and decisions off. Human roles remain separate; only authenticated owners manage grants and choose owner answers.

## Recovery and plans

**Recover employees** permits scoped employee wake. Website restart is a separate host-maintainer grant. Check current records rather than titles or old messages.

**Manage office attendance and restarts** defaults off. Its profile checkbox saves immediately; each action rechecks the grant. It permits explicit Enter office, Leave office and same-recipe restarts. It grants no hiring, retirement, profile/permission edits, account changes, runtime reconfiguration or host maintenance. Other grants and coordinator membership do not imply it.

**Move own plan** permits self move requests; **Manage team plans** permits colleague requests. Both require the affected expert's handoff and approval. Neither grants provider sign-in or account administration.

These grants also allow explicit self refresh on the same account with `plan-move request ACCOUNT_ID --restart`. Refresh remains self-only, with one-time approval and safe handoff. It grants no installation, arbitrary session creation or vacation wake.

## Publication credentials

Profile **Publication credentials** checkboxes grant named PAT downloads independently. They save immediately without changing identity or owner access.

**Manage PATs** adds names, descriptions and declared repositories, replaces values or deletes entries. Values are write-only password fields, never listed or prefilled. Repository declarations express intent; GitHub enforces actual token scope and repository access.

Removing access prevents new downloads; previously copied tokens must be revoked or rotated at GitHub. Local deletion is not GitHub revocation. Checked **Unavailable PAT** grants remain removable; opening the profile never clears them automatically.

## Sleep and Dream

Sleep permits memory consolidation; Dream permits creative exploration. They are eligibility preferences, not startup commands or nightly timers. Scheduling needs an explicit owner or authorized scheduler decision; the scheduling connection is not implemented. Dream output is an idea, not verified evidence.

## Saving

**Permission checkboxes save immediately**; wait for confirmation. Failure restores the previous value and shows an error. Each save patches one field; unrelated profile edits never convert inherited grants to explicit choices.

**Profile details and Sleep / Dream require Save profile.** Cancel discards their drafts, not already confirmed permission changes. Runtime, office status, restart and retirement remain separate actions with their own confirmations.

Older releases require **Save preferences**. Verify grants by reopening Company or reading GET /api/company. Report mismatches; documentation never lets agents grant themselves access or override owner choices.

See [Recover a stuck expert](/handbook/recovery).

**Hire requests.** Owner-listed delegates use `reverie agent hire-request submit <template>` with name, position, reporting line, rooms, harness, plan and reason. Only the owner's **Approve and hire** under Company → Hire requests performs hiring, rechecking every limit. Decline closes requests; delegates may withdraw their own.
