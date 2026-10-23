# Models and plans

An expert's identity, memory and room membership are distinct from its selected model, harness and account. Changing a runtime can restart its CLI; wait for current work to finish first.

In the expert profile, open Runtime settings. Select a Plan, compatible Harness, Model and supported Effort, then apply and verify that the expert starts. Keep owner choices outside shareable project source.

A configured local-model endpoint appears alongside subscription plans. Its Company card shows model and shared hardware readings rather than a weekly subscription reset. GPU capacity and memory are shared; local inference does not have unlimited hardware capacity.

OpenCode can use an OpenAI-compatible endpoint through its environment configuration. Some harnesses require an isolated configuration directory; the in-place runtime-switch route may refuse those changes rather than overwrite credentials or configuration unsafely.

Agents with plan-move grants must follow the existing handoff and approval flow. Model choice does not grant provider sign-in or account administration. Never paste an endpoint API key into chat or a public handbook page.

Owner plan-move requests are queued as a private message immediately. The expert can run `reverie agent plan-move list` to find its own pending requests while working. Plans shows whether delivery is waiting for idle or the expert's handoff, with time left on the 30-minute request. A request never changes the plan by itself. Prepare a handoff, then use `reverie agent plan-move approve <id> --handoff-file <path>` or `reverie agent plan-move reject <id>`. The CLI reads the private credential; do not copy it into chat. Cancelled, expired or replaced-session requests cannot authorize a move.

See [Permissions](/handbook/permissions).
