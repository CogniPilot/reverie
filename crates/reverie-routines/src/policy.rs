//! The owner's host policy, validated strictly: any error refuses the whole tick (fail closed).

use crate::json::{self, Json, py_repr};
use jiff::civil::Time;
use jiff::tz::TimeZone;
use std::path::Path;

/// Minutes a retro or kickoff must keep from any addressed agent's wind-down and wake.
pub const WINDOW_MARGIN: i64 = 30;

#[derive(Debug)]
pub struct PolicyError(pub String);

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn refuse<T>(message: impl Into<String>) -> Result<T, PolicyError> {
    Err(PolicyError(message.into()))
}

#[derive(Clone, Debug)]
pub struct Agent {
    pub name: String,
    pub session: String,
    pub session_id: String,
    pub start: Time,
    pub end: Time,
    pub calls: bool,
    pub lead: bool,
}

#[derive(Clone, Debug)]
pub struct Retro {
    pub at: Time,
    pub compiler: String,
    pub compile_after: i64,
    pub valid: i64,
    pub leads: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Kickoff {
    pub at: Time,
    pub to: String,
    pub valid: i64,
}

#[derive(Clone, Debug)]
pub struct Routines {
    pub stagger: i64,
    pub weekdays_only: bool,
    pub retro: Option<Retro>,
    pub kickoff: Option<Kickoff>,
}

#[derive(Clone, Debug)]
pub struct Quota {
    pub profile: String,
    pub reserve: i64,
    pub max_age: i64,
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub timezone: String,
    pub zone: TimeZone,
    pub every: i64,
    pub stall_minutes: i64,
    pub dialog_minutes: i64,
    pub wind_down_before: i64,
    pub wake_after: i64,
    pub wake_retry: i64,
    pub calls_per_day: i64,
    pub routines_per_day: i64,
    pub cycle_policy: Option<String>,
    pub agents: Vec<Agent>,
    pub routines: Option<Routines>,
    pub quota: Option<Quota>,
}

impl Policy {
    pub fn agent(&self, name: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.name == name)
    }
}

/// `[a-z][a-z0-9_-]{0,31}`.
pub fn is_agent_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// `[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}`.
fn is_session_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 40
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b' ' | b'.' | b'_' | b'-'))
}

/// `[A-Za-z0-9_-]{1,80}`.
pub fn is_session_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// `[A-Za-z0-9_.:-]{1,80}`.
fn is_profile(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
}

/// `([01][0-9]|2[0-3]):([0-5][0-9])` on python's `str(value)`; only a string can match.
fn hhmm(value: Option<&Json>, where_: &str) -> Result<Time, PolicyError> {
    let bad = || PolicyError(format!("{where_} must be HH:MM"));
    let s = value.and_then(Json::as_str).ok_or_else(bad)?.as_bytes();
    if s.len() != 5
        || s[2] != b':'
        || !s
            .iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit())
    {
        return Err(bad());
    }
    let hour = i8::try_from((s[0] - b'0') * 10 + (s[1] - b'0')).map_err(|_| bad())?;
    let minute = i8::try_from((s[3] - b'0') * 10 + (s[4] - b'0')).map_err(|_| bad())?;
    if s[0] > b'2' || hour > 23 || s[3] > b'5' {
        return Err(bad());
    }
    Time::new(hour, minute, 0, 0).map_err(|_| bad())
}

/// An integer (not a bool or float) in `low..=high`, or the default when absent.
fn bounded(
    section: &Json,
    key: &str,
    default: i64,
    low: i64,
    high: i64,
) -> Result<i64, PolicyError> {
    let message = || PolicyError(format!("{key} must be an integer from {low} to {high}"));
    match section.get(key) {
        None => Ok(default),
        Some(Json::Int(v)) if i128::from(low) <= *v && *v <= i128::from(high) => {
            i64::try_from(*v).map_err(|_| message())
        }
        Some(_) => Err(message()),
    }
}

/// Python's zoneinfo key rules: relative, already normalized, inside the zone directory.
fn valid_zone_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('/')
        && !key.contains('\0')
        && key
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

/// The zone by its IANA key: `TZDIR`, then the usual system directories, then the bundled database. As with python's
/// zoneinfo, the key is exact (case included) and must name a TZif file.
pub fn load_zone(key: &str) -> Option<TimeZone> {
    if !valid_zone_key(key) {
        return None;
    }
    let mut dirs: Vec<String> = std::env::var("TZDIR")
        .ok()
        .filter(|d| !d.is_empty())
        .into_iter()
        .collect();
    dirs.extend(
        [
            "/usr/share/zoneinfo",
            "/usr/lib/zoneinfo",
            "/usr/share/lib/zoneinfo",
            "/etc/zoneinfo",
        ]
        .map(String::from),
    );
    for dir in dirs {
        let file = Path::new(&dir).join(key);
        if file.is_file() {
            return std::fs::read(&file)
                .ok()
                .and_then(|bytes| TimeZone::tzif(key, &bytes).ok());
        }
    }
    let zone = jiff::tz::db().get(key).ok()?;
    (zone.iana_name() == Some(key)).then_some(zone)
}

