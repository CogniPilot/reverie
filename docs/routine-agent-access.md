# Agent routine access
An authenticated employee may reach the exact cron job routes used by the routine
CLI. Reaching a route is not a routine-authoring grant: the existing handler still
checks the owner's routine grants, the stored employee author, room membership,
post-only action, interval/text/author limits and successful change notification.
No permission, job or bot is created by installing this change.

The owner continues to manage bots, bot room allowlists/caps and routine grants.
Service tokens cannot enter routine routes as owner authors. Arbitrary cron paths
remain owner-classified; agent attempts to create, edit, enable, run or remove
launch jobs remain refused, as do post-to-launch conversions and foreign edits.
An employee's existing read projection remains unchanged: own routines are complete;
all-listing and foreign job/run reads expose only the existing metadata allowlist.

Release integration: apply the reviewed patch to the exact release source and retain
the existing owner-auth policy, routine grants and instance data. Run the new
routines-owner-middleware test together with existing auth/routine suites (the new
test is included in the Nix package check list). Use the ordinary independently
reviewed release path; this patch installs no timer, supervisor or default routine.

After rollout, an authorized scoped CLI can run:
```sh
reverie routine list --json
```
This read does not create a job or confer a grant. An empty list means no own jobs,
not permission to create them. If authoring is refused, ask the owner to inspect
the current explicit routine permission; do not add an automatic role/person grant.
Keep owner-only grant/bot routes and denied launch/foreign-edit checks in acceptance.

Rollback uses the preceding verified website release through the same reviewed
release mechanism, preserving routine jobs, grants, authors and accounts. The old
middleware may again refuse agent routine access; it does not require deleting jobs
or changing permissions. No worker recreation or account migration is needed.
