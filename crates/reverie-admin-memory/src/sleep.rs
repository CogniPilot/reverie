//! Execute one scheduled memory pass using the existing private sleep policy.
mod company;
mod memory;
mod policy;
mod prune;
mod rooms;
mod storage;
#[cfg(test)]
mod tests;

use crate::opencode_state::maintenance;
use clap::{Parser, ValueEnum};
use company::Company;
use jiff::{Timestamp, tz::TimeZone};
use policy::{Agent, Policy};
use reverie_host::memory_configuration::MemoryConfiguration;
use rooms::Rooms;
use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PASS_BUDGET: Duration = Duration::from_secs(480);

#[derive(Clone, Copy, ValueEnum)]
enum Action {
    Tick,
    CheckPolicy,
}

#[derive(Parser)]
#[command(
    name = "reverie-sleep",
    about = "Consolidate recent room history, reflect and dream within a selected sleep policy"
)]
struct Arguments {
    action: Action,
    /// External sleep policy in the same runtime namespace.
    #[arg(long)]
    policy: PathBuf,
}

pub(super) fn entry() -> ExitCode {
    let arguments = Arguments::parse();
    let policy = match Policy::load(&arguments.policy) {
        Ok(policy) => policy,
        Err(error) => {
            println!("sleep v1 policy_refused: {error}");
            return ExitCode::from(2);
        }
    };
    let result = match arguments.action {
        Action::Tick => tick(&policy, Timestamp::now()).map(|()| true),
        Action::CheckPolicy => check(&policy),
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("reverie-sleep: {error}");
            ExitCode::FAILURE
        }
    }
}

fn check(policy: &Policy) -> Result<bool> {
    println!(
        "policy ok: {} agents, {}",
        policy.agents.len(),
        mode(policy)
    );
    let legacy = policy.legacy_agents();
    if !legacy.is_empty() {
        println!(
            "deprecated_session_ids {}: name these agents by employee_id",
            legacy.join(",")
        );
    }
    let Some(path) = &policy.company else {
        return Ok(true);
    };
    let company = match Company::load(path) {
        Ok(company) => company,
        Err(error) => {
            println!("company unreadable: {}", error_code(error.as_ref()));
            return Ok(false);
        }
    };
    let mut unknown = 0;
    for agent in &policy.agents {
        if let Some(employee) = &agent.employee_id {
            let Some(ids) = company.sessions(agent, &policy.state_dir, false)? else {
                println!("unknown_employee {} {employee}", agent.name);
                unknown += 1;
                continue;
            };
            let session = company.current(agent).expect("resolved employee");
            let session: String = session.chars().take(8).collect();
            println!(
                "resolved {} employee {} -> session {session} ({} known)",
                agent.name,
                &employee.as_str()[..8],
                ids.len()
            );
        }
    }
    println!(
        "resolved {} of {} agents",
        policy.agents.len() - unknown,
        policy.agents.len()
    );
    Ok(unknown == 0)
}

fn tick(policy: &Policy, now: Timestamp) -> Result<()> {
    storage::create_state(&policy.state_dir)?;
    let Some(_lock) = maintenance::try_lock(&policy.state_dir.join("sleep.lock"))? else {
        println!("sleep v1 previous_tick_running");
        return Ok(());
    };
    let mut report = Report::new(&policy.state_dir, now, mode(policy));
    if !policy.in_window(now) {
        return report.line("outside_window", "-", 0);
    }
    let now = now.as_second() as f64 + f64::from(now.subsec_nanosecond()) / 1_000_000_000.0;
    let rooms = Rooms::load(&policy.chat)?;
    prune_logs(policy, now, &mut report)?;
    let legacy = policy.legacy_agents();
    if !legacy.is_empty() {
        report.line("deprecated_session_ids", &legacy.join(","), legacy.len())?;
    }
    let company = load_company(policy.company.as_deref(), &mut report)?;
    let tick = Tick {
        policy,
        now,
        rooms,
        company,
        started: Instant::now(),
    };
    tick.run_agents(&mut report)
}

struct Tick<'a> {
    policy: &'a Policy,
    now: f64,
    rooms: Rooms<'a>,
    company: Company,
    started: Instant,
}

