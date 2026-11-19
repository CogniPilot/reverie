use super::Result;
use jiff::{Timestamp, tz::TimeZone};
use reverie_core::ids::ProfileEmployeeId;
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    #[serde(default = "utc")]
    timezone: String,
    #[serde(default)]
    window: Window,
    dry_run: Option<Value>,
    #[serde(default, deserialize_with = "selected_path")]
    chatrooms: Option<PathBuf>,
    #[serde(default, deserialize_with = "selected_path")]
    chat_db: Option<PathBuf>,
    backfill_days: Option<u16>,
    state_dir: PathBuf,
    agents: Vec<Agent>,
    #[serde(default)]
    prune: Vec<Prune>,
    #[serde(default, deserialize_with = "selected_path")]
    company: Option<PathBuf>,
}

#[derive(Deserialize)]
struct Window {
    start: String,
    end: String,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            start: "01:00".into(),
            end: "06:00".into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Agent {
    pub(super) name: String,
    pub(super) instance: PathBuf,
    #[serde(default, deserialize_with = "employee_id")]
    pub(super) employee_id: Option<ProfileEmployeeId>,
    #[serde(default)]
    pub(super) session_ids: BTreeSet<String>,
    session_id: Option<String>,
    #[serde(default = "consolidate")]
    pub(super) consolidate: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Prune {
    pub(super) path: PathBuf,
    pub(super) days: u16,
    #[serde(default)]
    pub(super) live: bool,
}

pub(super) enum Chat {
    Json(PathBuf),
    Database(PathBuf),
}

pub(super) struct Policy {
    zone: TimeZone,
    start: u16,
    end: u16,
    pub(super) dry_run: bool,
    pub(super) chat: Chat,
    pub(super) backfill_days: Option<u16>,
    pub(super) state_dir: PathBuf,
    pub(super) agents: Vec<Agent>,
    pub(super) prune: Vec<Prune>,
    pub(super) company: Option<PathBuf>,
}

impl Policy {
    pub(super) fn load(path: &Path) -> Result<Self> {
        Self::decode(&fs::read(path)?)
    }

    pub(super) fn decode(raw: &[u8]) -> Result<Self> {
        let mut input: Input = serde_json::from_slice(raw)?;
        let zone = reverie_time_zone::load_zone(&input.timezone).ok_or("unknown timezone")?;
        let chat = match (input.chatrooms.take(), input.chat_db.take()) {
            (Some(path), None) => Chat::Json(absolute(path, "chatrooms")?),
            (None, Some(path)) => Chat::Database(absolute(path, "chat_db")?),
            _ => return Err("give exactly one of chatrooms or chat_db".into()),
        };
        let company = input
            .company
            .take()
            .map(|path| absolute(path, "company"))
            .transpose()?;
        validate_agents(&mut input.agents, company.is_some())?;
        validate_retention(&input)?;
        Ok(Self {
            zone,
            start: minute(&input.window.start)?,
            end: minute(&input.window.end)?,
            dry_run: input.dry_run != Some(Value::Bool(false)),
            chat,
            backfill_days: input.backfill_days,
            state_dir: absolute(input.state_dir, "state_dir")?,
            agents: input.agents,
            prune: input.prune,
            company,
        })
    }

    pub(super) fn in_window(&self, now: Timestamp) -> bool {
        let local = now.to_zoned(self.zone.clone());
        let minute = local.hour() as u16 * 60 + local.minute() as u16;
        if self.start < self.end {
            (self.start..self.end).contains(&minute)
        } else {
            minute >= self.start || minute < self.end
        }
    }

    pub(super) fn legacy_agents(&self) -> Vec<&str> {
        self.agents
            .iter()
            .filter(|agent| agent.employee_id.is_none() && !agent.session_ids.is_empty())
            .map(|agent| agent.name.as_str())
            .collect()
    }
}

fn utc() -> String {
    "UTC".into()
}

fn consolidate() -> bool {
    true
}

fn employee_id<'de, D: Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<Option<ProfileEmployeeId>, D::Error> {
    let value = String::deserialize(decoder)?;
    ProfileEmployeeId::parse(&value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn selected_path<'de, D: Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<Option<PathBuf>, D::Error> {
    PathBuf::deserialize(decoder).map(Some)
}

fn absolute(path: PathBuf, key: &str) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(format!("{key} must be an absolute path").into());
    }
    Ok(path)
}

fn minute(time: &str) -> Result<u16> {
    let invalid = || format!("invalid time {time:?}");
    let (hour, minute) = time.split_once(':').ok_or_else(invalid)?;
    let hour = hour.trim().parse::<u16>().map_err(|_| invalid())?;
    let minute = minute.trim().parse::<u16>().map_err(|_| invalid())?;
    if hour >= 24 || minute >= 60 {
        return Err(invalid().into());
    }
    Ok(hour * 60 + minute)
}

fn valid_name(name: &str) -> bool {
    matches!(name.as_bytes().first(), Some(b'a'..=b'z'))
        && name.len() <= 32
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn validate_agents(agents: &mut [Agent], has_company: bool) -> Result<()> {
    if agents.is_empty() {
        return Err("at least one agent is required".into());
    }
    let mut names = BTreeSet::new();
    let mut employees = BTreeSet::new();
    for agent in agents {
        if !valid_name(&agent.name) || agent.instance.as_os_str().is_empty() {
            return Err("each agent needs a name slug and an instance file".into());
        }
        if !names.insert(&agent.name) {
            return Err(format!("duplicate agent {}", agent.name).into());
        }
        if let Some(employee) = &agent.employee_id {
            if !has_company {
                return Err(
                    "agents named by employee_id need the console company file (company)".into(),
                );
            }
            if !employees.insert(employee) {
                return Err(format!("duplicate employee_id for {}", agent.name).into());
            }
        }
        if agent.session_ids.contains("") {
            return Err(
                format!("{}: session_ids must be a list of session ids", agent.name).into(),
            );
        }
        agent
            .session_ids
            .extend(agent.session_id.take().filter(|id| !id.is_empty()));
        if agent.consolidate && agent.session_ids.is_empty() && agent.employee_id.is_none() {
            return Err(format!(
                "{}: consolidation needs the agent's employee_id or console session id",
                agent.name
            )
            .into());
        }
    }
    Ok(())
}

fn validate_retention(input: &Input) -> Result<()> {
    if input
        .backfill_days
        .is_some_and(|days| !(1..=3650).contains(&days))
    {
        return Err("backfill_days must be whole days from 1 to 3650".into());
    }
    if input
        .prune
        .iter()
        .any(|rule| !rule.path.is_absolute() || !(1..=3650).contains(&rule.days))
    {
        return Err("each prune entry needs an absolute path and whole days from 1 to 3650".into());
    }
    Ok(())
}
