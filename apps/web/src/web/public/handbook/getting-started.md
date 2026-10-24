# Getting started

Reverie is an office for persistent AI experts. The website holds conversations and company controls; each managed expert uses a separate [office laptop](/handbook/laptops) for tools. Roles describe responsibilities. [Permissions](/handbook/permissions) control what an expert may do.

## First visit

1. Open the address supplied by your operator. On a new installation, select Create account, choose a username and password, and confirm the password. Later visits use Sign in. Your display name is separate from your login username.
2. Open Plans, add a provider account and select Sign in to authorize it. Provider sign-in is separate from your Reverie login. Alternatively, choose an already configured local-model endpoint.
3. Open Company → People → Hire (also available as People +). Choose a role template, then review the expert's name, skills, responsibilities and working style.
4. Choose a plan or local endpoint and a compatible harness. Review reporting lines and explicit permissions before confirming the hire.
5. Open the expert's conversation, send a small task and wait for a reply. The expert should report actual results and any blocker. A busy badge alone does not prove progress.

Provider tools install on first start into persistent private storage. If installation fails, the operator can retry `reverie-install-clis` in a Reverie terminal once the network is available. Do not repeat hiring to fix a failed tool installation.

## Next steps

Use [Profiles and reporting lines](/handbook/profiles) to tune the role, [Models and plans](/handbook/models) to change its runtime, and [Work and scratch](/handbook/work) to share files. Enable [Optional chat plugins](/handbook/plugins) only when useful.

If an existing expert stops responding, follow [Recover a stuck expert](/handbook/recovery) before restarting the website. Installation, host mounts and image rollout remain operator tasks; the repository README and `docs/setup.md` describe those procedures.

## Bots and routines

Open **Bots** in the sidebar to see saved routines, enabled schedules, current scheduler executions, and recent outcomes. Running comes from the scheduler's live execution list. Unfinished history is shown separately, since an interrupted run may leave an old record. Filter by status or search by name or channel. The page refreshes every ten seconds while visible.

Choose **Set up a bot** to give a named sender its allowed channels and posting limit. **New routine** schedules a fixed message from that bot; new routines are saved disabled unless you enable them. **Advanced schedules** opens the existing editor for data sources and agent session jobs when you open Bots from chat.

In **Set up a bot** or **Edit bot**, use **Choose avatar** to pick from the built-in icon pack, or enter an emoji. Save bot to keep it. **Delete bot** removes an unused identity after confirmation; delete its linked routines first, including disabled ones.

Expand a routine's content to read its message, template, launch command, prompt or prompt-file reference. **Edit content** changes that saved definition; it does not edit a referenced file. **Delete routine** removes its schedule after confirmation. Recorded employee creators are shown by name; new owner-created routines show Owner, while older records without provenance say Not recorded.

**Disable schedule** pauses future scheduled runs. Manage an already launched agent through its session controls. Employee-authored routines remain subject to their explicit routine grants; setting up a bot grants no employee additional permissions.
