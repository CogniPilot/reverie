//! The Hands laptop tool transport reads one request and writes one response.
mod commands;
mod files;
mod protocol;
mod task;
mod telemetry;
#[cfg(test)]
mod tests;

use clap::Parser;
use protocol::{Reply, Result};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const REQUEST_BYTES: u64 = 200_000;

#[derive(Parser)]
#[command(about = "Run one Hands tool request in an existing laptop task workspace.")]
struct Options {
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    task_dir: PathBuf,
    #[arg(long, allow_hyphen_values = true)]
    timeout_s: i64,
    #[arg(long, allow_hyphen_values = true)]
    max_output_bytes: i64,
    #[arg(long)]
    tool_path: Option<PathBuf>,
    #[arg(long)]
    command_telemetry: bool,
}

impl Options {
    fn run(&self) -> Result<Reply> {
        if !(1..=300).contains(&self.timeout_s)
            || !(1024..=131_072).contains(&self.max_output_bytes)
        {
            return Err("invalid runner budget".into());
        }
        if !Path::new("/.dockerenv").is_file() {
            return Err("laptop tool runner requires a container".into());
        }
        let task = task::Task::read(&self.root, &self.task_dir)?;
        let settings = commands::Settings::new(self)?;
        settings.apply_resource_limits()?;
        let mut raw = Vec::new();
        io::stdin().take(REQUEST_BYTES + 1).read_to_end(&mut raw)?;
        if raw.len() as u64 > REQUEST_BYTES {
            return Err(format!("request is over {REQUEST_BYTES} bytes").into());
        }
        protocol::dispatch(&task, &settings, &raw)
    }
}

fn main() -> io::Result<()> {
    let options = Options::parse();
    let reply = options.run().unwrap_or_else(Reply::refused);
    let budget = usize::try_from(options.max_output_bytes.clamp(1024, 131_072)).unwrap();
    let stdout = io::stdout().lock();
    let mut stdout = io::BufWriter::new(stdout);
    serde_json::to_writer(&mut stdout, &reply.bounded((budget / 6).min(24_000)))?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}
