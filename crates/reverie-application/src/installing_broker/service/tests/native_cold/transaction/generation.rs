//! The parent retains actual child handles and a native process observer across
//! two genuine broker owners. No CLI instance installation or global NSS marker.
use super::*;
use serde::{Deserialize, Serialize};
use std::{
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    process::{Child, Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
mod actors;
mod observer;
use observer::Observer;

const ACTOR: &str =
    "installing_broker::service::tests::native_cold::generation::native_broker_generation_actor";
const SECONDS: u64 = 330;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Layout {
    version: u8,
    purpose: String,
    original: String,
    replacement: String,
    sibling: String,
    original_employee: String,
    sibling_employee: String,
    expires_at_ms: u64,
}
impl Layout {
    fn capture(tenant: &Tenant) -> Result<Self> {
        let raw: serde_json::Value = read_json(&tenant.root.join("company.json"))?;
        let fresh = || {
            reverie_host::resource_facts::fresh_owner_nonce()
                .map(|v| v.as_str().to_owned())
                .map_err(|e| e.to_string())
        };
        Ok(Self {
            version: 1,
            purpose: "native-broker-generation-canary-v1".into(),
            original: tenant.sid.as_str().into(),
            replacement: fresh()?,
            sibling: fresh()?,
            original_employee: raw["employees"][0]["id"]
                .as_str()
                .ok_or("original employee")?
                .into(),
            sibling_employee: fresh()?,
            expires_at_ms: epoch_ms()?
                .checked_add(SECONDS * 1000)
                .ok_or("fixed original expiry")?,
        })
    }
    fn end(&self) -> Result<Instant> {
        let remaining = self
            .expires_at_ms
            .checked_sub(epoch_ms()?)
            .filter(|n| *n <= SECONDS * 1000)
            .ok_or("original generation deadline expired")?;
        Ok(Instant::now() + Duration::from_millis(remaining))
    }
    fn session(&self, value: &str) -> Result<ProfileSessionId> {
        ProfileSessionId::parse(value).map_err(|e| e.to_string())
    }
}

pub(in crate::installing_broker::service::tests::native_cold) fn run() -> Result<()> {
    let inputs = Inputs::capture()?;
    let tenant = Tenant::new(&inputs)?;
    eprintln!(
        "NATIVE_BROKER_GENERATION_TENANT root={}",
        tenant.root.display()
    );
    let layout = Layout::capture(&tenant)?;
    prepare_two_workers(&tenant, &layout)?;
    let end = layout.end()?;
    let mut observer = Observer::new(&inputs, &tenant, end)?;
    let mut original = Actor::spawn(&tenant.root, "original", end)?;
    original.until_file(&tenant.root.join("generation-original-ready.json"))?;
    let ready: serde_json::Value = read_json(&tenant.root.join("generation-original-ready.json"))?;
    let sibling = observer.capture(&ready["sibling"], &layout.sibling)?;
    observer.capture(&ready["original"], &layout.original)?;
    observer.same(&sibling, "before-original-process-close")?;
    publish(
        &tenant.root.join("generation-close-original"),
        b"close only original library service",
    )?;
    original.wait_code(101)?;
    require(
        tenant
            .root
            .join("generation-original-retained.json")
            .is_file(),
        "original retained service outcome must be recorded before process exit",
    )?;
    observer.same(&sibling, "after-original-process-exit")?;
    let mut replacement = Actor::spawn(&tenant.root, "replacement", end)?;
    replacement.until_file(&tenant.root.join("generation-replacement-ready.json"))?;
    let replacement_ready: serde_json::Value =
        read_json(&tenant.root.join("generation-replacement-ready.json"))?;
    observer.capture(&replacement_ready["current"], &layout.replacement)?;
    observer.same(&sibling, "after-recovery-reattach-and-new-session")?;
    verify_sibling_intent(&tenant, &layout)?;
    publish(
        &tenant.root.join("generation-complete-cohort"),
        b"release only private fixed workloads",
    )?;
    replacement.wait_code(0)?;
    observer.require_removed(&[
        &ready["original"],
        &ready["sibling"],
        &ready["anchor"],
        &replacement_ready["current"],
    ])?;
    observer.close()?;
    let final_state: serde_json::Value = read_json(&tenant.root.join("generation-closed.json"))?;
    require(
        final_state["replacementOwnersClosed"] == true && final_state["oldLeaseReleased"] == true,
        "actual replacement-owned finalization and old lease closure",
    )?;
    println!(
        "REAL_NATIVE_BROKER_GENERATION_OK sibling=CID+init+controller+command+publication unchanged originalProcess=exited originalClosure=unconfirmed retired=stopped+leaseReleased replacement=coldStarted reattach=working replacementOwners=closed root={}",
        tenant.root.display()
    );
    Ok(())
}

fn prepare_two_workers(tenant: &Tenant, layout: &Layout) -> Result<()> {
    replace_json(
        &tenant.root.join("company.json"),
        &serde_json::json!({"employees":[
            {"id":layout.original_employee,"owner":null,"sessionId":layout.original,"sessionGeneration":1,"desiredRunning":true,"onVacation":false},
            sibling_record(layout)
        ]}),
    )?;
    let mut raw: serde_json::Value = read_json(&tenant.source)?;
    raw["maxWorkers"] = 2.into();
    replace_json(&tenant.source, &raw)?;
    let config =
        crate::worker_validation::load_owner_config(&tenant.source).map_err(|e| e.to_string())?;
    let marker = tenant.root.join("state/resource-reservation-control.json");
    let mut data: serde_json::Value = read_json(&marker)?;
    data["configurationDigest"] =
        reverie_contracts::reservation_control::domain_digest(config.configuration())
            .map_err(|e| e.to_string())?
            .to_hex()
            .into();
    replace_json(&marker, &data)?;
    tenant::write(
        &tenant.root.join("generation.json"),
        &serde_json::to_vec(layout).map_err(|e| e.to_string())?,
    )
}
fn sibling_record(layout: &Layout) -> serde_json::Value {
    serde_json::json!({"id":layout.sibling_employee,"owner":null,"sessionId":layout.sibling,"sessionGeneration":1,"desiredRunning":true,"onVacation":false,"planId":"synthetic-unchanged-plan"})
}
fn verify_sibling_intent(tenant: &Tenant, layout: &Layout) -> Result<()> {
    let rows: serde_json::Value = read_json(&tenant.root.join("company.json"))?;
    require(
        rows["employees"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == layout.sibling_employee))
            == Some(&sibling_record(layout)),
        "untouched sibling identity/intent/vacation/plan binding must remain exact",
    )
}

pub(in crate::installing_broker::service::tests::native_cold) fn actor() -> Result<()> {
    let role = std::env::var("REVERIE_NATIVE_GENERATION_ACTOR")
        .map_err(|_| "private actor role required")?;
    require(
        matches!(role.as_str(), "original" | "replacement"),
        "closed actor role",
    )?;
    let inputs = Inputs::capture()?;
    let root = PathBuf::from(
        std::env::var_os("REVERIE_NATIVE_GENERATION_TENANT")
            .ok_or("private actor tenant required")?,
    );
    let meta = fs::symlink_metadata(&root).map_err(|e| e.to_string())?;
    require(
        root.parent() == Some(inputs.parent.as_path())
            && fs::canonicalize(&root).map_err(|e| e.to_string())? == root
            && meta.is_dir()
            && meta.uid() == 1000
            && meta.mode() & 0o777 == 0o700,
        "same fixed private synthetic tenant",
    )?;
    let layout: Layout = read_json(&root.join("generation.json"))?;
    require(
        layout.version == 1 && layout.purpose == "native-broker-generation-canary-v1",
        "closed generation actor descriptor",
    )?;
    let sid = layout.session(&layout.original)?;
    layout.session(&layout.replacement)?;
    layout.session(&layout.sibling)?;
    let source = root.join("worker.json");
    let config = crate::worker_validation::load_owner_config(&source)
        .map_err(|e| e.to_string())?
        .configuration()
        .clone();
    let deployment = format!("coldj{}", &sid.as_str()[..8]);
    let tenant = Tenant {
        root,
        source,
        server: format!("{deployment}-office"),
        deployment,
        sid,
        config,
    };
    let end = layout.end()?;
    let mut attempt = Attempt::from_tenant(inputs, tenant, end)?;
    let records = attempt.tenant.root.join(format!("generation-{role}"));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&records)
        .map_err(|e| e.to_string())?;
    attempt.cli = Cli::new(attempt.inputs.docker.clone(), records, end);
    let body = match role.as_str() {
        "original" => actors::original(&mut attempt, &layout),
        "replacement" => actors::replacement(&mut attempt, &layout),
        _ => unreachable!("closed role checked before constructors"),
    };
    if body.is_err()
        && let Err(error) = attempt.preserve_create_diagnostics()
    {
        eprintln!("GENERATION_CREATE_DIAGNOSTICS_RETAINED: {error}");
    }
    body
}

