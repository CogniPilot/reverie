//! Display telemetry from the local NVIDIA driver.
mod output;
mod reading;

use clap::Parser;
use nix::unistd::{AccessFlags, access};
use output::Destination;
use std::{
    env, io,
    path::{Path, PathBuf},
    process::{ExitCode, Stdio},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    signal::unix::{SignalKind, signal},
    time,
};

const QUERY_TIMEOUT: Duration = Duration::from_secs(3);
const INTERVAL: Duration = Duration::from_secs(15);
const MAX_READING: u64 = 64 * 1024;
const QUERY: [&str; 2] = [
    "--query-gpu=name,utilization.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
];

/// Publish fresh display-only GPU telemetry for the Reverie console.
#[derive(Parser)]
struct Args {
    /// Publish once and exit.
    #[arg(long)]
    once: bool,
    /// Write to the selected runtime telemetry file.
    #[arg(long)]
    output: PathBuf,
}

async fn publish(destination: &Destination) -> io::Result<()> {
    let reading = match find_provider() {
        Some(provider) => query(&provider)
            .await
            .and_then(|data| reading::parse(&data)),
        None => None,
    };
    match reading {
        Some(gpus) => destination.write(&reading::encode(gpus)?),
        None => destination.clear(),
    }
}

async fn run(destination: &Destination) -> io::Result<()> {
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    loop {
        tokio::select! {
            result = publish(destination) => {
                if let Err(error) = result {
                    eprintln!("gpu-publisher: {error}");
                }
            }
            _ = terminate.recv() => return Ok(()),
            _ = interrupt.recv() => return Ok(()),
        }
        tokio::select! {
            _ = time::sleep(INTERVAL) => {}
            _ = terminate.recv() => return Ok(()),
            _ = interrupt.recv() => return Ok(()),
        }
    }
}

fn executable(path: &Path) -> bool {
    path.is_file() && access(path, AccessFlags::X_OK).is_ok()
}

fn find_provider() -> Option<PathBuf> {
    if let Some(path) = env::var_os("NVIDIA_SMI")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return executable(&path)
            .then(|| std::path::absolute(&path).ok())
            .flatten();
    }
    let path = env::var_os("PATH").unwrap_or_default();
    env::split_paths(&path)
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.join("nvidia-smi"))
        .chain([
            PathBuf::from("/usr/bin/nvidia-smi"),
            PathBuf::from("/run/opengl-driver/bin/nvidia-smi"),
        ])
        .find(|path| executable(path))
        .and_then(|path| std::path::absolute(path).ok())
}

async fn query(program: &Path) -> Option<Vec<u8>> {
    let mut command = Command::new(program);
    command
        .args(QUERY)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("LC_ALL", "C")
        .kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(MAX_READING + 1);
    let mut bytes = Vec::new();
    if let Ok(Ok(status)) = time::timeout(QUERY_TIMEOUT, async {
        stdout.read_to_end(&mut bytes).await?;
        if bytes.len() as u64 > MAX_READING {
            return Err(io::ErrorKind::InvalidData.into());
        }
        child.wait().await
    })
    .await
        && status.success()
    {
        return Some(bytes);
    }
    drop(stdout);
    let _ = child.start_kill();
    let _ = time::timeout(Duration::from_secs(1), child.wait()).await;
    None
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = Args::parse();
    let result = match Destination::new(&args.output) {
        Ok(destination) if args.once => publish(&destination).await,
        Ok(destination) => run(&destination).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("gpu-publisher: {error}");
            ExitCode::from(if error.kind() == io::ErrorKind::PermissionDenied {
                2
            } else {
                1
            })
        }
    }
}
