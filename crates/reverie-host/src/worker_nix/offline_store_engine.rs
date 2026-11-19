//! Fixed, locally pinned Docker operations for offline worker store maintenance.
use crate::captured_client::{self, CapturedClient, InstalledCommand, Policy};
use reverie_contracts::{
    worker_image_switch::WorkerImageId,
    worker_nix::{NixPreparationArguments, offline_qualification::engine},
};
use reverie_core::ids::{ContainerId, OfflineStoreOperationId};
use std::{
    collections::BTreeSet,
    ffi::{OsStr, OsString},
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[cfg(test)]
mod tests;

const READ_TIME: Duration = Duration::from_secs(20);
const SETTLE_TIME: Duration = Duration::from_secs(1);
const METADATA_BYTES: usize = 16 * 1024 * 1024;
const ARCHIVE_BYTES: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub enum Query {
    Identity,
    Inventory,
    Image(WorkerImageId),
    Inspect(Vec<ContainerId>),
    Base(ContainerId),
}

pub fn read(socket: &Path, query: Query) -> Result<Vec<u8>> {
    read_command(socket, query, installed()?)
}

fn installed() -> Result<InstalledCommand> {
    InstalledCommand::from_service(
        OsStr::new("docker"),
        std::env::vars_os().collect(),
        std::env::current_dir()?,
    )
    .and_then(InstalledCommand::canonicalize)
    .ok_or_else(|| "local Docker client unavailable".into())
}

fn read_command(socket: &Path, query: Query, command: InstalledCommand) -> Result<Vec<u8>> {
    let identity = socket_identity(socket)?;
    let client = CapturedClient::new(command);
    let reply = run(&client, socket, &query, READ_TIME)?;
    if socket_identity(socket)? != identity {
        return Err("local engine socket changed during observation".into());
    }
    query.decode(reply)
}

fn socket_identity(socket: &Path) -> Result<(u64, u64)> {
    if !socket.is_absolute() || socket.canonicalize()?.as_os_str() != socket.as_os_str() {
        return Err("canonical existing local engine socket required".into());
    }
    let info = fs::symlink_metadata(socket)?;
    if !info.file_type().is_socket() {
        return Err("canonical existing local engine socket required".into());
    }
    Ok((info.dev(), info.ino()))
}

fn run(client: &CapturedClient, socket: &Path, query: &Query, budget: Duration) -> Result<Vec<u8>> {
    let args = query.argv(socket)?;
    let limit = if matches!(query, Query::Base(_)) {
        ARCHIVE_BYTES
    } else {
        METADATA_BYTES
    };
    capture(client, args, budget, limit, "engine observation failed")
}

fn capture(
    client: &CapturedClient,
    args: Vec<OsString>,
    budget: Duration,
    limit: usize,
    failure: &str,
) -> Result<Vec<u8>> {
    let result = client.run_offline_store(
        args,
        Instant::now() + budget,
        Policy {
            maximum: budget,
            maximum_output: limit,
            successful_exit: true,
        },
    );
    let closed = client.close(Instant::now() + SETTLE_TIME);
    if closed.is_err() {
        return Err("engine client reaping unconfirmed".into());
    }
    result.map(|output| output.stdout).map_err(|error| {
        use captured_client::Fault;
        match error.fault {
            Fault::Deadline => "engine response deadline",
            Fault::OutputBound => "engine response bound",
            Fault::Finalization | Fault::Supervisor => "engine client reaping unconfirmed",
            _ => failure,
        }
        .into()
    })
}

impl Query {
    fn argv(&self, socket: &Path) -> Result<Vec<OsString>> {
        let mut args = endpoint(socket);
        match self {
            Self::Identity => args.extend(strings(["info", "--format", "{{json .ID}}"])),
            Self::Inventory => args.extend(strings(["ps", "--all", "--quiet", "--no-trunc"])),
            Self::Image(image) => args.extend(strings(["image", "inspect", image.as_str()])),
            Self::Inspect(ids) => {
                if ids.is_empty()
                    || ids.len() > 32
                    || ids
                        .iter()
                        .map(ContainerId::as_str)
                        .collect::<BTreeSet<_>>()
                        .len()
                        != ids.len()
                {
                    return Err("container inventory unavailable".into());
                }
                args.push("inspect".into());
                args.extend(ids.iter().map(|id| OsString::from(id.as_str())));
            }
            Self::Base(id) => {
                let source = format!("{}:/etc/reverie-nix-base", id.as_str());
                args.extend(strings(["cp", &source, "-"]));
            }
        }
        Ok(args)
    }

    fn decode(self, raw: Vec<u8>) -> Result<Vec<u8>> {
        match self {
            Self::Identity => Ok(serde_json::to_vec(&engine::identity(&raw)?)?),
            Self::Inventory => Ok(serde_json::to_vec(&engine::inventory_ids(&raw)?)?),
            Self::Image(image) => {
                engine::check_image(&raw, &image)?;
                Ok(raw)
            }
            Self::Inspect(ids) => {
                engine::check_batch(&raw, &ids)?;
                Ok(raw)
            }
            Self::Base(_) => base_target(&raw),
        }
    }
}

fn strings<const N: usize>(args: [&str; N]) -> [OsString; N] {
    args.map(OsString::from)
}

fn base_target(raw: &[u8]) -> Result<Vec<u8>> {
    let unavailable = "image base must be an immutable link";
    let mut archive = tar::Archive::new(raw);
    let mut entries = archive.entries()?;
    let entry = entries.next().ok_or(unavailable)??;
    if !entry.header().entry_type().is_symlink() {
        return Err(unavailable.into());
    }
    let target = entry.link_name()?.ok_or(unavailable)?;
    let target = target.to_str().ok_or(unavailable)?;
    engine::check_base_target(target)?;
    if entries.next().is_some() {
        return Err(unavailable.into());
    }
    Ok(serde_json::to_vec(target)?)
}

fn endpoint(socket: &Path) -> Vec<OsString> {
    let mut endpoint = OsString::from("unix://");
    endpoint.push(socket.as_os_str());
    vec!["--host".into(), endpoint]
}

/// Keep one observed local socket identity throughout a maintenance attempt.
pub struct LocalEngine {
    socket: PathBuf,
    identity: (u64, u64),
}

impl LocalEngine {
    pub fn open(socket: &Path) -> Result<Self> {
        Ok(Self {
            socket: socket.to_owned(),
            identity: socket_identity(socket)?,
        })
    }

    pub fn read(&self, socket: &Path, query: Query) -> Result<Vec<u8>> {
        if socket != self.socket {
            return Err("validated engine endpoint changed".into());
        }
        self.confirm()?;
        let data = read(socket, query)?;
        self.confirm()?;
        Ok(data)
    }

    pub fn create(
        &self,
        helper: &NixPreparationArguments,
        operation: &OfflineStoreOperationId,
    ) -> Result<ContainerId> {
        let mut args = endpoint(&self.socket);
        args.extend(strings(["create", "--label"]));
        args.push(format!("reverie.offline-store-operation={}", operation.as_str()).into());
        args.extend(strings(["--restart", "no"]));
        for arg in &helper.arguments()[1..] {
            args.push(super::offline_qualification::path(arg)?.into_os_string());
        }
        let reply = self.mutate(args)?;
        let id = std::str::from_utf8(&reply)?.trim();
        ContainerId::parse(id).map_err(|_| "helper create identity unconfirmed".into())
    }

    pub fn start(&self, cid: &ContainerId) -> Result<()> {
        self.on_exact_id("start", cid)
    }

    pub fn remove(&self, cid: &ContainerId) -> Result<()> {
        self.on_exact_id("rm", cid)
    }

    fn on_exact_id(&self, verb: &str, cid: &ContainerId) -> Result<()> {
        let mut args = endpoint(&self.socket);
        args.extend(strings([verb, cid.as_str()]));
        self.mutate(args)?;
        Ok(())
    }

    fn mutate(&self, args: Vec<OsString>) -> Result<Vec<u8>> {
        self.confirm()?;
        let cli = CapturedClient::new(installed()?);
        let output = capture(
            &cli,
            args,
            READ_TIME,
            METADATA_BYTES,
            "engine operation failed",
        )?;
        self.confirm()?;
        Ok(output)
    }

    fn confirm(&self) -> Result<()> {
        if socket_identity(&self.socket)? != self.identity {
            return Err("local engine socket changed during maintenance".into());
        }
        Ok(())
    }
}
