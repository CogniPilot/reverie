//! Local Kokoro speech service with an owner-selected model cache.
mod service;

use clap::Parser;
use reverie_kokoro::Result;
use std::{env, path::PathBuf, process::ExitCode, sync::Arc};
use tokio::net::TcpListener;

/// Serve Kokoro speech on loopback using the pinned model and voices.
#[derive(Parser)]
struct Options {
    /// Model cache directory. Defaults to REVERIE_KOKORO_MODELS or the instance voice directory.
    #[arg(long)]
    models: Option<PathBuf>,
    /// IPv4 loopback port.
    #[arg(long, default_value_t = 8091)]
    port: u16,
}

fn models() -> PathBuf {
    let value = |key| env::var_os(key).map(PathBuf::from);
    if let Some(path) = value("REVERIE_KOKORO_MODELS") {
        return path;
    }
    let data = value("REVERIE_DATA").unwrap_or_else(|| {
        value("REVERIE_ROOT")
            .unwrap_or_else(|| env::home_dir().unwrap_or_default().join("reverie"))
            .join("companies/default/data")
    });
    data.join("voice/kokoro")
}

async fn run(options: Options) -> Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port)).await?;
    eprintln!("Listening on http://{}", listener.local_addr()?);
    let state = Arc::new(service::State::new());
    let loading = Arc::clone(&state);
    let directory = options.models.unwrap_or_else(models);
    tokio::task::spawn_blocking(move || loading.load(&directory));
    service::listen(listener, state).await
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Options::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reverie-kokoro: {error}");
            ExitCode::FAILURE
        }
    }
}
