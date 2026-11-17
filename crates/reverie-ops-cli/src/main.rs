//! Thin OPS client for the same installed Office API used by employee laptops.
mod address;
mod browser_job;
mod transport;
use clap::{Parser, Subcommand};
use reverie_contracts::ops_command::{MAX_SUBMIT_BYTES, OpsCommand, OpsReply};
use reverie_core::ops::OpsServiceId;
use std::{
    ffi::{OsStr, OsString},
    io::{self, Read, Write},
    process::ExitCode,
};

#[derive(Debug)]
struct Unavailable;
type Result<T> = std::result::Result<T, Unavailable>;

#[derive(Parser)]
#[command(
    about = "Inspect or submit structured OPS through your installed Office phone.",
    long_about = "Use this laptop's installed Office phone for OPS and fixed browser jobs. The OPS submit command requires the complete existing grant, artifact and generation command. Browser jobs take a single Office message reference. The server establishes identity and authorizes each operation.",
    after_long_help = "EXAMPLES:\n  reverie-ops status website\n  reverie-ops inspect website operation-id\n  reverie-ops submit < reviewed-command.json\n\nINSTALLATION:\n  REVERIE_API_URL must name this laptop's local HTTP Office phone.\n  This is installation data, not a credential or permission grant.\n\nOUTPUT AND RECOVERY:\n  One canonical JSON object on stdout. Exit 0 means a truthy server success;\n  exit 3 means refusal or unavailable transport. Argument errors exit 2.\n  A lost response may follow a real effect: inspect the durable operation before\n  another submission. This client never retries a request automatically."
)]
struct Arguments {
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Read the resource's current availability and supported operations.
    Status {
        /// Resource ID from the installed API (for example website).
        resource: OsString,
    },
    /// Read one existing operation and its durable receipts.
    Inspect {
        resource: OsString,
        operation: OsString,
    },
    /// Read one exact effect command from stdin (maximum 16 KiB).
    #[command(
        long_about = "Submit one existing OPS effect command from stdin. Include requestId, resourceId, action, grantRef, idempotencyKey, artifact, expectedResourceGeneration and expectedCapabilityGeneration. Unknown keys and caller/host selectors are refused. Obtain grants and reviewed artifact references through the supported owner API; this command creates none."
    )]
    Submit,
    /// Submit, inspect or cancel a fixed browser job by its Office message reference.
    BrowserJob {
        #[arg(value_enum)]
        action: browser_job::Action,
        request_message_id: OsString,
    },
}
fn main() -> ExitCode {
    let (mut line, code) = match Arguments::parse().action {
        Action::BrowserJob {
            action,
            request_message_id,
        } => browser_job::run(action, &request_message_id),
        action => ops_outcome(run(action)),
    };
    line.push(b'\n');
    let mut output = io::stdout().lock();
    if output
        .write_all(&line)
        .and_then(|()| output.flush())
        .is_err()
    {
        return ExitCode::from(3);
    }
    ExitCode::from(code)
}
fn ops_outcome(result: Result<OpsReply>) -> (Vec<u8>, u8) {
    match result {
        Ok(reply) => (
            reply.canonical_bytes().to_vec(),
            if reply.succeeded() { 0 } else { 3 },
        ),
        Err(_) => (
            br#"{"reason":"adapter-unavailable","success":false}"#.to_vec(),
            3,
        ),
    }
}
fn run(action: Action) -> Result<OpsReply> {
    let command = match action {
        Action::Submit => {
            let mut raw = Vec::new();
            io::stdin()
                .lock()
                .take((MAX_SUBMIT_BYTES + 1) as u64)
                .read_to_end(&mut raw)
                .map_err(|_| Unavailable)?;
            if raw.len() > MAX_SUBMIT_BYTES {
                return Err(Unavailable);
            }
            let command = OpsCommand::decode(&raw).map_err(|_| Unavailable)?;
            if !command.action().is_effect() {
                return Err(Unavailable);
            }
            command
        }
        Action::Status { resource } => OpsCommand::status(&request_id()?, &id(&resource)?),
        Action::Inspect {
            resource,
            operation,
        } => OpsCommand::inspect(&request_id()?, &id(&resource)?, &id(&operation)?),
        Action::BrowserJob { .. } => return Err(Unavailable),
    };
    let selected = std::env::var_os("REVERIE_API_URL").ok_or(Unavailable)?;
    let phone = address::OfficePhone::parse(&selected.to_string_lossy())?;
    transport::call(phone, &command)
}
fn id(value: &OsStr) -> Result<OpsServiceId> {
    OpsServiceId::parse(value.to_str().ok_or(Unavailable)?).map_err(|_| Unavailable)
}
fn request_id() -> Result<OpsServiceId> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| Unavailable)?;
    let uuid = uuid::Builder::from_bytes(bytes)
        .with_variant(uuid::Variant::RFC4122)
        .with_version(uuid::Version::Random)
        .into_uuid();
    id(OsStr::new(&format!("req-{}", uuid.simple())))
}
