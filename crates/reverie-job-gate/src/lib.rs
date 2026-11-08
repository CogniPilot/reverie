//! A cooperative admission gate for heavy jobs (builds, test suites) on one seat or laptop.
//!
//! A seat's cgroup is not delegated, so a job cannot be given its own memory limit from inside.
//! Instead, heavy commands run through this gate, which reserves each job's estimate in a ledger
//! until the job exits and admits a new job only while every reservation and the seat's
//! non-reclaimable usage still fit under a fraction of the memory cap (see `rule`). It never kills
//! or limits anything; a job it does not run is not counted, except through the measured usage.
pub mod facts;
pub mod ledger;
pub mod rule;

use facts::{Roots, Unreadable, read_facts, start_time, tree_pss_anon};
use ledger::{Entry, Ledger};
use rule::{Decision, Facts, Held};
use std::{io, path::Path};

/// Live holders, each with its tree's measured `Pss_Anon` when readable.
pub type Holders = Vec<(Entry, Option<u64>)>;

/// The outcome of one admission attempt, with what it was decided on.
#[derive(Debug)]
pub struct Attempt {
    pub decision: Decision,
    pub facts: Facts,
    pub held: Holders,
}

#[derive(Debug)]
pub enum GateError {
    Unreadable(Unreadable),
    Io(io::Error),
}

impl From<io::Error> for GateError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Under the ledger lock: prune stale holders, read the facts, decide, and on admission record
/// `pid` (the gate process, parent of the job) with its reservation.
pub fn try_admit(
    ledger: &Ledger,
    roots: &Roots,
    pid: u32,
    estimate: u64,
    permille: u32,
) -> Result<Attempt, GateError> {
    let locked = ledger.lock()?;
    let entries = ledger.live(&locked, &roots.proc)?;
    let held: Holders = entries
        .into_iter()
        .map(|entry| (entry, tree_pss_anon(&roots.proc, entry.pid)))
        .collect();
    let facts = read_facts(roots).map_err(GateError::Unreadable)?;
    let rule_held: Vec<Held> = held
        .iter()
        .map(|(entry, pss_anon)| Held {
            reservation: entry.reservation,
            pss_anon: *pss_anon,
        })
        .collect();
    let decision = rule::decide(&facts, &rule_held, estimate, permille);
    if decision == Decision::Admit {
        let start = start_time(&roots.proc, pid).ok_or_else(|| {
            GateError::Unreadable(Unreadable(format!("no start time for pid {pid}")))
        })?;
        ledger.add(
            &locked,
            Entry {
                pid,
                start,
                reservation: estimate,
            },
        )?;
    }
    Ok(Attempt {
        decision,
        facts,
        held,
    })
}

/// Release `pid`'s reservation.
pub fn release(ledger: &Ledger, pid: u32) -> io::Result<()> {
    let locked = ledger.lock()?;
    ledger.remove(&locked, pid)
}

/// Current facts and live holders, for `status`; prunes stale holders like an admission does.
pub fn snapshot(ledger: &Ledger, roots: &Roots) -> Result<(Facts, Holders), GateError> {
    let locked = ledger.lock()?;
    let held = ledger
        .live(&locked, &roots.proc)?
        .into_iter()
        .map(|entry| (entry, tree_pss_anon(&roots.proc, entry.pid)))
        .collect();
    let facts = read_facts(roots).map_err(GateError::Unreadable)?;
    Ok((facts, held))
}

/// Parse a size: plain bytes, or a number with k, m or g (binary units).
pub fn parse_size(text: &str) -> Option<u64> {
    let text = text.trim().to_ascii_lowercase();
    let (digits, scale) = match text.chars().last()? {
        'k' => (&text[..text.len() - 1], 1u64 << 10),
        'm' => (&text[..text.len() - 1], 1u64 << 20),
        'g' => (&text[..text.len() - 1], 1u64 << 30),
        _ => (text.as_str(), 1),
    };
    digits
        .parse::<u64>()
        .ok()?
        .checked_mul(scale)
        .filter(|bytes| *bytes > 0)
}

/// Default ledger directory, per user: the runtime directory, else the state directory under the
/// home directory (outside any /tmp cleanup), else a per-user directory under /tmp.
pub fn default_ledger(
    runtime_dir: Option<&Path>,
    home: Option<&Path>,
    uid: u32,
) -> std::path::PathBuf {
    match (runtime_dir, home) {
        (Some(dir), _) => dir.join("reverie-job"),
        (None, Some(home)) => home.join(".local/state/reverie-job"),
        (None, None) => std::env::temp_dir().join(format!("reverie-job-{uid}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_ledger_prefers_runtime_then_home_state_then_tmp() {
        let runtime = Path::new("/run/user/7");
        let home = Path::new("/home/casey");
        assert_eq!(
            default_ledger(Some(runtime), Some(home), 7),
            runtime.join("reverie-job")
        );
        assert_eq!(
            default_ledger(None, Some(home), 7),
            home.join(".local/state/reverie-job")
        );
        assert_eq!(
            default_ledger(None, None, 7),
            std::env::temp_dir().join("reverie-job-7")
        );
    }

    #[test]
    fn parses_sizes_and_refuses_zero_or_junk() {
        assert_eq!(parse_size("1500"), Some(1500));
        assert_eq!(parse_size("2k"), Some(2048));
        assert_eq!(parse_size("700M"), Some(700 << 20));
        assert_eq!(parse_size("1g"), Some(1 << 30));
        for bad in ["", "0", "m", "1.5g", "-1", "1t"] {
            assert_eq!(parse_size(bad), None, "{bad}");
        }
    }
}