fn read_policy_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| crate::py_os_error(&e, path))?;
    String::from_utf8(bytes).map_err(|e| {
        let at = e.utf8_error().valid_up_to();
        let byte = e.as_bytes()[at];
        format!("'utf-8' codec can't decode byte 0x{byte:02x} in position {at}: invalid utf-8")
    })
}

/// `load_policy(path)`.
pub fn load(path: &Path) -> Result<Policy, PolicyError> {
    let raw = read_policy_text(path)
        .and_then(|text| json::parse(&text).map_err(|e| e.to_string()))
        .map_err(|e| PolicyError(format!("cannot read policy {}: {e}", path.display())))?;
    if !matches!(raw, Json::Obj(_)) {
        return refuse("policy must be an object");
    }
    let timezone = raw.get("timezone").and_then(Json::as_str);
    let Some(zone) = timezone.and_then(load_zone) else {
        return refuse("timezone must be an IANA zone name");
    };
    let empty = Json::Obj(Vec::new());
    let section = |k: &str| raw.get(k).unwrap_or(&empty);
    let (coffee, calls, caps) = (section("coffee"), section("calls"), section("caps"));
    if ![coffee, calls, caps]
        .iter()
        .all(|s| matches!(s, Json::Obj(_)))
    {
        return refuse("coffee, calls and caps must be objects");
    }
    let mut policy = Policy {
        timezone: timezone.unwrap_or_default().to_string(),
        zone,
        every: bounded(coffee, "every_minutes", 120, 30, 720)?,
        stall_minutes: bounded(coffee, "stall_minutes", 30, 10, 240)?,
        dialog_minutes: bounded(coffee, "dialog_minutes", 10, 5, 240)?,
        wind_down_before: bounded(calls, "wind_down_minutes_before", 20, 5, 120)?,
        wake_after: bounded(calls, "wake_after_minutes", 15, 0, 120)?,
        wake_retry: bounded(calls, "wake_retry_minutes", 60, 5, 240)?,
        calls_per_day: bounded(caps, "calls_per_day", 2, 0, 2)?,
        routines_per_day: bounded(caps, "routines_per_day", 3, 0, 3)?,
        cycle_policy: None,
        agents: Vec::new(),
        routines: None,
        quota: None,
    };
    policy.agents = load_agents(raw.get("agents"))?;
    policy.cycle_policy = match raw.get("cycle_policy") {
        None | Some(Json::Null) => None,
        Some(Json::Str(s)) => Some(s.clone()),
        Some(_) => return refuse("cycle_policy must be a host path"),
    };
    policy.routines = load_routines(raw.get("routines"), &policy)?;
    policy.quota = load_quota(raw.get("quota"))?;
    if policy
        .routines
        .as_ref()
        .is_some_and(|r| r.retro.is_some() || r.kickoff.is_some())
        && policy.quota.is_none()
    {
        return refuse(
            "routines need a quota section (a retro or kickoff with no plan gate would run ungated)",
        );
    }
    Ok(policy)
}

fn load_agents(raw: Option<&Json>) -> Result<Vec<Agent>, PolicyError> {
    let entries = match raw {
        Some(Json::Obj(items)) if !items.is_empty() && items.len() <= 32 => items,
        _ => return refuse("agents must name 1-32 agents"),
    };
    let mut agents: Vec<Agent> = Vec::new();
    for (name, entry) in entries {
        if !is_agent_name(name) || !matches!(entry, Json::Obj(_)) {
            return refuse(format!("bad agent entry {}", py_repr(name)));
        }
        let session = entry
            .get("session")
            .and_then(Json::as_str)
            .filter(|s| is_session_name(s));
        let Some(session) = session else {
            return refuse(format!("{name}: session must be a plain session name"));
        };
        // F5: the target is the persistent session id; the name is only cross-checked.
        let session_id = entry
            .get("session_id")
            .and_then(Json::as_str)
            .filter(|s| is_session_id(s));
        let Some(session_id) = session_id else {
            return refuse(format!("{name}: session_id must be the session's id"));
        };
        if agents
            .iter()
            .any(|a| a.session == session || a.session_id == session_id)
        {
            return refuse(format!("{name}: session or session_id used twice"));
        }
        let Some(sleep @ Json::Obj(_)) = entry.get("sleep") else {
            return refuse(format!("{name}: sleep needs start and end"));
        };
        let start = hhmm(sleep.get("start"), &format!("{name}.sleep.start"))?;
        let end = hhmm(sleep.get("end"), &format!("{name}.sleep.end"))?;
        if start == end {
            return refuse(format!("{name}: sleep start and end must differ"));
        }
        let flag = |key: &str, default: bool| match entry.get(key) {
            None => Some(default),
            Some(Json::Bool(b)) => Some(*b),
            Some(_) => None,
        };
        let (Some(calls), Some(lead)) = (flag("calls", true), flag("lead", false)) else {
            return refuse(format!("{name}: calls and lead must be true/false"));
        };
        agents.push(Agent {
            name: name.clone(),
            session: session.into(),
            session_id: session_id.into(),
            start,
            end,
            calls,
            lead,
        });
    }
    Ok(agents)
}