impl Tick<'_> {
    fn budget_spent(&self) -> bool {
        self.started.elapsed() > PASS_BUDGET
    }

    fn run_agents(&self, report: &mut Report) -> Result<()> {
        for agent in &self.policy.agents {
            if self.budget_spent() {
                return report.line("pass_budget_spent", &agent.name, 0);
            }
            let lock = self
                .policy
                .state_dir
                .join(format!("sleep-{}.lock", agent.name));
            let Some(_lock) = maintenance::try_lock(&lock)? else {
                report.line("locked", &agent.name, 0)?;
                continue;
            };
            if let Err(error) = self.agent(agent, report) {
                report.line(
                    &format!("error_{}", error_code(error.as_ref())),
                    &agent.name,
                    0,
                )?;
            }
        }
        Ok(())
    }

    fn agent(&self, agent: &Agent, report: &mut Report) -> Result<()> {
        if agent.employee_id.is_some() && self.company.current(agent).is_none() {
            return report.line("unknown_employee", &agent.name, 0);
        }
        let config = MemoryConfiguration::capture_instance(Some(&agent.instance))?;
        if !memory::local_models(&config) {
            return report.line("refused_remote_model", &agent.name, 0);
        }
        let bound = config
            .instance()
            .and_then(|loaded| loaded.configuration().employee_id());
        if let (Some(expected), Some(actual)) = (&agent.employee_id, bound)
            && expected != actual
        {
            return report.line("refused_employee_mismatch", &agent.name, 0);
        }
        let ids = self
            .company
            .sessions(agent, &self.policy.state_dir, true)?
            .ok_or("company session disappeared during sleep tick")?;
        memory::with_store(&config, self.policy.dry_run, |store| {
            if agent.consolidate {
                memory::consolidate(
                    self.policy,
                    report,
                    &agent.name,
                    &self.rooms,
                    &ids,
                    store,
                    self.now,
                )?;
            }
            if self.policy.dry_run {
                return report.line(memory::preview(&config, store, self.now)?, &agent.name, 0);
            }
            self.maintain(&config, store, agent, report)
        })
    }

    fn maintain(
        &self,
        config: &MemoryConfiguration,
        store: &reverie_store::memory::MemoryStore,
        agent: &Agent,
        report: &mut Report,
    ) -> Result<()> {
        while !self.budget_spent() {
            let response = maintenance::run_started(config, store)?;
            let action = response["action"].as_str().unwrap_or("skipped");
            let count = response["count"]
                .as_u64()
                .and_then(|value| value.try_into().ok())
                .unwrap_or(0);
            report.line(action, &agent.name, count)?;
            if action == "dreamed" {
                report.line(
                    "morning_note",
                    &agent.name,
                    memory::morning_note(config, store)?,
                )?;
            }
            if !matches!(action, "rated" | "reflected") {
                break;
            }
        }
        Ok(())
    }
}

fn prune_logs(policy: &Policy, now: f64, report: &mut Report) -> Result<()> {
    for entry in &policy.prune {
        let name = entry.path.file_name().unwrap_or_default().to_string_lossy();
        match prune::apply(entry, now, &policy.state_dir) {
            Ok(Some(count)) => report.line(
                if entry.live { "pruned" } else { "would_prune" },
                &name,
                count,
            )?,
            Ok(None) => (),
            Err(error) => report.line(
                &format!("error_prune_{}", error_code(error.as_ref())),
                &name,
                0,
            )?,
        }
    }
    Ok(())
}

fn load_company(path: Option<&Path>, report: &mut Report) -> Result<Company> {
    let Some(path) = path else {
        return Ok(Company::default());
    };
    match Company::load(path) {
        Ok(company) => Ok(company),
        Err(error) => {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            report.line(
                &format!("error_company_{}", error_code(error.as_ref())),
                &name,
                0,
            )?;
            Ok(Company::default())
        }
    }
}

fn mode(policy: &Policy) -> &'static str {
    if policy.dry_run { "dry-run" } else { "live" }
}

fn error_code(error: &(dyn std::error::Error + 'static)) -> &'static str {
    if error.downcast_ref::<serde_json::Error>().is_some() {
        return "JSONDecodeError";
    }
    match error.downcast_ref::<io::Error>().map(io::Error::kind) {
        Some(io::ErrorKind::NotFound) => "FileNotFoundError",
        Some(io::ErrorKind::PermissionDenied) => "PermissionError",
        Some(_) => "OSError",
        None => "RuntimeError",
    }
}

struct Report {
    log: PathBuf,
    utc: String,
    mode: &'static str,
}

impl Report {
    fn new(path: &Path, now: Timestamp, mode: &'static str) -> Self {
        Self {
            log: path.join("sleep.log"),
            utc: now.to_zoned(TimeZone::UTC).strftime("%H:%M:%S").to_string(),
            mode,
        }
    }

    fn line(&mut self, code: &str, agent: &str, count: usize) -> Result<()> {
        let line = format!("sleep v1 {} {code} {agent} {count} {}", self.utc, self.mode);
        writeln!(io::stdout().lock(), "{line}")?;
        writeln!(storage::regular(&self.log, true)?, "{line}")?;
        Ok(())
    }
}
