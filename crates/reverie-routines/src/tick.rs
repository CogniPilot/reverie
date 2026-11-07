//! One routines tick: status rounds (report only), wake-up and wind-down calls, retro and kickoff.

use crate::console::Console;
use crate::json::{self, Json};
use crate::ledger::{self, Ledger, Obs};
use crate::policy::{Agent, Policy, Quota, Routines, is_agent_name};
use jiff::civil::{Date, DateTime, Time, Weekday};
use jiff::{Timestamp, Zoned};

/// Two observations from the 5-minute ticks.
const DOWN_OBSERVATIONS: i64 = 2;
/// Seconds between the first and the confirming observation.
const DOWN_MIN_SPAN: f64 = 240.0;
/// F6: an observation more than 3 ticks after the previous one starts over.
const DOWN_MAX_GAP: f64 = 900.0;
/// A wind-down call is still useful this long after it was due.
const WIND_DOWN_VALID: i64 = 30 * 60;
/// F1/F4: seconds without pane activity before a call (beyond one 30 s dialog scan).
const QUIET_BEFORE_CALL: f64 = 60.0;
const CYCLE_POLICY_MAX: u64 = 64 * 1024;
const CALL_KINDS: [&str; 2] = ["wind_down", "wake"];
const ROUTINE_KINDS: [&str; 3] = ["retro", "retro_compile", "kickoff"];

/// Fixed texts. Each is one printable ASCII line with no "!" (typed delivery would flip OpenCode into shell mode),
/// starting with the shared marker. The marker is unauthenticated (anyone can type it): it only ever lowers trust and
/// never proves who sent a line. The only inserted value is a host-computed integer.
pub fn template(kind: &str, minutes: i64) -> String {
    let marker = |name: &str| format!("[automated - not the owner - routine {name}]");
    match kind {
        "wind_down" => format!(
            "{} Your sleep window starts in {minutes} min. Park the current task, save a handoff, and start no new long jobs.",
            marker("wind-down")
        ),
        "wake" => format!(
            "{} Good morning. Read your handoff and your unread rooms, then post your status in your room.",
            marker("wake")
        ),
        "retro" => format!(
            "{} Daily retro, max 10 lines in one message to your coordinator in your room: (1) went well, (2) went poorly, \
             including your own mistakes, (3) concrete improvements for tomorrow.",
            marker("retro")
        ),
        "retro_compile" => format!(
            "{} Compile today's retro replies and your own into one summary for the owner, max 15 lines, each point \
             attributed to its lead and labelled unverified (self-reports). Post it to the owner's room; name leads who did \
             not reply.",
            marker("retro-compile")
        ),
        _ => format!(
            "{} Morning kickoff: list the carry-overs from yesterday's handoffs and retro, then today's top 3, and post it \
             to the owner's room.",
            marker("kickoff")
        ),
    }
}

/// `datetime.timestamp()`: whole microseconds as a float, as python's datetime holds them.
pub fn seconds(t: Timestamp) -> f64 {
    // Exact: timestamps in microseconds stay far below 2**53.
    #[allow(clippy::cast_precision_loss)]
    let micros = t.as_microsecond() as f64;
    micros / 1e6
}

fn micros(t: Timestamp) -> i64 {
    t.as_microsecond()
}

/// Inside the agent's sleep window (the window may wrap past midnight).
fn asleep(agent: &Agent, local: &Zoned) -> bool {
    let now = local.time();
    if agent.start < agent.end {
        agent.start <= now && now < agent.end
    } else {
        now >= agent.start || now < agent.end
    }
}

/// Seconds since the session's last pane activity, or None when the console did not say (F4).
fn quiet_seconds(session: &Json, now: Timestamp) -> Option<f64> {
    Some(seconds(now) - session.get("lastActivityAt")?.number()? / 1000.0)
}

fn live(session: &Json) -> bool {
    let status = session.get("status").and_then(Json::as_str);
    !matches!(status, Some("stopped" | "error"))
        && !session.get("paneExit").is_some_and(Json::truthy)
}