struct Actor {
    child: Option<Child>,
    end: Instant,
}
impl Actor {
    fn spawn(root: &Path, role: &str, end: Instant) -> Result<Self> {
        let file = |suffix: &str| {
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(root.join(format!("generation-{role}.{suffix}")))
                .map_err(|e| e.to_string())
        };
        let child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .args([
                "--exact",
                ACTOR,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("REVERIE_NATIVE_GENERATION_ACTOR", role)
            .env("REVERIE_NATIVE_GENERATION_TENANT", root)
            .stdin(Stdio::null())
            .stdout(file("stdout")?)
            .stderr(file("stderr")?)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            child: Some(child),
            end,
        })
    }
    fn until_file(&mut self, path: &Path) -> Result<()> {
        while missing(path)? {
            require(
                self.child
                    .as_mut()
                    .expect("same child")
                    .try_wait()
                    .map_err(|e| e.to_string())?
                    .is_none(),
                "original actor exited before its phase receipt",
            )?;
            require(
                Instant::now() < self.end,
                "original actor wait expired; no kill/replay",
            )?;
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
    fn wait_code(&mut self, code: i32) -> Result<()> {
        loop {
            if let Some(status) = self
                .child
                .as_mut()
                .expect("same child")
                .try_wait()
                .map_err(|e| e.to_string())?
            {
                require(
                    status.code() == Some(code),
                    "actual actor exit must match its retained/known-close phase",
                )?;
                self.child = None;
                return Ok(());
            }
            require(
                Instant::now() < self.end,
                "original actor join expired; retain without signals/replay",
            )?;
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Actor {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            std::mem::forget(child);
        }
    }
}
fn epoch_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "bounded epoch".into())
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    require(
        info.is_file()
            && info.uid() == 1000
            && info.nlink() == 1
            && info.mode() & 0o077 == 0
            && info.len() <= 1_048_576,
        "private bounded synthetic receipt",
    )?;
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn replace_json(path: &Path, value: &serde_json::Value) -> Result<()> {
    let temporary = path.with_extension("generation-next");
    tenant::write(
        &temporary,
        &serde_json::to_vec(value).map_err(|e| e.to_string())?,
    )?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}
fn publish(path: &Path, bytes: &[u8]) -> Result<()> {
    let partial = path.with_extension("unpublished");
    tenant::write(&partial, bytes)?;
    require(missing(path)?, "no replacement of existing phase receipt")?;
    fs::rename(partial, path).map_err(|e| e.to_string())
}
