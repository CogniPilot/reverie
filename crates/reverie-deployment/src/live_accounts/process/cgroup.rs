//! Narrow virtual-filesystem evidence. A real cgroup2 superblock cannot contain
//! ordinary console files. No image/name/path label substitutes for these reads.
use super::*;
use reverie_contracts::kernel_mounts::{MAX_MOUNT_BYTES, MountTable};
use reverie_core::posix_path::PosixPath;
use sha2::{Digest, Sha256};
const UNCONFIRMED: &str = "DEPLOYMENT_CGROUP_BIND_UNCONFIRMED";

fn visible(
    table: &MountTable,
    selected: &reverie_contracts::kernel_mounts::MountRow,
) -> Result<()> {
    let mut chain = Vec::new();
    let mut current = selected;
    loop {
        require(
            chain.len() <= table.rows().len() && !chain.contains(&current.id()),
            UNCONFIRMED,
        )?;
        chain.push(current.id());
        if current.point() == &PosixPath::from_scalar_text("/") {
            break;
        }
        let parent = current
            .parent_id()
            .ok_or_else(|| DeploymentError::new(UNCONFIRMED))?;
        current = table
            .rows()
            .iter()
            .find(|row| row.id() == parent)
            .ok_or_else(|| DeploymentError::new(UNCONFIRMED))?;
    }
    // A covering mount outside this ancestry hides the selected row. Refuse
    // ambiguity instead of interpreting a hidden matching row as current.
    require(
        table
            .rows()
            .iter()
            .filter(|row| selected.point().is_relative_to(row.point()))
            .all(|row| chain.contains(&row.id())),
        UNCONFIRMED,
    )
}

fn cgroup_source(path: &Path) -> Result<bool> {
    let file = open(
        path,
        OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| DeploymentError::new(UNCONFIRMED))?;
    let result = nix::sys::statfs::fstatfs(&file)
        .map(|value| value.filesystem_type() == nix::sys::statfs::CGROUP2_SUPER_MAGIC)
        .map_err(|_| DeploymentError::new(UNCONFIRMED));
    DeploymentError::finalized(result, close(file))
}
pub(super) fn eligible(observed: &Value) -> Result<bool> {
    let mounts = observed["Mounts"]
        .as_array()
        .ok_or_else(|| DeploymentError::new(UNCONFIRMED))?;
    let mut count = 0;
    for mount in mounts {
        if !host_writer(mount)? {
            continue;
        }
        count += 1;
        if !cgroup_source(Path::new(model::string(mount, "Source")?))? {
            return Ok(false);
        }
    }
    Ok(count > 0)
}
fn target_table(pid: u64) -> Result<String> {
    let mut file = File::open(format!("/proc/{pid}/mountinfo"))?;
    let result = (|| {
        let mut raw = String::new();
        (&mut file)
            .take((MAX_MOUNT_BYTES + 1) as u64)
            .read_to_string(&mut raw)?;
        require(raw.len() <= MAX_MOUNT_BYTES, UNCONFIRMED)?;
        Ok(raw)
    })();
    DeploymentError::finalized(result, close(file))
}
struct Binding {
    destination: PosixPath,
    source: PathBuf,
    metadata: Metadata,
    backing: backing::Backing,
}
impl Binding {
    fn capture(mount: &Value, console: &Path) -> Result<Self> {
        let source = PathBuf::from(model::string(mount, "Source")?);
        require(source.is_absolute(), UNCONFIRMED)?;
        let destination = model::string(mount, "Destination")?;
        let path = Path::new(destination);
        require(
            path.is_absolute()
                && path != Path::new("/")
                && path
                    .components()
                    .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
                && !destination.bytes().any(|b| b.is_ascii_control()),
            UNCONFIRMED,
        )?;
        let backing = backing::Backing::capture(&source, console)?;
        let result = (|| {
            backing.cgroup2_origin()?;
            let metadata = fs::metadata(&source)?;
            require(metadata.is_dir(), UNCONFIRMED)?;
            Ok(metadata)
        })();
        match result {
            Ok(metadata) => Ok(Self {
                source,
                destination: PosixPath::from_scalar_text(destination),
                metadata,
                backing,
            }),
            Err(error) => DeploymentError::finalized(Err(error), backing.close()),
        }
    }
    fn verify(&self, table: &MountTable) -> Result<()> {
        self.backing.verify()?;
        let origin = self.backing.cgroup2_origin()?;
        require(
            same(&self.metadata, &fs::metadata(&self.source)?),
            UNCONFIRMED,
        )?;
        let rows: Vec<_> = table
            .rows()
            .iter()
            .filter(|row| row.point() == &self.destination)
            .collect();
        require(rows.len() == 1, UNCONFIRMED)?;
        let row = rows[0];
        visible(table, row)?;
        require(
            row.filesystem_is("cgroup2")
                && row.device() == &origin.device
                && row.root() == Some(&origin.path),
            UNCONFIRMED,
        )?;
        require(
            !table.rows().iter().any(|row| {
                row.point() != &self.destination && row.point().is_relative_to(&self.destination)
            }),
            UNCONFIRMED,
        )
    }
}
fn close_bindings(bindings: Vec<Binding>) -> Result<()> {
    let mut result = Ok(());
    for binding in bindings {
        result = DeploymentError::finalized(result, binding.backing.close());
    }
    result
}
fn parse(raw: &str) -> Result<MountTable> {
    MountTable::parse(&raw.chars().map(u32::from).collect::<Vec<_>>())
        .map_err(|_| DeploymentError::new(UNCONFIRMED))
}
pub(super) fn observe(
    engine: &Engine,
    row: &Value,
    observed: &Value,
    console: &Path,
    pid: u64,
) -> Result<Writer> {
    let started = birth(pid)?;
    let before = target_table(pid)?;
    let table = parse(&before)?;
    let observation = MountObservation::Cgroup2KernelTable {
        table_sha256: format!("{:x}", Sha256::digest(before.as_bytes())),
    };
    let expected = writer(row, observed, console, started.clone(), observation.clone())?;
    require(expected.accounts.is_empty(), UNCONFIRMED)?;
    let mut bindings = Vec::new();
    let result = (|| {
        for mount in observed["Mounts"]
            .as_array()
            .ok_or_else(|| DeploymentError::new(UNCONFIRMED))?
        {
            if !host_writer(mount)? {
                continue;
            }
            bindings.push(Binding::capture(mount, console)?);
            bindings
                .last()
                .ok_or_else(|| DeploymentError::new(UNCONFIRMED))?
                .verify(&table)?;
        }
        require(!bindings.is_empty(), UNCONFIRMED)?;
        let fresh = engine.container(&expected.id)?;
        require(
            writer(row, &fresh, console, birth(pid)?, observation)? == expected,
            PROCESS,
        )?;
        let after = target_table(pid)?;
        require(after == before && birth(pid)? == started, PROCESS)?;
        let table = parse(&after)?;
        for binding in &bindings {
            binding.verify(&table)?;
        }
        require(
            target_table(pid)? == before && birth(pid)? == started,
            PROCESS,
        )?;
        Ok(expected)
    })();
    DeploymentError::finalized(result, close_bindings(bindings))
}
