use clap::Parser;
use reverie_application::offline_worker_store::{ApplyError, apply, preview};
use reverie_core::{
    ids::{OfflineStoreOperationId, ProfileEmployeeId},
    operations::JournalDigest,
};
use serde_json::json;
use std::{
    ffi::OsString,
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Parser)]
#[command(
    name = "reverie-worker-store-maintenance",
    about = "Plan or apply seed-only preparation of an existing offline employee Nix store."
)]
struct Request {
    #[arg(long)]
    config: PathBuf,
    #[arg(long)]
    validated_target: PathBuf,
    #[arg(long)]
    employee: String,
    #[arg(long)]
    operation: String,
    #[arg(long)]
    apply: bool,
    #[arg(long)]
    expected_plan_digest: Option<String>,
}

pub(super) fn entry(argv: Vec<OsString>) -> ExitCode {
    let request = Request::parse_from(argv);
    let result = request.execute().and_then(|bytes| {
        let stdout = io::stdout();
        let mut stdout = stdout.lock();
        stdout
            .write_all(&bytes)
            .and_then(|()| stdout.write_all(b"\n"))
            .map_err(|error| {
                if request.apply {
                    ApplyError::Unconfirmed(error.into())
                } else {
                    ApplyError::Refused(error.into())
                }
            })
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let uncertain = matches!(error, ApplyError::Unconfirmed(_));
            let state = if uncertain { "UNCONFIRMED" } else { "REFUSED" };
            eprintln!(
                "{}",
                json!({"state": state, "reason": error.to_string(), "automaticRetry": false})
            );
            ExitCode::from(if uncertain { 4 } else { 3 })
        }
    }
}

impl Request {
    fn execute(&self) -> std::result::Result<Vec<u8>, ApplyError> {
        let ids = |_| ApplyError::Refused("exact operation/employee UUID required".into());
        let employee = ProfileEmployeeId::parse(&self.employee).map_err(ids)?;
        let operation = OfflineStoreOperationId::parse(&self.operation).map_err(ids)?;
        if self.apply {
            let expected = self
                .expected_plan_digest
                .as_deref()
                .filter(|value| {
                    value
                        .strip_prefix("sha256:")
                        .is_some_and(|digest| JournalDigest::parse(digest).is_ok())
                })
                .ok_or_else(|| {
                    ApplyError::Refused("explicit expected plan digest required".into())
                })?;
            return apply(
                &self.config,
                &self.validated_target,
                &employee,
                &operation,
                expected,
            );
        }
        preview(&self.config, &self.validated_target, &employee, &operation)
            .map_err(ApplyError::Refused)
    }
}
