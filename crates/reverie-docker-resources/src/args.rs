use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(
    version,
    about = "Fixed Docker-owned boxed resource operations; never a generic host command"
)]
pub(crate) struct Arguments {
    #[command(subcommand)]
    pub(crate) command: Command,
}
#[derive(Subcommand)]
pub(crate) enum Command {
    Anchor,
    ProbePool(Common),
    ConfigurePool(PoolWrite),
    /// Restore the declared pool policy with every current worker explicitly bound.
    RestorePool(PoolWrite),
    ProbeWorker(Worker),
    ConfigureHigh(HighWrite),
    /// Write only memory.high, retaining all declared hard, CPU and cpuset limits.
    ConfigureMemoryHigh(MemoryHighWrite),
    HoldStorage,
    StorageStatus {
        #[arg(long, value_parser=decimal)]
        holder_start: u64,
    },
    ProbeStorage,
    /// Compare two fixed read-only reference mounts with a current worker observation.
    VerifyStorageReference {
        #[arg(long)]
        home: crate::storage::Directory,
        #[arg(long)]
        nix: crate::storage::Directory,
    },
    /// Check an existing worker credential digest from one bounded private stdin record.
    VerifyWorkerCredential,
}
#[derive(Args, Clone)]
pub(crate) struct Common {
    #[arg(long, value_parser=hex)]
    pub(crate) box_id: String,
    #[arg(long, value_parser=hex)]
    pub(crate) anchor_id: String,
    #[arg(long, value_parser=pid)]
    pub(crate) anchor_pid: u32,
    #[arg(long, value_parser=decimal)]
    pub(crate) anchor_start: Option<u64>,
    #[arg(long, value_parser=member)]
    pub(crate) member: Vec<Member>,
}
#[derive(Clone, Debug)]
pub(crate) struct Member {
    pub(crate) id: String,
    pub(crate) pid: u32,
    pub(crate) start: u64,
}
#[derive(Args)]
pub(crate) struct Worker {
    #[command(flatten)]
    pub(crate) common: Common,
    #[arg(long, value_parser=hex)]
    pub(crate) worker_id: String,
    #[arg(long, value_parser=pid)]
    pub(crate) worker_pid: u32,
    #[arg(long, value_parser=decimal)]
    pub(crate) worker_start: Option<u64>,
}
#[derive(Args)]
pub(crate) struct PoolWrite {
    #[command(flatten)]
    pub(crate) common: Common,
    #[arg(long, value_parser=decimal)]
    pub(crate) parent_dev: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) parent_ino: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) memory_max: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) swap_max: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) pids_max: u64,
    #[arg(long, default_value="100", value_parser=decimal)]
    pub(crate) cpu_weight: u64,
    #[arg(long)]
    pub(crate) cpuset_cpus: Option<String>,
}
#[derive(Args)]
pub(crate) struct HighWrite {
    #[command(flatten)]
    pub(crate) worker: Worker,
    #[arg(long, value_parser=decimal)]
    pub(crate) leaf_dev: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) leaf_ino: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) memory_max: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) swap_max: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) pids_max: u64,
    #[arg(long, value_parser=decimal)]
    pub(crate) memory_high: u64,
    #[arg(long, default_value = "100", value_parser=decimal)]
    pub(crate) cpu_weight: u64,
}
#[derive(Args)]
pub(crate) struct MemoryHighWrite {
    #[command(flatten)]
    pub(crate) high: HighWrite,
    #[arg(long)]
    pub(crate) cpuset_cpus: String,
}
pub(crate) fn decimal(raw: &str) -> std::result::Result<u64, String> {
    raw.parse::<u64>()
        .ok()
        .filter(|value| value.to_string() == raw)
        .ok_or_else(|| "canonical unsigned decimal required".into())
}
pub(crate) fn hex(raw: &str) -> std::result::Result<String, String> {
    (raw.len() == 64
        && raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then(|| raw.to_owned())
    .ok_or_else(|| "full lower-case hexadecimal identity required".into())
}
fn pid(raw: &str) -> std::result::Result<u32, String> {
    decimal(raw)
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 1)
        .ok_or_else(|| "actual non-init host PID required".into())
}
fn member(raw: &str) -> std::result::Result<Member, String> {
    let fields = raw.split(':').collect::<Vec<_>>();
    if fields.len() != 3 {
        return Err("member requires CID:PID:START".into());
    }
    Ok(Member {
        id: hex(fields[0])?,
        pid: pid(fields[1])?,
        start: decimal(fields[2])?,
    })
}
