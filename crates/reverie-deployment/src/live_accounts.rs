//! Explicit live-account writer disposition, never a snapshot certificate.
//! Stored inventory is DATA; each effect boundary reobserves the Engine peers.
use crate::{DeploymentError, Result, engine::Engine, model, require};
use reverie_host::deployment_snapshot::ObservedPath;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const INVALID: &str = "DEPLOYMENT_LIVE_ACCOUNTS_UNCONFIRMED";
mod process;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Account {
    source: PathBuf,
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}
impl Account {
    fn capture(source: &Path, console: &Path) -> Result<Self> {
        require(
            source.parent() == Some(console.join("accounts").as_path()),
            INVALID,
        )?;
        require(
            source.is_absolute() && source.canonicalize()? == source,
            INVALID,
        )?;
        let held = ObservedPath::capture(source).map_err(|_| DeploymentError::new(INVALID))?;
        let result = (|| {
            let m = std::fs::metadata(source)?;
            require(m.is_dir() && held.identity() == (m.dev(), m.ino()), INVALID)?;
            held.verify().map_err(|_| DeploymentError::new(INVALID))?;
            Ok(Self {
                source: source.into(),
                device: m.dev(),
                inode: m.ino(),
                uid: m.uid(),
                gid: m.gid(),
                mode: m.mode(),
            })
        })();
        DeploymentError::finalized(
            result,
            held.close().map_err(|_| DeploymentError::new(INVALID)),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Writer {
    id: String,
    image: String,
    configuration: Value,
    pid: u64,
    started: String,
    process_birth: String,
    mount_namespace: String,
    accounts: Vec<Account>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Inventory {
    version: u32,
    console: PathBuf,
    writers: Vec<Writer>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAccountWriterPreview {
    pub container_id: String,
    pub image_id: String,
    pub account_sources: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAccountDispositionPreview {
    pub policy: String,
    pub writers: Vec<LiveAccountWriterPreview>,
    pub backup_consistency: String,
    pub code_rollback_guaranteed: bool,
    pub automatic_data_restore: bool,
}

fn rows(value: &Value) -> Result<&[Value]> {
    let rows = value
        .as_array()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    require(rows.len() <= 512, INVALID)?;
    let mut ids = BTreeSet::new();
    for row in rows {
        let id = model::cid(model::string(row, "Id")?)?;
        require(ids.insert(id), INVALID)?;
        require(
            matches!(
                row["State"].as_str(),
                Some("running" | "paused" | "restarting")
            ),
            INVALID,
        )?;
    }
    Ok(rows)
}

fn accounts(container: &Value, console: &Path) -> Result<Vec<Account>> {
    let mounts = container["Mounts"]
        .as_array()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    let mut accounts = Vec::new();
    for mount in mounts {
        let writable = mount["RW"]
            .as_bool()
            .ok_or_else(|| DeploymentError::new(INVALID))?;
        if !writable || mount["Type"] == "tmpfs" {
            continue;
        }
        require(
            matches!(mount["Type"].as_str(), Some("bind" | "volume")),
            INVALID,
        )?;
        let source = Path::new(model::string(mount, "Source")?);
        require(source.is_absolute(), INVALID)?;
        let canonical = source.canonicalize()?;
        if !canonical.starts_with(console) && !console.starts_with(&canonical) {
            continue;
        }
        require(mount["Type"] == "bind", INVALID)?;
        accounts.push(Account::capture(source, console)?);
    }
    accounts.sort_by(|a, b| a.source.cmp(&b.source));
    require(
        accounts
            .windows(2)
            .all(|pair| pair[0].source != pair[1].source),
        INVALID,
    )?;
    Ok(accounts)
}

fn writer(
    row: &Value,
    observed: &Value,
    console: &Path,
    process_birth: String,
    mount_namespace: String,
) -> Result<Writer> {
    let id = model::cid(model::string(row, "Id")?)?;
    let image = model::image_id(model::string(row, "ImageID")?)?;
    require(observed["Id"] == id && observed["Image"] == image, INVALID)?;
    require(
        row["State"] == "running"
            && observed["State"]["Running"] == true
            && observed["State"]["Paused"] == false
            && observed["State"]["Restarting"] == false
            && observed["State"]["Dead"] == false,
        INVALID,
    )?;
    let pid = observed["State"]["Pid"]
        .as_u64()
        .filter(|p| *p > 0)
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    let started = model::string(&observed["State"], "StartedAt")?;
    require(
        !started.is_empty() && started.len() <= 128 && !started.chars().any(char::is_control),
        INVALID,
    )?;
    let accounts = accounts(observed, console)?;
    require(accounts == self::accounts(row, console)?, INVALID)?;
    Ok(Writer {
        id: id.into(),
        image: image.into(),
        configuration: model::projection(observed),
        pid,
        started: started.into(),
        process_birth,
        mount_namespace,
        accounts,
    })
}

fn census(value: &Value) -> Result<Value> {
    let mut rows = rows(value)?.to_vec();
    rows.sort_by_key(|row| row["Id"].as_str().unwrap_or_default().to_owned());
    Ok(Value::Array(rows.into_iter().map(|row| serde_json::json!({
        "Id":row["Id"],"ImageID":row["ImageID"],"State":row["State"],"Mounts":row["Mounts"]
    })).collect()))
}

impl Inventory {
    pub(crate) fn capture(engine: &Engine, console: &Path, websites: &[&str]) -> Result<Self> {
        require(
            console.is_absolute() && console.canonicalize()? == console && console.is_dir(),
            INVALID,
        )?;
        require(!websites.is_empty() && websites.len() <= 2, INVALID)?;
        for id in websites {
            model::cid(id)?;
        }
        let before = engine.json("GET", "/containers/json", None)?;
        let mut observations = Vec::new();
        for row in rows(&before)? {
            let id = model::string(row, "Id")?;
            if websites.contains(&id) {
                continue;
            }
            if !process::has_host_writer(row)? {
                continue;
            }
            observations.push(process::observe_writer(engine, row, console)?);
        }
        require(observations.len() <= 128, INVALID)?;
        observations.sort_by(|a, b| a.id.cmp(&b.id));
        let after = engine.json("GET", "/containers/json", None)?;
        require(census(&before)? == census(&after)?, INVALID)?;
        // The census await can outlive an earlier PID/config observation.
        // Recheck every known writer after it, including its physical bind.
        for expected in &observations {
            let row = rows(&after)?
                .iter()
                .find(|row| row["Id"] == expected.id)
                .ok_or_else(|| DeploymentError::new(INVALID))?;
            require(
                process::observe_writer(engine, row, console)? == *expected,
                "DEPLOYMENT_LIVE_ACCOUNT_WRITERS_CHANGED",
            )?;
        }
        let writers = observations
            .into_iter()
            .filter(|writer| !writer.accounts.is_empty())
            .collect();
        Ok(Self {
            version: 1,
            console: console.into(),
            writers,
        })
    }
    pub(crate) fn validate(&self, console: &Path) -> Result<()> {
        require(
            self.version == 1
                && self.console == console
                && !self.writers.is_empty()
                && self.writers.len() <= 128,
            INVALID,
        )?;
        require(
            self.writers.windows(2).all(|pair| pair[0].id < pair[1].id),
            INVALID,
        )?;
        for writer in &self.writers {
            model::cid(&writer.id)?;
            model::image_id(&writer.image)?;
            require(
                writer.configuration["Id"] == writer.id
                    && writer.configuration["Image"] == writer.image
                    && writer.pid > 0
                    && !writer.started.is_empty()
                    && !writer.process_birth.is_empty()
                    && writer.process_birth.len() <= 20
                    && writer.process_birth.bytes().all(|b| b.is_ascii_digit())
                    && process::valid_namespace(&writer.mount_namespace)
                    && !writer.accounts.is_empty(),
                INVALID,
            )?;
            for account in &writer.accounts {
                require(
                    account.source.parent() == Some(console.join("accounts").as_path()),
                    INVALID,
                )?;
            }
        }
        Ok(())
    }
    pub(crate) fn require_current(&self, engine: &Engine, websites: &[&str]) -> Result<()> {
        self.validate(&self.console)?;
        require(
            &Self::capture(engine, &self.console, websites)? == self,
            "DEPLOYMENT_LIVE_ACCOUNT_WRITERS_CHANGED",
        )
    }
    pub(crate) fn preview(&self) -> LiveAccountDispositionPreview {
        let writers = self
            .writers
            .iter()
            .map(|writer| LiveAccountWriterPreview {
                container_id: writer.id.clone(),
                image_id: writer.image.clone(),
                account_sources: writer
                    .accounts
                    .iter()
                    .map(|account| account.source.clone())
                    .collect(),
            })
            .collect();
        LiveAccountDispositionPreview {
            policy: "live-accounts-fix-forward".into(),
            writers,
            backup_consistency: "unverified-live-copy".into(),
            code_rollback_guaranteed: false,
            automatic_data_restore: false,
        }
    }
}
