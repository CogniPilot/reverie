//! `reverie-resource-history`: `cleanup/collector_history.py main()`. One
//! compact JSON line on stdout, or `Resource history unavailable` and status 2.
use clap::Parser;
use nix::sys::resource::{Resource, getrlimit, setrlimit};
use reverie_contracts::resource_history::HistoryRequest;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

/// Bounded, path-free projection of explicitly configured USER observations.
#[derive(Parser)]
#[command(name = "reverie-resource-history")]
struct Cli {
    #[arg(long, overrides_with = "config")]
    config: PathBuf,
    /// Unix seconds (Python `int` syntax).
    #[arg(long, allow_hyphen_values = true, overrides_with = "start")]
    start: String,
    #[arg(long, allow_hyphen_values = true, overrides_with = "end")]
    end: String,
    #[arg(long, default_value = "auto", overrides_with = "resolution")]
    resolution: String,
    #[arg(long, overrides_with = "gpu")]
    gpu: Option<String>,
}

/// The parse outcome of Python's `int(text)`.
enum PythonInt {
    Fits(i64),
    /// Valid syntax beyond i64: every such query bound refuses.
    Beyond,
    Invalid,
}

/// Python `int(text)` in base 10 for ASCII digits: surrounding whitespace, one
/// sign, and single underscores between digits. Non-ASCII decimal digits are
/// a disclosed difference (refused here).
fn python_int(text: &str) -> PythonInt {
    let body = text.trim();
    let digits = body.strip_prefix(['+', '-']).unwrap_or(body);
    let well_formed = !digits.is_empty()
        && !digits.starts_with('_')
        && !digits.ends_with('_')
        && !digits.contains("__")
        && digits.chars().all(|c| c.is_ascii_digit() || c == '_');
    if !well_formed {
        return PythonInt::Invalid;
    }
    let plain: String = body.chars().filter(|c| *c != '_').collect();
    plain.parse().map_or(PythonInt::Beyond, PythonInt::Fits)
}

/// RLIMIT_AS to at most 256 MiB, as the Python command does; a hard limit
/// below the cap refuses (Python's setrlimit raises ValueError).
fn bound_memory() -> Result<(), ()> {
    const CAP: u64 = 256 << 20;
    let (soft, hard) = getrlimit(Resource::RLIMIT_AS).map_err(|_| ())?;
    let infinite = nix::sys::resource::RLIM_INFINITY;
    let soft = if soft == infinite { CAP } else { soft.min(CAP) };
    if hard != infinite && soft > hard {
        return Err(());
    }
    setrlimit(Resource::RLIMIT_AS, soft, hard).map_err(|_| ())
}

fn run(cli: &Cli) -> Result<Vec<u8>, ()> {
    bound_memory()?;
    let bound = |text: &str| match python_int(text) {
        PythonInt::Fits(value) => Ok(value),
        // Out-of-range integers reach `query`, whose bounds refuse them.
        PythonInt::Beyond | PythonInt::Invalid => Err(()),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ())?
        .as_secs();
    let request = HistoryRequest {
        start: bound(&cli.start)?,
        end: bound(&cli.end)?,
        resolution: cli.resolution.clone(),
        gpu: cli.gpu.clone(),
        now: i64::try_from(now).map_err(|_| ())?,
    };
    let owner = reverie_observations::Owner::current().map_err(|_| ())?;
    let mut output = reverie_observations::query(owner, &cli.config, &request).map_err(|_| ())?;
    output.push(b'\n');
    Ok(output)
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    // argparse's `type=int` rejects malformed text before the query runs.
    for (name, text) in [("--start", &cli.start), ("--end", &cli.end)] {
        if matches!(python_int(text), PythonInt::Invalid) {
            let _ = writeln!(
                std::io::stderr(),
                "reverie-resource-history: error: argument {name}: invalid int value: '{text}'"
            );
            return ExitCode::from(2);
        }
    }
    let written = run(&cli).and_then(|output| {
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(&output)
            .and_then(|()| stdout.flush())
            .map_err(|_| ())
    });
    if written.is_ok() {
        return ExitCode::SUCCESS;
    }
    let _ = writeln!(std::io::stderr(), "Resource history unavailable");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_follow_python_int_syntax() {
        for (text, expected) in [
            ("12", Some(12)),
            (" +12 ", Some(12)),
            ("-5", Some(-5)),
            ("1_000", Some(1000)),
            ("007", Some(7)),
        ] {
            assert!(
                matches!(python_int(text), PythonInt::Fits(v) if Some(v) == expected),
                "{text}"
            );
        }
        for text in ["", "_1", "1_", "1__0", "1.0", "0x10", "--1", "1e3"] {
            assert!(matches!(python_int(text), PythonInt::Invalid), "{text}");
        }
        assert!(matches!(
            python_int("99999999999999999999"),
            PythonInt::Beyond
        ));
    }
}
