//! Fixed Docker controller role. No arbitrary executable, engine endpoint,
//! configuration path, target PID or privileged command is accepted.
use clap::{Parser, Subcommand};
use reverie_host::worker_pool::{ControllerEndpoint, ControllerPoolPolicy};
use std::{
    process::ExitCode,
    time::{Duration, Instant},
};
#[derive(Parser)]
struct Arguments {
    #[command(subcommand)]
    role: Role,
}
#[derive(Subcommand)]
enum Role {
    Serve {
        #[arg(long)]
        confinement_version: u8,
        #[arg(long)]
        birth_sha256: String,
    },
}
fn main() -> ExitCode {
    let Role::Serve {
        confinement_version,
        birth_sha256,
    } = Arguments::parse().role;
    if confinement_version != 2 {
        eprintln!("WORKER_POOL_CONFINEMENT_VERSION");
        return ExitCode::FAILURE;
    }
    let Some(digest) = digest(&birth_sha256) else {
        eprintln!("WORKER_POOL_BIRTH_DIGEST");
        return ExitCode::FAILURE;
    };
    let mut policy = match ControllerPoolPolicy::open_service_v2(digest) {
        Ok(owner) => owner,
        Err(mut owner) => {
            eprintln!("{}", owner.primary_error());
            if let Err(error) = owner.close() {
                eprintln!("{error}");
            }
            return ExitCode::FAILURE;
        }
    };
    let known = {
        let mut endpoint = match ControllerEndpoint::bind_service_v2(&policy) {
            Ok(owner) => owner,
            Err(mut owner) => {
                eprintln!("{}", owner.primary_error());
                if let Err(error) = owner.close() {
                    eprintln!("{error}");
                }
                return ExitCode::FAILURE;
            }
        };
        let body = match endpoint.accept_original_broker(Instant::now() + Duration::from_secs(300))
        {
            Ok(peer) => match peer.into_serving().run() {
                Ok(()) => true,
                Err(mut owner) => {
                    eprintln!("{}", owner.primary_error());
                    if let Err(error) = owner.close_components() {
                        eprintln!("{error}");
                    }
                    false
                }
            },
            Err(mut owner) => {
                eprintln!("{}", owner.primary_error());
                if let Err(error) = owner.close() {
                    eprintln!("{error}");
                }
                false
            }
        };
        let close = endpoint.close();
        if let Err(error) = &close {
            eprintln!("{error}");
        }
        body && close.is_ok()
    };
    let close = policy.close();
    if let Err(error) = &close {
        eprintln!("{error}");
    }
    if known && close.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
fn digest(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}