fn str_is(value: Option<&Json>, expected: &str) -> bool {
    value.and_then(Json::as_str) == Some(expected)
}

fn busy(session: &Json) -> bool {
    str_is(session.get("status"), "busy") || session.get("isWorking").is_some_and(Json::truthy)
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Unknown,
    Down,
    Moved,
    Renamed,
    Dialog,
    Busy,
    Ok,
}

/// The state from the status fields only; pane and dialog text are never read beyond "present".
fn observe<'a>(sessions: &'a Json, agent: &Agent) -> (State, Option<&'a Json>) {
    let Json::List(list) = sessions else {
        return (State::Unknown, None);
    };
    if list.is_empty() || !list.iter().all(|s| matches!(s, Json::Obj(_))) {
        return (State::Unknown, None); // an empty or malformed list never means "everyone is down"
    }
    let pinned: Vec<&Json> = list
        .iter()
        .filter(|s| str_is(s.get("id"), &agent.session_id))
        .collect();
    if pinned.len() > 1 {
        return (State::Unknown, None);
    }
    if pinned.is_empty() || !live(pinned[0]) {
        let moved = list.iter().any(|s| {
            str_is(s.get("name"), &agent.session)
                && !str_is(s.get("id"), &agent.session_id)
                && live(s)
        });
        return (if moved { State::Moved } else { State::Down }, None);
    }
    let session = pinned[0];
    if !str_is(session.get("name"), &agent.session) {
        return (State::Renamed, None);
    }
    if session.get("paneDialog").is_some_and(Json::truthy) {
        return (State::Dialog, Some(session));
    }
    if busy(session) {
        return (State::Busy, Some(session));
    }
    (State::Ok, Some(session))
}

/// F1/F4: a call goes only into a pinned, correctly named, idle, dialog-free pane that has been quiet long enough for
/// the console's 30 s dialog scan to have caught a new prompt.
fn callable_now(session: Option<&Json>, agent: &Agent, now: Timestamp) -> bool {
    let Some(session @ Json::Obj(_)) = session else {
        return false;
    };
    if !str_is(session.get("id"), &agent.session_id) || !str_is(session.get("name"), &agent.session)
    {
        return false;
    }
    if !live(session) || session.get("paneDialog").is_some_and(Json::truthy) || busy(session) {
        return false;
    }
    quiet_seconds(session, now).is_some_and(|q| q >= QUIET_BEFORE_CALL)
}

fn finite_number(v: Option<&Json>) -> Option<f64> {
    v?.number().filter(|f| f.is_finite())
}

/// True when the plan profile is readable, fresh and below 100 - reserve in every window. Anything else is false:
/// the quota gate fails closed (skip the routine), never open.
fn plan_open(value: &Json, quota: &Quota, now: Timestamp) -> bool {
    let Some(Json::List(accounts)) = value.get("accounts") else {
        return false;
    };
    let Some(reading) = accounts
        .iter()
        .find(|a| matches!(a, Json::Obj(_)) && str_is(a.get("id"), &quota.profile))
    else {
        return false;
    };
    let now = seconds(now);
    let Some(updated) = finite_number(reading.get("updatedAt")) else {
        return false;
    };
    #[allow(clippy::cast_precision_loss)]
    let max_age = quota.max_age as f64;
    if !str_is(reading.get("status"), "ready")
        || !(0.0..=max_age).contains(&(now - updated / 1000.0))
    {
        return false;
    }
    let Some(usage @ Json::Obj(_)) = reading.get("usage") else {
        return false;
    };
    let windows: Vec<&Json> = ["fiveHour", "sevenDay"]
        .iter()
        .filter_map(|k| usage.get(k))
        .filter(|w| **w != Json::Null)
        .collect();
    if windows.is_empty() {
        return false;
    }
    #[allow(clippy::cast_precision_loss)]
    let ceiling = (100 - quota.reserve) as f64;
    windows.iter().all(|w| {
        matches!(w, Json::Obj(_))
            && match (
                finite_number(w.get("usedPercentage")),
                finite_number(w.get("resetAt")),
            ) {
                (Some(used), Some(reset)) => reset / 1000.0 > now && used < ceiling,
                _ => false,
            }
    })
}

