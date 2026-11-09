use super::*;
use reverie_core::{
    PythonText,
    operations::{JournalDigest, OperationDocument},
};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

pub(super) struct Inputs {
    pub image: WorkerImageId,
    pub base: ArtifactReference,
    pub annex: ArtifactReference,
    pub docker: PathBuf,
    parent: PathBuf,
}
impl Inputs {
    pub(super) fn capture() -> Result<Self> {
        let selected =
            std::env::var_os("REVERIE_NATIVE_COLD_INPUTS").ok_or("reviewed inputs required")?;
        let path = PathBuf::from(selected);
        let info = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !info.is_file()
            || info.uid() != nix::unistd::geteuid().as_raw()
            || info.nlink() != 1
            || info.mode() & 0o077 != 0
            || info.len() > 65536
        {
            return Err("private bounded fixture inputs required".into());
        }
        let raw = fs::read(&path).map_err(|e| e.to_string())?;
        let frame = reverie_contracts::human_protocol::HumanFrame::decode(&raw)
            .map_err(|e| e.to_string())?;
        let value: serde_json::Value =
            serde_json::from_slice(&frame.canonical().map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let fields = value.as_object().ok_or("fixture inputs object")?;
        let names = [
            "version",
            "purpose",
            "image",
            "base",
            "annex",
            "dockerProgram",
            "tenantParent",
        ];
        if fields.len() != names.len()
            || names.iter().any(|key| !fields.contains_key(*key))
            || value["version"].as_u64() != Some(1)
            || value["purpose"] != "native-r-cold-j-fixture-v1"
        {
            return Err("closed versioned fixture inputs required".into());
        }
        let text = |key: &str| {
            value[key]
                .as_str()
                .ok_or_else(|| format!("fixture input {key}"))
        };
        let docker = PathBuf::from(text("dockerProgram")?);
        let m = fs::symlink_metadata(&docker).map_err(|e| e.to_string())?;
        if !docker.starts_with("/nix/store")
            || docker.file_name() != Some(std::ffi::OsStr::new("docker"))
            || !m.is_file()
            || m.uid() != 0
            || m.mode() & 0o222 != 0
            || m.mode() & 0o111 == 0
            || fs::canonicalize(&docker).map_err(|e| e.to_string())? != docker
        {
            return Err("fixed immutable Docker program required".into());
        }
        let parent = PathBuf::from(text("tenantParent")?);
        let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
            .map_err(|e| e.to_string())?
            .ok_or("actual NSS home required")?
            .dir;
        if parent != home.join("reverie/cj") {
            return Err("fixed private ~/reverie/cj tenant parent required".into());
        }
        let m = fs::symlink_metadata(&parent).map_err(|e| e.to_string())?;
        if !m.is_dir()
            || m.uid() != nix::unistd::geteuid().as_raw()
            || m.mode() & 0o777 != 0o700
            || parent.starts_with("/tmp")
            || fs::canonicalize(&parent).map_err(|e| e.to_string())? != parent
        {
            return Err("owned private durable tenant parent required".into());
        }
        Ok(Self {
            image: WorkerImageId::parse(text("image")?).map_err(|e| e.to_string())?,
            base: artifact(&value["base"])?,
            annex: artifact(&value["annex"])?,
            docker,
            parent,
        })
    }
}
fn artifact(value: &serde_json::Value) -> Result<ArtifactReference> {
    let fields = value.as_object().ok_or("artifact object")?;
    if fields.len() != 2 {
        return Err("closed artifact reference".into());
    }
    let path = fields
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or("artifact path")?;
    let digest = fields
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or("artifact SHA")?;
    Ok(ArtifactReference {
        path: PythonText::from_scalar_text(path),
        sha256: JournalDigest::parse(digest).map_err(|e| e.to_string())?,
    })
}
pub(super) struct Tenant {
    pub root: PathBuf,
    pub source: PathBuf,
    pub deployment: String,
    pub server: String,
    pub sid: ProfileSessionId,
    pub config: reverie_contracts::worker_config::EffectiveWorkerConfig,
}
impl Tenant {
    pub(super) fn new(inputs: &Inputs) -> Result<Self> {
        if nix::unistd::geteuid().as_raw() != 1000 || nix::unistd::getegid().as_raw() != 100 {
            return Err("image's qualified actual UID1000/GID100 required".into());
        }
        let root =
            nix::unistd::mkdtemp(&inputs.parent.join("n-XXXXXX")).map_err(|e| e.to_string())?;
        let nonce = reverie_host::resource_facts::fresh_owner_nonce().map_err(|e| e.to_string())?;
        let sid = ProfileSessionId::parse(nonce.as_str()).map_err(|e| e.to_string())?;
        let eid = reverie_host::resource_facts::fresh_owner_nonce().map_err(|e| e.to_string())?;
        let deployment = format!("coldj{}", &sid.as_str()[..8]);
        let server = format!("{deployment}-office");
        for relative in [
            "state",
            "control",
            "control/profiles",
            "control/operations",
            "work",
            "company",
            "scratch",
            "office",
            "broker",
            "anchor-home/.reverie-launch",
            "docker-config",
        ] {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(root.join(relative))
                .map_err(|e| e.to_string())?;
        }
        let raw = serde_json::json!({"version":1,"deployment":deployment,"image":inputs.image.as_str(),"serverContainer":server,"socket":root.join("broker/service.sock"),"stateRoot":root.join("state"),"companyFile":root.join("company.json"),"companyRoot":root.join("company"),"scratchRoot":root.join("scratch"),"apiSocketRoot":root.join("office"),"budgetMode":"admission","uid":1000,"gid":100,"memoryMiB":4096,"poolMemoryMiB":49152,"poolTasksMax":8192,"cgroupParent":"reverie-workers.slice","pidsLimit":128,"cpus":0,"maxWorkers":1,"mounts":[{"source":root.join("work"),"destination":"/workspace","readOnly":false}],"maintenanceSessions":[],"resourceReservations":{"directory":root.join("control"),"companyId":eid.as_str(),"poolId":sid.as_str(),"ownerScopeDigest":"d".repeat(64),"hostReserveMiB":64}});
        let bytes = serde_json::to_vec(&raw).map_err(|e| e.to_string())?;
        let source = root.join("worker.json");
        write(&source, &bytes)?;
        let config = crate::worker_validation::load_owner_config(&source)
            .map_err(|e| format!("{e:?}"))?
            .configuration()
            .clone();
        let office = root.join("office").join(sid.as_str());
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&office)
            .map_err(|e| e.to_string())?;
        if office.join("office.sock").as_os_str().len() >= 104 {
            return Err("private native socket exceeds reviewed AF_UNIX bound".into());
        }
        write(&root.join("company.json"),&serde_json::to_vec(&serde_json::json!({"employees":[{"id":eid.as_str(),"owner":null,"sessionId":sid.as_str(),"desiredRunning":true}]})).map_err(|e|e.to_string())?)?;
        for relative in [
            "control/admission.lock",
            "control/profiles/profiles.lock",
            "control/operations/operations.lock",
        ] {
            write(&root.join(relative), b"")?;
        }
        write(
            &root.join("control/operations/operations.json"),
            &reverie_contracts::operations_v1::encode(&OperationDocument::empty())
                .map_err(|e| e.to_string())?,
        )?;
        let inode = |relative: &str| -> Result<serde_json::Value> {
            let m = fs::symlink_metadata(root.join(relative)).map_err(|e| e.to_string())?;
            Ok(serde_json::json!([m.dev(), m.ino()]))
        };
        // Private setup DATA only: actual native Gate constructor/admission and
        // kernel observers below still establish all real ownership/capacity.
        let marker = serde_json::json!({"schema":"reverie-resource-control-v1","state":"READY","option":raw["resourceReservations"],"directories":{".":inode("control")?,"profiles":inode("control/profiles")?,"operations":inode("control/operations")?},"admissionLock":inode("control/admission.lock")?,"stateDirectory":inode("state")?,"locks":{"profiles":inode("control/profiles/profiles.lock")?,"operations":inode("control/operations/operations.lock")?},"configurationDigest":reverie_contracts::reservation_control::domain_digest(&config).map_err(|e|e.to_string())?.to_hex()});
        write(
            &root.join("state/resource-reservation-control.json"),
            &serde_json::to_vec(&marker).map_err(|e| e.to_string())?,
        )?;
        Ok(Self {
            root,
            source,
            deployment,
            server,
            sid,
            config,
        })
    }
    pub(super) fn name(&self) -> String {
        format!("{}-agent-{}", self.deployment, self.sid.as_str())
    }
}
pub(super) fn write(path: &Path, raw: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    let body = file
        .write_all(raw)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string());
    let closed = nix::unistd::close(file).map_err(|e| e.to_string());
    match (body, closed) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(a), Err(b)) => Err(format!("{a}; original close: {b}")),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}
