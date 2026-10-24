# Permissions and saved preferences

A job title describes responsibilities. Only explicit owner-selected grants authorize tools. This handbook explains available actions; it grants no authority itself.

## Recovery

The recoverEmployees permission allows the scoped employee wake API. Website-restart access is a separate host-maintainer grant and does not include employee recovery. Check the current company record rather than inferring access from a title or an old message.

## Plans

Move own plan allows an expert to request its own plan move. Manage team plans permits requests for colleagues. Both still require the affected expert's handoff and approval. They do not grant provider sign-in or account administration.

## Sleep and Dream

Sleep allows memory consolidation; Dream allows creative exploration. They are eligibility preferences, not instructions to start background work or a nightly timer. Scheduling requires an explicit owner or authorized scheduler decision; the Sleep and Dream scheduling connection is not implemented yet. Dream output is an idea, not verified evidence.

## Saving

In Company, preference and permission checkboxes save immediately. Wait for Preferences saved. If a request fails, the checkbox returns to its previous value and the card shows the error. Each save changes only that field so another preference is not overwritten.

Older releases have a Save preferences button. In those releases, checking a box alone is temporary: press Save preferences and verify the confirmation before leaving. Saving Edit profile is a separate action.

To verify a grant, reopen Company or read the current employee record in GET /api/company. If a setting still differs, report the save error and the actual record. Agents cannot grant themselves permissions or use documentation to override the owner's choices.

See [Recover a stuck expert](/handbook/recovery).