/// Read an agent-writable file without following links, blocking or reading without bound (F3).
fn read_capped(path: &str) -> Option<String> {
    use std::os::unix::fs::OpenOptionsExt;
    let info = std::fs::symlink_metadata(path).ok()?;
    if !info.file_type().is_file() || info.len() > CYCLE_POLICY_MAX {
        return None;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.file_type().is_file() {
        return None;
    }
    let mut data = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(file, CYCLE_POLICY_MAX + 1),
        &mut data,
    )
    .ok()?;
    if data.len() as u64 > CYCLE_POLICY_MAX {
        return None;
    }
    String::from_utf8(data).ok()
}

fn hhmm_text(t: Time) -> String {
    format!("{:02}:{:02}", t.hour(), t.minute())
}

/// Differences from the night cycle's policy. A mismatch is reported and the host policy still rules, because a
/// file agents can edit must never be able to switch routines off.
fn cycle_mismatches(policy: &Policy) -> Vec<String> {
    let Some(path) = policy.cycle_policy.as_deref().filter(|p| !p.is_empty()) else {
        return Vec::new();
    };
    let Some(cycle @ Json::Obj(_)) = read_capped(path).and_then(|text| json::parse(&text).ok())
    else {
        return vec!["cycle_policy_unreadable".into()];
    };
    let empty = Json::Obj(Vec::new());
    let (Some(night @ Json::Obj(_)), agents @ Json::Obj(_)) =
        (cycle.get("night"), cycle.get("agents").unwrap_or(&empty))
    else {
        return Vec::new();
    };
    let mut found = Vec::new();
    if !str_is(cycle.get("timezone"), &policy.timezone) {
        found.push("timezone".into());
    }
    for agent in &policy.agents {
        let Some(entry @ Json::Obj(_)) = agents.get(&agent.name) else {
            continue;
        };
        let start = entry.get("night_start").or_else(|| night.get("start"));
        if !str_is(start, &hhmm_text(agent.start))
            || !str_is(night.get("end"), &hhmm_text(agent.end))
        {
            found.push(agent.name.clone());
        }
    }
    found
}

pub struct Tick<'a> {
    p: &'a Policy,
    state: &'a Ledger,
    console: &'a Console,
    sink: &'a mut dyn FnMut(&str),
    now: Timestamp,
    live: bool,
    paused: bool,
    local: Zoned,
    day: String,
    plan_open: Option<bool>,
    first_tick: f64,
}

type Due = (&'static str, Zoned, i64);

/// What this tick saw of one agent.
struct Seen<'s> {
    session: Option<&'s Json>,
    sleeping: bool,
}

/// The counter, cap and gate of one kind of timed send.
#[derive(Clone, Copy)]
struct Rule<'r> {
    counted: &'r [&'r str],
    cap: i64,
    quota: bool,
}

