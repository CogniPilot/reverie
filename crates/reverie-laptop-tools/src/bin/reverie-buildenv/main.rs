mod admission;
mod ledger;
mod observe;
mod process;
mod vitest;

use clap::{CommandFactory, Parser, error::ErrorKind};
use serde_json::{Value, json};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MIB: u64 = 1 << 20;
const GIB: u64 = 1 << 30;
const EX_FEWER_FILES: u8 = 4;
const EX_TEMPFAIL: u8 = 75;

#[derive(Parser)]
#[command(about = "Run one measured build after checking shared memory, task and disk headroom")]
struct Cli {
    /// Names the exclusive target directory under scratch/build.
    #[arg(long)]
    project: String,
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long, default_value = "/scratch")]
    scratch: PathBuf,
    /// Expected peak memory (e.g. 2.5G), or auto to use successful ledger samples.
    #[arg(long)]
    expect: String,
    /// Expected additional disk use.
    #[arg(long, value_parser = admission::size)]
    disk: u64,
    #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u8).range(1..=8))]
    jobs: u8,
    #[arg(long)]
    ledger: Option<PathBuf>,
    /// Wait this many seconds for transient memory, task or disk pressure.
    #[arg(long, default_value_t = 0)]
    wait: u64,
    /// Require this many Vitest files, or auto to count named file arguments.
    #[arg(long)]
    expect_files: Option<String>,
    /// Build command and its arguments, normally after --.
    #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
    command: Vec<String>,
}

struct Build {
    cli: Cli,
    repo: PathBuf,
    scratch: PathBuf,
    cache: PathBuf,
    ledger: PathBuf,
    expect: u64,
    expected_files: Option<usize>,
}
impl Build {
    fn prepare(cli: Cli) -> std::result::Result<Self, String> {
        let repo = cli
            .repo
            .canonicalize()
            .map_err(|error| format!("cannot resolve repository: {error}"))?;
        let expected_files = cli
            .expect_files
            .as_deref()
            .map(|value| vitest::expected(value, &cli.command, &repo))
            .transpose()?;
        let expect = if cli.expect == "auto" {
            let path = cli
                .ledger
                .clone()
                .unwrap_or_else(|| cli.scratch.join("profiles/build-ledger.jsonl"));
            ledger::estimate(&path, &cli.project, &cli.command, cli.jobs)
                .ok_or("--expect auto needs a successful measured run of this command at this --jobs (or fewer) in the ledger")?
        } else {
            admission::size(&cli.expect)?
        };
        fs::create_dir_all(&cli.scratch)
            .map_err(|error| format!("cannot prepare scratch directory: {error}"))?;
        let scratch = cli
            .scratch
            .canonicalize()
            .map_err(|error| format!("cannot resolve scratch directory: {error}"))?;
        ledger::scratch_directory(&scratch, Path::new("tmp"))
            .map_err(|error| format!("cannot prepare scratch directory: {error}"))?;
        let ledger = cli
            .ledger
            .clone()
            .unwrap_or_else(|| scratch.join("profiles/build-ledger.jsonl"));
        let cache = scratch.join("cache/rust");
        Ok(Self {
            cli,
            repo,
            scratch,
            cache,
            ledger,
            expect,
            expected_files,
        })
    }

    fn target(&self) -> PathBuf {
        self.scratch.join("build").join(&self.cli.project)
    }

    fn command(&self) -> io::Result<Command> {
        let mut cmd = Command::new(&self.cli.command[0]);
        let path = env::var_os("PATH").unwrap_or_default();
        let search = std::iter::once(self.cache.join("cargo/bin")).chain(env::split_paths(&path));
        let path = env::join_paths(search).map_err(io::Error::other)?;
        cmd.args(&self.cli.command[1..])
            .current_dir(&self.repo)
            .env("PATH", path)
            .env("RUSTUP_HOME", self.cache.join("rustup"))
            .env("CARGO_HOME", self.cache.join("cargo"))
            .env("RUSTUP_AUTO_INSTALL", "0")
            .env("TMPDIR", self.scratch.join("tmp"))
            .env("TMP", self.scratch.join("tmp"))
            .env("TEMP", self.scratch.join("tmp"))
            .env("CARGO_TARGET_DIR", self.target().join("cargo"))
            .env("CARGO_BUILD_JOBS", self.cli.jobs.to_string());
        Ok(cmd)
    }

    fn prepare_outputs(&self, target: &Path) -> io::Result<()> {
        ledger::scratch_directory(target, Path::new("cargo"))?;
        for path in ["tmp", "cache/rust/cargo", "cache/rust/rustup"] {
            ledger::scratch_directory(&self.scratch, Path::new(path))?;
        }
        if self.cli.ledger.is_none() {
            ledger::scratch_directory(&self.scratch, Path::new("profiles"))?;
        }
        Ok(())
    }

    fn record(&self, since: Instant) -> Value {
        json!({
            "ts": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64(),
            "project": self.cli.project,
            "repo": self.repo,
            "command": self.cli.command,
            "expect_mib": self.expect / MIB,
            "jobs": self.cli.jobs,
            "waited_s": tenths(since.elapsed()),
        })
    }
}

fn tenths(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 10.0).round() / 10.0
}

fn refused(mut record: Value, problems: Vec<String>) -> (Value, u8) {
    record["status"] = json!("refused");
    record["problems"] = json!(problems);
    (record, EX_TEMPFAIL)
}

async fn run(build: &Build, limits: &admission::Limits) -> io::Result<(Value, u8)> {
    let queued = Instant::now();
    let mut stop = process::Stops::install()?;
    let problems = admission::queue(build, limits, queued, &mut stop).await?;
    let record = build.record(queued);
    if !problems.is_empty() {
        return Ok(refused(record, problems));
    }
    let target = build.target();
    ledger::scratch_directory(&build.scratch, &Path::new("build").join(&build.cli.project))?;
    let Some(_lock) = ledger::lock_target(&target)? else {
        return Ok(refused(
            record,
            vec![format!("another build owns {}", target.display())],
        ));
    };
    build.prepare_outputs(&target)?;
    let measured = process::run(build, limits, &mut stop).await?;
    let (record, exit) = measured.report(build, record);
    ledger::append(&build.ledger, &record)?;
    Ok((record, exit))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let build = Build::prepare(Cli::parse()).unwrap_or_else(|error| {
        Cli::command()
            .error(ErrorKind::ValueValidation, error)
            .exit()
    });
    match run(&build, &admission::Limits::system()).await {
        Ok((record, exit)) => {
            println!("{record}");
            ExitCode::from(exit)
        }
        Err(error) => {
            eprintln!("buildenv: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests;
