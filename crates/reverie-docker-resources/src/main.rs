#![forbid(unsafe_code)]
#[cfg(target_os = "linux")]
mod args;
#[cfg(target_os = "linux")]
mod credential;
#[cfg(target_os = "linux")]
mod data;
#[cfg(target_os = "linux")]
mod error;
#[cfg(target_os = "linux")]
mod files;
#[cfg(target_os = "linux")]
mod operations;
#[cfg(target_os = "linux")]
mod scope;
#[cfg(target_os = "linux")]
mod storage;
#[cfg(all(test, target_os = "linux"))]
#[cfg(target_os = "linux")]
mod tests;

#[cfg(target_os = "linux")]
use args::{Arguments, Command};
#[cfg(target_os = "linux")]
use clap::Parser;
#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    let input = Arguments::parse();
    let mut files = files::Files::new();
    let result = match input.command {
        Command::Anchor => loop {
            std::thread::park();
        },
        Command::ProbePool(input) => operations::probe_pool(&mut files, &input),
        Command::ConfigurePool(input) => operations::configure_pool(&mut files, &input),
        Command::RestorePool(input) => operations::restore_pool(&mut files, &input),
        Command::ConfigurePoolCpuMax(input) => {
            operations::configure_pool_cpu_max(&mut files, &input)
        }
        Command::ProbeWorker(input) => operations::probe_worker(&mut files, &input),
        Command::ConfigureHigh(input) => operations::configure_high(&mut files, &input),
        Command::ConfigureMemoryHigh(input) => {
            operations::configure_memory_high(&mut files, &input)
        }
        Command::HoldStorage => storage::hold(&mut files).map(|()| String::new()),
        Command::StorageStatus { holder_start } => storage::status(&mut files, holder_start),
        Command::ProbeStorage => storage::probe(&mut files),
        Command::VerifyStorageReference {
            home,
            nix,
            filesystem_id,
        } => storage::verify_reference(&mut files, &home, &nix, filesystem_id),
        Command::VerifyWorkerCredential => credential::verify(std::io::stdin().lock()),
    };
    let result = error::finalized(result, files.close_all());
    match result {
        Ok(output) => {
            println!("{output}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}", files.failure(&error));
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("BOXED_RESOURCE_PLATFORM_UNSUPPORTED");
    std::process::ExitCode::FAILURE
}