impl<'a> Tick<'a> {
    pub fn new(
        p: &'a Policy,
        state: &'a Ledger,
        console: &'a Console,
        sink: &'a mut dyn FnMut(&str),
        now: Timestamp,
        flags: (bool, bool),
    ) -> ledger::Result<Tick<'a>> {
        let local = now.to_zoned(p.zone.clone());
        let day = local.date().to_string();
        let first = state.meta("first_tick")?.filter(|f| !f.is_empty());
        let first_tick = first
            .as_deref()
            .and_then(|f| f.trim().parse::<f64>().ok())
            .unwrap_or_else(|| seconds(now));
        if first.is_none() {
            state.set_meta("first_tick", &ledger::meta_float(first_tick))?;
        }
        Ok(Tick {
            p,
            state,
            console,
            sink,
            now,
            live: flags.0,
            paused: flags.1,
            local,
            day,
            plan_open: None,
            first_tick,
        })
    }

    fn ts(&self) -> f64 {
        seconds(self.now)
    }

    fn report(&mut self, code: &str, agent: &str, value: i64) {
        let offset = self.local.offset().seconds();
        let sign = if offset < 0 { '-' } else { '+' };
        let (h, m, s) = (
            offset.abs() / 3600,
            offset.abs() / 60 % 60,
            offset.abs() % 60,
        );
        let mut zone = format!("{sign}{h:02}:{m:02}");
        if s != 0 {
            zone.push_str(&format!(":{s:02}"));
        }
        let line = format!(
            "routines-report v1 {}T{:02}:{:02}{zone} {code} {agent} {value}{}",
            self.local.date(),
            self.local.hour(),
            self.local.minute(),
            if self.live { "" } else { " dry-run" }
        );
        (self.sink)(&line);
    }

    /// A report at most once per slot (ledger kind `report:<code>`).
    fn report_once(
        &mut self,
        code: &str,
        agent: &str,
        slot: &str,
        value: i64,
    ) -> ledger::Result<()> {
        if self.state.claim(
            &format!("report:{code}"),
            agent,
            slot,
            &self.day,
            self.ts(),
            "sent",
        )? {
            self.report(code, agent, value);
        }
        Ok(())
    }

    fn round_slot(&self) -> String {
        let minutes = i64::from(self.local.hour()) * 60 + i64::from(self.local.minute());
        format!("{}#r{}", self.day, minutes / self.p.every)
    }

    pub fn run(&mut self) -> ledger::Result<()> {
        self.state
            .set_meta("heartbeat", &ledger::meta_float(self.ts()))?;
        match self.console.sessions() {
            Ok(sessions @ Json::List(_)) if sessions != Json::List(Vec::new()) => {
                for agent in &self.p.agents {
                    self.agent(agent, &sessions)?;
                }
            }
            _ => {
                // Unknown for everyone: no sends, and every down streak starts over (F6).
                for agent in &self.p.agents {
                    self.reset_down(&agent.name, false)?;
                }
                let hour = self
                    .now
                    .to_zoned(jiff::tz::TimeZone::UTC)
                    .strftime("%Y-%m-%dT%H")
                    .to_string();
                self.report_once("console_unknown", "-", &hour, 0)?;
            }
        }
        self.cron_count()?;
        // F3: the agent-writable cycle policy is read last, non-blocking and capped, and is report-only.
        let day = self.day.clone();
        for mismatch in cycle_mismatches(self.p) {
            let agent = if is_agent_name(&mismatch) {
                mismatch.as_str()
            } else {
                "-"
            };
            self.report_once("policy_mismatch", agent, &day, 0)?;
        }
        Ok(())
    }

    fn agent(&mut self, agent: &Agent, sessions: &Json) -> ledger::Result<()> {
        let (state, session) = observe(sessions, agent);
        let name = agent.name.as_str();
        match state {
            State::Unknown => {
                self.reset_down(name, false)?;
                let slot = self.round_slot();
                return self.report_once("unknown", name, &slot, 0);
            }
            State::Moved | State::Renamed => {
                // F5: never follow a name to another id. The owner re-pins the policy after checking.
                self.reset_down(name, false)?;
                let day = self.day.clone();
                return self.report_once(
                    if state == State::Moved {
                        "moved"
                    } else {
                        "renamed"
                    },
                    name,
                    &day,
                    0,
                );
            }
            _ => {}
        }
        self.track_down(name, state == State::Down)?;
        if state == State::Down {
            return Ok(());
        }
        self.track_dialog(name, state == State::Dialog)?;
        let sleeping = asleep(agent, &self.local);
        let seen = Seen { session, sleeping };
        self.calls(agent, &seen)?;
        self.routines(agent, &seen)?;
        if sleeping {
            return Ok(());
        }
        let slot = self.round_slot();
        if state == State::Dialog {
            let minutes = self.dialog_minutes(name)?;
            if minutes >= self.p.dialog_minutes {
                self.report_once("dialog", name, &slot, minutes)?;
            }
            return Ok(());
        }
        let quiet = session.and_then(|s| quiet_seconds(s, self.now));
        #[allow(clippy::cast_precision_loss)]
        let stall = (self.p.stall_minutes * 60) as f64;
        if let Some(quiet) = quiet.filter(|q| state == State::Busy && *q >= stall) {
            // F1: report only. A busy pane with no output may be an unflagged permission dialog.
            #[allow(clippy::cast_possible_truncation)]
            self.report_once("stalled", name, &slot, (quiet / 60.0).floor() as i64)?;
        }
        Ok(())
    }

    fn reset_down(&mut self, name: &str, report: bool) -> ledger::Result<()> {
        let obs = self.state.obs(name)?;
        if report && obs.down_reported != 0 {
            self.report("recovered", name, 0);
        }
        if obs.down_since.is_some() {
            self.state.set_obs(
                name,
                Obs {
                    down_since: None,
                    down_last: None,
                    down_count: 0,
                    down_reported: 0,
                    ..obs
                },
            )?;
        }
        Ok(())
    }

    /// Down is confirmed by two observations at least DOWN_MIN_SPAN apart, each within DOWN_MAX_GAP of the previous
    /// one, then reported once. R1 never restarts.
    fn track_down(&mut self, name: &str, down: bool) -> ledger::Result<()> {
        if !down {
            return self.reset_down(name, true);
        }
        let (mut obs, ts) = (self.state.obs(name)?, self.ts());
        let (Some(since), Some(last)) = (obs.down_since, obs.down_last) else {
            return self.restart_down(name, obs, ts);
        };
        if ts - last > DOWN_MAX_GAP {
            return self.restart_down(name, obs, ts);
        }
        obs.down_count += i64::from(ts - last >= 60.0);
        obs.down_last = Some(ts);
        self.state.set_obs(name, obs)?;
        if obs.down_reported == 0
            && obs.down_count >= DOWN_OBSERVATIONS
            && ts - since >= DOWN_MIN_SPAN
        {
            obs.down_reported = 1;
            self.state.set_obs(name, obs)?;
            #[allow(clippy::cast_possible_truncation)]
            self.report("down", name, ((ts - since) / 60.0).floor() as i64);
        }
        Ok(())
    }

    fn restart_down(&self, name: &str, obs: Obs, ts: f64) -> ledger::Result<()> {
        self.state.set_obs(
            name,
            Obs {
                down_since: Some(ts),
                down_last: Some(ts),
                down_count: 1,
                down_reported: 0,
                ..obs
            },
        )
    }

    fn track_dialog(&self, name: &str, dialog: bool) -> ledger::Result<()> {
        let obs = self.state.obs(name)?;
        if dialog && obs.dialog_since.is_none() {
            self.state.set_obs(
                name,
                Obs {
                    dialog_since: Some(self.ts()),
                    ..obs
                },
            )?;
        } else if !dialog && obs.dialog_since.is_some() {
            self.state.set_obs(
                name,
                Obs {
                    dialog_since: None,
                    ..obs
                },
            )?;
        }
        Ok(())
    }

    fn dialog_minutes(&self, name: &str) -> ledger::Result<i64> {
        #[allow(clippy::cast_possible_truncation)]
        Ok(self
            .state
            .obs(name)?
            .dialog_since
            .map_or(0, |since| ((self.ts() - since) / 60.0).floor() as i64))
    }

    /// `datetime.combine(day, at, zone) + minutes`: wall-clock arithmetic, then the zone (fold 0: the earlier of two
    /// readings, the offset before a gap).
    fn at(&self, day: Date, at: Time, minutes: i64) -> Zoned {
        let wall = DateTime::from_parts(day, at);
        let wall = wall
            .checked_add(jiff::Span::new().minutes(minutes))
            .unwrap_or(wall);
        wall.to_zoned(self.p.zone.clone())
            .unwrap_or_else(|_| self.local.clone())
    }

    /// Yesterday, today and tomorrow in the policy zone.
    fn days(&self) -> [Date; 3] {
        let today = self.local.date();
        [
            today.yesterday().unwrap_or(today),
            today,
            today.tomorrow().unwrap_or(today),
        ]
    }

    fn calls(&mut self, agent: &Agent, seen: &Seen<'_>) -> ledger::Result<()> {
        if !agent.calls {
            return Ok(());
        }
        let mut dues = Vec::new();
        for day in self.days() {
            dues.push((
                day,
                (
                    "wind_down",
                    self.at(day, agent.start, -self.p.wind_down_before),
                    WIND_DOWN_VALID,
                ),
            ));
            dues.push((
                day,
                (
                    "wake",
                    self.at(day, agent.end, self.p.wake_after),
                    self.p.wake_retry * 60,
                ),
            ));
        }
        let rule = Rule {
            counted: &CALL_KINDS,
            cap: self.p.calls_per_day,
            quota: false,
        };
        for (day, due) in dues {
            self.slot(agent, seen, day, due, rule)?;
        }
        Ok(())
    }

    /// The routine sends due to one agent on one day: retro (each lead, staggered), retro-compile and kickoff,
    /// weekdays only when the policy says so.
    fn routine_dues(&self, r: &Routines, name: &str, day: Date) -> Vec<Due> {
        if r.weekdays_only && matches!(day.weekday(), Weekday::Saturday | Weekday::Sunday) {
            return Vec::new();
        }
        let mut out = Vec::new();
        if let Some(retro) = &r.retro {
            // The compiler gets no separate retro line: its own retro is folded into the compile line.
            let lead = retro
                .leads
                .iter()
                .position(|l| l == name)
                .filter(|_| name != retro.compiler);
            if let Some(index) = lead {
                let offset = i64::try_from(index).unwrap_or(0) * r.stagger;
                out.push(("retro", self.at(day, retro.at, offset), retro.valid * 60));
            }
            if name == retro.compiler {
                out.push((
                    "retro_compile",
                    self.at(day, retro.at, retro.compile_after),
                    retro.valid * 60,
                ));
            }
        }
        if let Some(kickoff) = r.kickoff.as_ref().filter(|k| k.to == name) {
            out.push(("kickoff", self.at(day, kickoff.at, 0), kickoff.valid * 60));
        }
        out
    }

    /// Fixed host texts, idle-only delivery, their own counter and the quota gate.
    fn routines(&mut self, agent: &Agent, seen: &Seen<'_>) -> ledger::Result<()> {
        let Some(r) = self.p.routines.as_ref() else {
            return Ok(());
        };
        let mut dues = Vec::new();
        for day in self.days() {
            dues.extend(
                self.routine_dues(r, &agent.name, day)
                    .into_iter()
                    .map(|due| (day, due)),
            );
        }
        let rule = Rule {
            counted: &ROUTINE_KINDS,
            cap: self.p.routines_per_day,
            quota: true,
        };
        for (day, due) in dues {
            self.slot(agent, seen, day, due, rule)?;
        }
        Ok(())
    }

    fn plan_is_open(&mut self) -> bool {
        if self.plan_open.is_none() {
            let open = match (self.console.plan_usage(), &self.p.quota) {
                (Ok(value), Some(quota)) => plan_open(&value, quota, self.now),
                _ => false,
            };
            self.plan_open = Some(open);
        }
        self.plan_open == Some(true)
    }

    /// One shared rule for every timed send, and one generic sleep guard: nothing is ever sent to an agent inside its
    /// sleep window, whatever the kind.
    fn slot(
        &mut self,
        agent: &Agent,
        seen: &Seen<'_>,
        day: Date,
        due: Due,
        rule: Rule<'_>,
    ) -> ledger::Result<()> {
        let (kind, at, valid) = due;
        let name = agent.name.as_str();
        let slot = format!("{kind}@{day}");
        let age = micros(self.now) - micros(at.timestamp());
        if !(0..86_400_000_000).contains(&age) || self.state.has(kind, name, &slot)? {
            return Ok(());
        }
        if age >= valid * 1_000_000 {
            // Never delivered in its window: recorded once, never sent late. A slot due before this ledger's first
            // tick is recorded quietly (no report noise on a first run).
            self.state
                .claim(kind, name, &slot, &self.day, self.ts(), "missed")?;
            if seconds(at.timestamp()) >= self.first_tick {
                self.report(&format!("{kind}_missed"), name, 0);
            }
            return Ok(());
        }
        if seen.sleeping || !callable_now(seen.session, agent, self.now) {
            return Ok(());
        }
        if rule.quota && !self.plan_is_open() {
            // Fail closed, but defer: a later tick inside the window may still send it, else it ends missed.
            return self.report_once(&format!("{kind}_deferred_quota"), name, &slot, 0);
        }
        let text = template(kind, self.p.wind_down_before);
        self.deliver(kind, agent, &slot, &text, rule)
    }

    /// Claim the ledger row, check the cap, re-check the one session, then send. Nothing is sent without a written
    /// row. A failed re-check leaves the row 'deferred', so a later tick may retry inside the call's window; nothing
    /// was typed, so a flapping agent is never hammered.
    fn deliver(
        &mut self,
        kind: &str,
        agent: &Agent,
        slot: &str,
        text: &str,
        rule: Rule<'_>,
    ) -> ledger::Result<()> {
        let name = agent.name.as_str();
        if self.paused {
            return self.report_once("paused_skip", name, slot, 0);
        }
        if self.state.count(rule.counted, name, &self.day)? >= rule.cap {
            let cap_slot = format!("{kind}:{}", self.day);
            return self.report_once("cap_reached", name, &cap_slot, 0);
        }
        let status = if self.live { "pending" } else { "dry" };
        if !self
            .state
            .claim(kind, name, slot, &self.day, self.ts(), status)?
        {
            return Ok(());
        }
        if !self.live {
            self.report(&format!("{kind}_would_send"), name, 0);
            return Ok(());
        }
        if self.console.token.is_none() {
            self.state.finish(kind, name, slot, "failed")?;
            self.report("no_token", name, 0);
            return Ok(());
        }
        let fresh = self.console.session(&agent.session_id).ok();
        if !callable_now(fresh.as_ref(), agent, self.now) {
            return self.state.finish(kind, name, slot, "deferred");
        }
        if self.console.send(&agent.session_id, text).is_ok() {
            self.state.finish(kind, name, slot, "sent")?;
            self.report(&format!("{kind}_sent"), name, 0);
        } else {
            self.state.finish(kind, name, slot, "failed")?;
            self.report(&format!("{kind}_failed"), name, 0);
        }
        Ok(())
    }

    /// Count-only check: report when console cron jobs exist, daily, and at once when the number grows. Job
    /// definitions are never read beyond their count.
    fn cron_count(&mut self) -> ledger::Result<()> {
        let day = self.day.clone();
        let count = match self.console.cron_jobs() {
            Ok(count) => count,
            Err(_) => return self.report_once("cron_unknown", "-", &day, 0),
        };
        let previous: i128 = self
            .state
            .meta("cron_count")?
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        self.state.set_meta("cron_count", &count.to_string())?;
        let value = i64::try_from(count).unwrap_or(i64::MAX);
        if count > previous {
            self.report("cron_jobs_grew", "-", value);
        } else if count != 0 {
            self.report_once("cron_jobs", "-", &day, value)?;
        }
        Ok(())
    }
}
