# Plan burn: realtime rate, per-agent attribution and plan-move impact

The Plans page shows each plan's weekly burn rate as a least-squares slope of weekly-percent samples over the last
6 hours (`plan-pace.ts`, one sample per 5 minutes), with the five-hour window drawn beside it. That rate is steady but
slow. A change in who works on a plan takes hours to show, and it says nothing about which agents cause the burn or what
moving one of them would do. This note adds three things on top of the existing chart:

1. a near-realtime rate per plan,
2. burn per agent, and
3. before a plan move, the projected end-of-window usage of the plan being left and the plan being joined.

## Data source

Every Claude Code session that Reverie launches runs the Reverie status-line exporter, which POSTs the full status-line
payload to `/api/status-telemetry` with the session id on every render (that is, after each assistant message). The
payload already carries:

- `cost.total_cost_usd`: that session's cumulative API-equivalent cost. It weights input, output and cache tokens the
  way the provider prices them, so it is a better proxy for plan consumption than raw token counts.
- `rate_limits.five_hour` and `rate_limits.seven_day`: the account's used percentages and resets.

The route already resolves which plan account a report belongs to (the session's profile, or its `CLAUDE_CONFIG_DIR`
override). Today it keeps only the latest limits per account and drops the cost.

New stored data, `plan-agent-cost-history.json` next to `plan-usage-history.json`:

- per session: `{ at, accountId, cost }` cumulative-cost samples, at most one per minute per session, kept 26 hours
  (enough for a 24-hour accuracy check);
- the existing per-account `UsageSample` gains optional `fiveHour` and `fiveHourResetAt` fields, so the five-hour
  percentage is kept too (older samples without them still load).

Sessions map to employees through the company record (`sessionId`). A session that is not an employee is still
attributed by its own name. Codex has no per-session cost in its telemetry, so Codex plans keep today's plan-level rate,
and their agents are listed without a per-agent rate until a source exists.

## Rolling windows

Two windows, because the two quantities change at different speeds:

- **Agent cost rate**, `cr_a` in USD per hour: the least-squares slope of session `a`'s cumulative cost over the last
  **30 minutes**. It needs at least 2 samples spanning 10 minutes or more. A drop in cumulative cost means the session
  restarted, so only the run after the last drop is used, exactly as `burnRate` already treats a weekly reset. An agent
  with no report in the window has rate 0, because it is idle.
- **Plan conversion**, `c_P` in weekly points per work unit (see below), fitted over the existing **6 hour** window.

## Work units and per-plan conversion

Agents are measured in a plan-independent **work unit**: one USD of API-equivalent cost, as the session's status line
reports it. The same work burns plans differently. A 20x plan moves about a quarter as far per unit as a 5x plan, and a
Claude plan differs from a Codex plan. So each plan `P` has its own conversion factor `c_P`, in weekly points per work
unit, that is learned rather than assumed:

- **Prior by provider and tier.** `c = base / multiple`. `base` is a per-provider guess for a 1x plan (Pro or Plus),
  currently 1 weekly point per unit, about 100 units a week, for both providers. `multiple` is 1, 5 or 20. Profiles have
  no tier field yet, so the tier is read from the plan label (`20x`, `5x`, `Max` → 5x, `Pro`/`Plus` → 1x). The prior is
  log-normal: a factor of 3 either way for a known tier, and a factor of 4.5 around 5x when the tier is unknown.
- **Online update.** Each time the plan is read, the observation is the plan's weekly rise divided by its sessions'
  summed cost rise. It uses the last 6 hours of the current week, or everything kept this week when that is too little,
  with at least 2 points of rise and 1 unit of cost. The observation is combined with the prior by precision weighting in
  log space, so a factor-of-two error counts the same in both directions. Its variance is the rounding of whole-percent
  readings, `(0.7 / rise)²`, plus a 0.25 model spread for cache and model mix. The result is the posterior median with a
  one-sigma band (`low`, `high`) and its basis, `prior` or `learned`.
- **Uncertainty shown.** The Plans card shows the factor with its band and basis. The realtime rate and every move
  estimate carry the band.

## Per-agent burn and the realtime plan rate

- Agent burn: `b_a = c_P × cr_a` weekly points per hour (and `c5_P × cr_a` five-hour points per hour), plus its share
  `cr_a / Σ cr` of the plan's reported cost rate.
