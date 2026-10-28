# Company timezone

The owner selects an IANA timezone under **Company → Timezone**, for example `America/New_York`. Daylight-saving transitions follow the selected zone automatically. The setting is stored through the existing owner-authorized company settings route.

Chat clocks, agent attention summaries and trusted per-employee context, assignment deadlines, plan reset/run-out displays, plan CLI output and plan-request expiry notices use that setting. Human-facing timestamps include their zone abbreviation. Existing message bodies and quoted external timestamps remain as originally written. Agent context asks future replies to use the selected zone; it does not rewrite arbitrary prose.

Storage, reset instants, elapsed durations and machine JSON timestamps stay canonical epoch/UTC data. Assignment replies accept either the original `Z` timestamp or an explicit offset such as `2026-11-01T01:30:00-04:00`; a bare local clock is refused because the repeated autumn hour can be ambiguous.

Company research/backup/archive clocks already use this company setting. The timezone control now explains that relation. Existing scheduled jobs with their own explicit timezone keep that recurrence and are not rewritten. Choosing a different display zone does not move a provider reset instant or grant execution/resource authority.

Until authorized settings load, the browser uses an explicitly labelled UTC fallback. Saving a timezone refreshes visible chat clocks and open plan views. Invalid zones are refused by company settings; display helpers fall back to UTC for unavailable or malformed older metadata.

Source/unit checks do not establish installation or real-browser acceptance. The running deployment must contain the new source and the owner must select the desired setting.
