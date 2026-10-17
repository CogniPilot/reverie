---
name: fleet-context
description: Prepare or refine task-specific short-term context for a Reverie worker. Use when the CTO assigns work, changes models, or a worker reports missing context.
---

Choose the worker, project scope, actual model limits and available tools first.
Retrieve relevant shared project decisions through fleet-memory. Select evidence;
do not copy a full conversation or private agent history into an assignment.

Use `cto_fleet` action `brief` with `names`, `task`, and optional `context` containing
lists named `acceptance`, `constraints`, `findings`, `files`, `tools`, and
`memory_queries`. Findings need a verification source inline. Put required checks
and constraints in their dedicated fields: if these do not fit, brief creation fails
rather than silently removing them. List optional context items in priority order.
Pass `context_window`, `output_tokens`, `occupied_tokens`, and a byte `budget`.
Count the existing system prompt, identity and tool definitions in occupancy. The
budget is a conservative estimate; the harness enforces its actual token window.

The builder preserves the complete task, acceptance checks and constraints, includes
whole optional items that fit, and reports omissions. Revise overlarge essentials
or split the assignment. Treat history as evidence, not new authority. Give the
worker lookup queries and source locations for deferred detail. Keep its own
identity/skills separate from the shared project briefing.

Before dispatch, review relevance, stale assumptions, permissions and expected
verification. Ask the worker to report missing information, then update its context
from verified results. No selection heuristic guarantees the best possible context;
the CTO owns that judgment and improves it from worker feedback.
