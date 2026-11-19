//! Isolated speech fixture for the native voice acceptance runner.
use clap::Parser;
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(about = "Serve pinned Kokoro and Whisper speech on a private loopback port")]
struct Arguments {
    #[arg(long)]
    artifacts: PathBuf,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match reverie_voice_ci::serve(&Arguments::parse().artifacts).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("voice-ci speech: {error}");
            ExitCode::FAILURE
        }
    }
}
