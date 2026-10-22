---
name: reverie-runtime
description: Switch or restart an agent's Reverie runtime while preserving its identity, memories and handoff. Use for model/provider changes or recovery of a failed CTO runtime.
---

Read the Reverie skill before managing sessions. The selected instance, external runtime policy and private state must already be configured. Container sudo grants no host sudo or additional API authority. Model choice uses the owner's enabled backend catalogue and actual subscription capacity; it never purchases capacity or changes weights.

Save the current task, decisions, source/test receipts, blockers and next action in durable memory first. Keep the handoff concise. Preserve the same agent instance and private/project scope across backends. Load the reverie-memory skill in the replacement; use that backend's context budget rather than copying a whole transcript.

`reverie-runtime --policy /path/to/private/runtime-policy.json switch BACKEND --handoff 'saved handoff receipt and current state'` creates a candidate through Reverie's supported API. `reboot --handoff '...'` creates a candidate using the current backend. `status` shows its exact session id. The controller persists the handoff before creation and stops on an ambiguous response; inspect Reverie before clearing an uncertain creation.

Read the candidate's current screen using `reverie agent read ID --tail 80`. When its composer is ready, use `reverie agent send ID 'Read the instance rules, reverie-memory skill, current self-model, plan and saved handoff. Verify continuity before taking work.'` Follow the Reverie skill's readiness rules. Do not type blind Enter into an approval, sign-in or trust dialog.

Verify its memory instance, tools, model, current task and chat membership. Transfer the room's lead role using the authority Reverie actually grants. If appointment is owner-only, report the blocker and keep the original runtime; never impersonate the owner or bypass an API refusal. Then run `activate ID`. Only after a verified handoff should the controller close the exact old session with Reverie's guarded normal CLI. Never delete yourself or another worker's workspace.

A separately configured Python watcher can run `reverie-runtime ... watch`. It creates a local OpenCode fallback after a reported abnormal pane exit, with at most three attempts per fifteen minutes. A pending handoff or uncertain creation blocks further spawns. A clean exit, explicit owner pause file or deleted session must not be treated as a crash. Idle alone is healthy. Approval/sign-in dialogs need attention, not automatic acceptance or a new runtime to evade them. This first watcher provisions a recovery candidate; verification and role handoff remain required before activation.

The control policy and controller state belong outside the shared repository. Keep the host controller's state and code outside writable agent mounts if it has additional authority. Do not include credentials in command arguments, public handoffs, images or logs. Alert the owner/CTO through the configured private channel when automatic recovery stops.

Local GPU keep-alive is configured with `keep_alive.model_api_url` and `model_id`
matching the fallback provider, optional `api_key_env`, and bounded poll/probe intervals.
Run `reverie-runtime ... local-health` before relying on recovery. A catalogue response
is not an inference test. The operator owns model-server startup and GPU access.
After recovery, inspect actual provider usage and enabled profiles before upgrading;
configuration alone does not establish subscription capacity. Save a new handoff and
continue locally if no stronger backend is available.
