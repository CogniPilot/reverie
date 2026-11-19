//! Exact identity, isolation and completion checks for the seed helper.
use super::{
    MALFORMED, Object, Result, Value, decode_rows, field, isolated_namespaces, mounts, object,
    require, rows, text, text_is,
};
use crate::legacy_json::{Node, Number};
use reverie_core::ids::{ContainerId, OfflineStoreOperationId, ProfileSessionId};

pub enum SeedState {
    Created,
    Running,
    Completed,
    Failed,
}

pub struct SeedHelper<'a> {
    pub image: &'a str,
    pub deployment: &'a str,
    pub session: &'a ProfileSessionId,
    pub operation: &'a OfflineStoreOperationId,
    pub user: (u32, u32),
    pub store: &'a [u32],
}

impl SeedHelper<'_> {
    pub fn inspect(&self, raw: &[u8], cid: &ContainerId) -> Result<SeedState> {
        let data = decode_rows(raw)?;
        let [row] = rows(&data) else {
            return Err(MALFORMED);
        };
        let row = object(row)?;
        let config = nested(row, "Config")?;
        self.check_identity(row, config, cid)?;
        check_limits(nested(row, "HostConfig")?)?;
        self.check_mounts(mounts(row)?)?;
        state(nested(row, "State")?)
    }

    fn check_identity(&self, row: &Object, config: &Object, cid: &ContainerId) -> Result<()> {
        let labels = nested(config, "Labels")?;
        require(
            text_is(field(row, "Id"), cid.as_str())
                && text_is(field(row, "Image"), self.image)
                && text_is(field(labels, "reverie.nix-prepare"), self.deployment)
                && text_is(field(labels, "reverie.session"), self.session.as_str())
                && text_is(
                    field(labels, "reverie.offline-store-operation"),
                    self.operation.as_str(),
                ),
            "exact seed helper identity changed",
        )?;
        let (uid, gid) = self.user;
        require(
            text_is(field(config, "User"), &format!("{uid}:{gid}"))
                && matches!(field(config, "Entrypoint"), Some(Value(Node::Array(values)))
                    if matches!(values.as_slice(), [entry] if text_is(Some(entry), "/bin/reverie-nix-store-prepare"))),
            "fixed unprivileged seed entrypoint required",
        )
    }

    fn check_mounts(&self, mounts: &[Value]) -> Result<()> {
        let mut writer = false;
        for mount in mounts {
            let mount = object(mount)?;
            if text_is(field(mount, "Type"), "tmpfs") {
                continue;
            }
            require(
                text_is(field(mount, "Type"), "bind"),
                "unexpected helper volume",
            )?;
            let destination = field(mount, "Destination");
            if text_is(destination, "/target/nix") {
                require(
                    !writer
                        && flag(field(mount, "RW")) == Some(true)
                        && text(field(mount, "Source"))?.codepoints() == self.store,
                    "helper may write only this employee private Nix store",
                )?;
                writer = true;
            } else {
                require(
                    (text_is(destination, "/etc/passwd") || text_is(destination, "/etc/group"))
                        && flag(field(mount, "RW")) == Some(false),
                    "provider/home/account/workspace bind forbidden",
                )?;
            }
        }
        require(
            writer,
            "helper may write only this employee private Nix store",
        )
    }
}

fn check_limits(host: &Object) -> Result<()> {
    let restart = match field(host, "RestartPolicy") {
        None | Some(Value(Node::Null)) => None,
        Some(policy) => field(object(policy)?, "Name"),
    };
    let tmpfs = nested(host, "Tmpfs")?;
    require(
        isolated_namespaces(host)
            && flag(field(host, "Privileged")) == Some(false)
            && integer(field(host, "Memory")) == Some(512 * 1024 * 1024)
            && integer(field(host, "MemorySwap")) == Some(512 * 1024 * 1024)
            && integer(field(host, "PidsLimit")) == Some(128)
            && integer(field(host, "NanoCpus")) == Some(1_000_000_000)
            && restart.is_none_or(|name| text_is(Some(name), "no") || text_is(Some(name), ""))
            && tmpfs.len() == 2
            && field(tmpfs, "/tmp").is_some()
            && field(tmpfs, "/nix/store/.links").is_some(),
        "fixed helper isolation/resource limits required",
    )
}

fn state(value: &Object) -> Result<SeedState> {
    let running = flag(field(value, "Running")).ok_or(MALFORMED)?;
    let pid = integer(field(value, "Pid")).ok_or(MALFORMED)?;
    let status = field(value, "Status");
    if running {
        return Ok(SeedState::Running);
    }
    if pid == 0 && text_is(status, "created") {
        return Ok(SeedState::Created);
    }
    if pid == 0 && text_is(status, "exited") && integer(field(value, "ExitCode")) == Some(0) {
        return Ok(SeedState::Completed);
    }
    Ok(SeedState::Failed)
}

fn nested<'a>(parent: &'a Object, key: &str) -> Result<&'a Object> {
    object(field(parent, key).ok_or(MALFORMED)?)
}

fn flag(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value(Node::Bool(value))) => Some(*value),
        _ => None,
    }
}

fn integer(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value(Node::Number(Number::Integer(value)))) => value.parse().ok(),
        _ => None,
    }
}
