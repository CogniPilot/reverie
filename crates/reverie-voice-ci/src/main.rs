//! Native acceptance of captured voice-CI routes. No synthesis/model owner.
mod audio;
mod recognize;
mod transcript;
mod verify;

use clap::Parser;
use std::{error::Error, path::PathBuf, process::ExitCode};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Parser)]
#[command(about = "Validate captured route clips using the running real Whisper adapter")]
struct Arguments {
    #[arg(long)]
    artifacts: PathBuf,
}

fn main() -> ExitCode {
    let arguments = Arguments::parse();
    match run(arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("voice-ci: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: Arguments) -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(verify::run(&arguments.artifacts))
}

fn need(value: bool, message: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
