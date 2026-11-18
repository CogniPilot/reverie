//! Native acceptance of captured voice-CI routes. No synthesis/model owner.
use clap::Parser;
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(about = "Validate captured route clips using the running real Whisper adapter")]
struct Arguments {
    #[arg(long)]
    artifacts: PathBuf,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let arguments = Arguments::parse();
    match reverie_voice_ci::validate(&arguments.artifacts).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("voice-ci: {error}");
            ExitCode::FAILURE
        }
    }
}