- Realtime plan rate: `r_P = c_P × Σ_{a on P} cr_a`, shown beside the existing 6-hour slope.
- Other usage: if `P` also burns from sessions that do not report (someone's own laptop, a Codex CLI, the web UI),
  `c_P` absorbs it. The realtime rate stays right, but per-agent burn is then slightly overstated for every agent on `P`.
  The page shows the 6-hour slope next to `r_P`. When two plans share a tier, comparing their `c` values exposes this.
  Pooling `c` across plans of one tier is a follow-up.

## Plan-move impact

For agent `a` moving from plan `P` to plan `Q`, assuming it keeps its current cost rate:

```
r_P' = max(0, r_P − c_P·cr_a)            r_Q' = r_Q + c_Q·cr_a
weekly_P(end) = min(100, used_P + r_P'·H_P)        weekly_Q(end) = min(100, used_Q + r_Q'·H_Q)
five_P(end)   = min(100, five_P + r5_P'·H5_P)      five_Q(end)   = min(100, five_Q + r5_Q'·H5_Q)
```

`H` is the hours to that plan's existing budget stop: the earlier of the banked-reset expiry and the weekly reset, as
`plan-pace.ts` computes it. `H5` is the hours to its five-hour reset. Each side also reports the run-out time when its
projection passes 100, and the before values (without the move) for comparison. Every plan has a factor: a plan with no readings yet uses its provider and tier prior, so a move to a fresh plan, or across providers, is still estimated, just with the prior's wider band. `moveImpact` returns that band for both ends (`endAfterLow`, `endAfterHigh`).

The API is `GET /api/plans/move-impact?session=<id>&to=<account id>`, for the owner or an agent with plans.view_all, like
`/api/plans`. Each side's rate now is the plan's realtime rate when its sessions report cost, otherwise its 6-hour slope,
otherwise 0 for a plan with no data, and `rateBasis` says which. The plan-move dialog shows the result for the chosen
destination: the first estimate when the form opens, then a fresh one whenever the destination changes. A late answer
for an earlier choice is ignored, and a missing estimate never blocks the move. The Plans page lists each plan's agents
with their burn.

## Accuracy check

The estimates are checked against what actually happened, from the stored history, with no new probes:

0. **Fit error, shown now.** Each plan's factor comes with its hourly fit over the same 6 hours, `fit: { maePerHour,
   biasPerHour, n }`. For every hour, the factor times the reporting sessions' cost is compared with the plan's observed
   weekly rise. It is in-sample, because the same readings update the factor. A clearly negative bias means the plan
   rises faster than its reporting sessions explain: there is other usage on the account.

1. **Rate backtest.** For each plan and each sample time `t` over the last 24 hours, predict `weekly(t + 60 min)` from
   `weekly(t)` plus 1 hour times the rate, both for the realtime rate and the 6-hour slope. Compare with the reading
   actually taken then. The Plans API reports the mean absolute error of each (`burnCheck: { realtime, steady, n }`),
   so it is visible whether the faster rate is also the more accurate one.
2. **Move check.** For each completed plan move in the move history, compare the predicted rate changes on both plans
   with the observed change: the realtime rate 15 to 75 minutes after the move minus the 60 minutes before. The error
   is shown with that move in "Recent plan moves".
3. **Unit tests** with synthetic histories cover the slope windows, restart drops, missing conversions, period changes,
   the move formulas and the backtest.

## Status of the first slice

In this change: per-session cost samples from the status line (`plan-agent-cost-history.json`); the 30-minute agent
cost rate; the per-plan factor with its provider and tier prior, update from the plan's own readings and band; per-agent
burn and the realtime plan rate on `/api/plans` rows and the board's plan burn, shown on each Claude plan card; and
`moveImpact`, its route `GET /api/plans/move-impact` and its display in the plan-move dialog; and each factor's hourly fit error against the plan's own
readings.

Remaining:

1. The five-hour side: store five-hour percent in the usage samples and add `c5_P`.
2. Persisting the factor's posterior across windows and restarts. Today each read recomputes it from the kept history.
3. An explicit tier field on subscription profiles instead of reading the label.
4. The out-of-sample accuracy report (`burnCheck`) and the per-move check. The in-sample hourly fit is already shown.
5. A work-unit source for Codex sessions (no per-session cost today).
6. Pooling factors across plans of one tier.

## Not in scope

There is no automatic plan switching, no change to the existing weekly projection or recommendations, and no new
provider polling.
