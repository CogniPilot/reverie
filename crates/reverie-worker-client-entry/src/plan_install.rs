//! Fixed account-generation installation; no provider dispatch or host authority.
#![forbid(unsafe_code)]
mod args;
mod context;
mod files;
mod generation;
mod input;
mod wire;
use crate::install::{Failure, Result, join};
pub(super) struct Arguments(args::Arguments);
pub(super) fn arguments(raw: &[OsString]) -> Option<Result<Arguments>> {
    args::arguments(raw).map(|result| result.map(Arguments))
}
use std::{ffi::OsString, io::Write, path::Path};
fn need(value: bool, phase: &'static str) -> Result<()> {
    value.then_some(()).ok_or_else(|| Failure::refused(phase))
}
pub(super) fn run(arguments: Arguments) -> Result<()> {
    let arguments = arguments.0;
    crate::install::qualify(&arguments.capsule)?;
    let receipt = match arguments.action {
        args::Action::Install { payload, attempt } => {
            let bytes = wire::read()?;
            let value = input::Payload::parse(&bytes, &payload)?;
            generation::install(
                Path::new("/home/agent"),
                arguments.home,
                &value,
                &arguments.projection,
                &attempt,
            )?
        }
        args::Action::Status {
            operation,
            container,
            initial,
        } => generation::status(
            Path::new("/home/agent"),
            arguments.home,
            &operation,
            &container,
            &arguments.projection,
            initial,
        )?,
    };
    let bytes = serde_json::to_vec(&receipt).map_err(|e| Failure::new("receipt-json", e))?;
    let mut output = std::io::stdout().lock();
    output
        .write_all(&bytes)
        .and_then(|()| output.write_all(b"\n"))
        .and_then(|()| output.flush())
        .map_err(|e| Failure::new("receipt-write", e))
}