pub fn minute_of(t: Time) -> i64 {
    i64::from(t.hour()) * 60 + i64::from(t.minute())
}

fn load_routines(raw: Option<&Json>, policy: &Policy) -> Result<Option<Routines>, PolicyError> {
    let raw = match raw {
        None | Some(Json::Null) => return Ok(None),
        Some(r @ Json::Obj(_)) => r,
        Some(_) => return refuse("routines must be an object"),
    };
    let stagger = bounded(raw, "stagger_minutes", 3, 0, 15)?;
    let weekdays_only = match raw.get("weekdays_only") {
        None => false,
        Some(Json::Bool(b)) => *b,
        Some(_) => return refuse("routines.weekdays_only must be true/false"),
    };
    let leads: Vec<String> = policy
        .agents
        .iter()
        .filter(|a| a.lead)
        .map(|a| a.name.clone())
        .collect();
    let who = |section: &Json, key: &str| match section.get(key) {
        Some(Json::Str(s)) if policy.agent(s).is_some() => Ok(s.clone()),
        _ => refuse(format!("routines: {key} must name a policy agent")),
    };
    let mut out = Routines {
        stagger,
        weekdays_only,
        retro: None,
        kickoff: None,
    };
    match raw.get("retro") {
        None | Some(Json::Null) => {}
        Some(retro @ Json::Obj(_)) if !leads.is_empty() => {
            out.retro = Some(Retro {
                at: hhmm(retro.get("at"), "retro.at")?,
                compiler: who(retro, "compiler")?,
                compile_after: bounded(retro, "compile_after_minutes", 45, 15, 120)?,
                valid: bounded(retro, "valid_minutes", 90, 15, 180)?,
                leads: leads.clone(),
            });
        }
        Some(_) => {
            return refuse("routines.retro needs an object and at least one lead: true agent");
        }
    }
    match raw.get("kickoff") {
        None | Some(Json::Null) => {}
        Some(kickoff @ Json::Obj(_)) => {
            out.kickoff = Some(Kickoff {
                at: hhmm(kickoff.get("at"), "kickoff.at")?,
                to: who(kickoff, "to")?,
                valid: bounded(kickoff, "valid_minutes", 120, 15, 180)?,
            });
        }
        Some(_) => return refuse("routines.kickoff must be an object"),
    }
    for (name, minute) in routine_times(&out) {
        let Some(agent) = policy.agent(&name) else {
            continue;
        };
        let quiet_from =
            (minute_of(agent.start) - policy.wind_down_before - WINDOW_MARGIN).rem_euclid(1440);
        let quiet_to = (minute_of(agent.end) + policy.wake_after + WINDOW_MARGIN).rem_euclid(1440);
        let inside = if quiet_from < quiet_to {
            quiet_from <= minute && minute < quiet_to
        } else {
            minute >= quiet_from || minute < quiet_to
        };
        if inside {
            return refuse(format!(
                "routines: a send to {name} at {:02}:{:02} falls in or near its sleep window",
                minute / 60,
                minute % 60
            ));
        }
    }
    Ok(Some(out))
}

/// `(agent, minute of day)` for every routine send, staggered leads included.
pub fn routine_times(routines: &Routines) -> Vec<(String, i64)> {
    let mut times = Vec::new();
    if let Some(r) = &routines.retro {
        let mut offset = 0;
        for lead in &r.leads {
            times.push((lead.clone(), (minute_of(r.at) + offset).rem_euclid(1440)));
            offset += routines.stagger;
        }
        times.push((
            r.compiler.clone(),
            (minute_of(r.at) + r.compile_after).rem_euclid(1440),
        ));
    }
    if let Some(k) = &routines.kickoff {
        times.push((k.to.clone(), minute_of(k.at)));
    }
    times
}

fn load_quota(raw: Option<&Json>) -> Result<Option<Quota>, PolicyError> {
    let raw = match raw {
        None | Some(Json::Null) => return Ok(None),
        Some(r) => r,
    };
    let profile = match raw.get("profile") {
        Some(Json::Str(p)) if matches!(raw, Json::Obj(_)) && is_profile(p) => p.clone(),
        _ => return refuse("quota needs a plan profile id"),
    };
    Ok(Some(Quota {
        profile,
        reserve: bounded(raw, "reserve_percent", 15, 0, 50)?,
        max_age: bounded(raw, "max_age_seconds", 600, 60, 3600)?,
    }))
}
