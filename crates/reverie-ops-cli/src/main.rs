//! Thin OPS client for the same installed Office API used by employee laptops.
mod address;
mod transport;
use clap::{Parser, Subcommand};
use reverie_contracts::ops_command::{MAX_SUBMIT_BYTES, OpsCommand, OpsReply};
use reverie_core::worker_options::OpsServiceId;
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
    long_about = "Use the fixed /api/ops Office phone supplied by this laptop's installation. Commands never select an actor, host engine, transport socket or owner identity. Status and inspect are reads; submit requires the complete existing grant/artifact/generation command. The server remains authoritative for every permission and effect.",
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
}
fn main() -> ExitCode {
    let args = Arguments::parse();
    let (bytes, code) = match run(args) {
        Ok(reply) => (
            reply.canonical_bytes().to_vec(),
            if reply.succeeded() { 0 } else { 3 },
        ),
        Err(_) => (
            br#"{"reason":"adapter-unavailable","success":false}"#.to_vec(),
            3,
        ),
    };
    let mut line = bytes;
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
fn run(args: Arguments) -> Result<OpsReply> {
    let command = match args.action {
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
