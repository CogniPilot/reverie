use super::*;
use reverie_contracts::kernel_mounts::MountTable;
use reverie_core::posix_path::PosixPath;
use reverie_host::reservation_kernel::ReservationKernel;

const INVENTORY: &str = "SCRATCH_DOCKER_INVENTORY_UNCONFIRMED";
const BIND: &str = "SCRATCH_REGISTERED_BIND_REQUIRED";

#[derive(Eq, PartialEq)]
pub(super) struct Selection {
    pub(super) root: PathBuf,
    office_id: String,
}

impl Selection {
    pub(super) fn from_office(office: &Value) -> Result<Self> {
        let office_id = model::cid(model::string(office, "Id")?)?.to_owned();
        let mut mounts = mounts(office)?
            .iter()
            .filter(|mount| mount["Destination"] == "/scratch");
        let mount = mounts.next().ok_or_else(|| DeploymentError::new(BIND))?;
        require(
            mount["Type"] == "bind" && mount["RW"] == true && mounts.next().is_none(),
            BIND,
        )?;
        let root = PathBuf::from(model::string(mount, "Source")?);
        require(
            root.is_absolute() && root.parent().is_some() && root.canonicalize()? == root,
            BIND,
        )?;
        Ok(Self { root, office_id })
    }
}

pub(super) fn blockers(selection: &Selection, inventory: &Value) -> Result<Vec<String>> {
    let rows = inventory
        .as_array()
        .ok_or_else(|| DeploymentError::new(INVENTORY))?;
    let mut identities = BTreeSet::new();
    let target = selection.root.join("laptops");
    let observation = AliasCheck::new(&target)?;
    let mut blocked = Vec::new();
    for row in rows {
        let id = model::cid(model::string(row, "Id")?)?;
        require(identities.insert(id), INVENTORY)?;
        if !active(row)? {
            continue;
        }
        if id == selection.office_id || observation.container_overlaps(row) {
            let names = row["Names"]
                .as_array()
                .ok_or_else(|| DeploymentError::new(INVENTORY))?;
            let display = names
                .first()
                .and_then(Value::as_str)
                .map_or(id, |name| name.trim_start_matches('/'));
            blocked.push(display.to_owned());
        }
    }
    require(identities.contains(selection.office_id.as_str()), INVENTORY)?;
    blocked.sort_unstable();
    Ok(blocked)
}

fn active(row: &Value) -> Result<bool> {
    match row["State"].as_str() {
        Some("running" | "paused" | "restarting" | "removing") => Ok(true),
        Some("created" | "exited" | "dead") => Ok(false),
        _ => Err(DeploymentError::new(INVENTORY)),
    }
}

fn mounts(container: &Value) -> Result<&[Value]> {
    container["Mounts"]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| DeploymentError::new(INVENTORY))
}

pub(super) struct AliasCheck<'a> {
    target: &'a Path,
    target_text: PosixPath,
    kernel: ReservationKernel,
    mounts: MountTable,
    end: Instant,
}

impl<'a> AliasCheck<'a> {
    pub(super) fn new(target: &'a Path) -> Result<Self> {
        let end = Instant::now() + Duration::from_secs(10);
        let kernel = ReservationKernel::new();
        let mounts = kernel
            .mount_table(end)
            .map_err(|_| DeploymentError::new(INVENTORY))?;
        Ok(Self {
            target,
            target_text: mount_path(target)?,
            kernel,
            mounts,
            end,
        })
    }

    fn container_overlaps(&self, row: &Value) -> bool {
        !mounts(row).is_ok_and(|mounts| {
            mounts
                .iter()
                .all(|mount| self.confirm_disjoint(mount).is_ok())
        })
    }

    fn confirm_disjoint(&self, mount: &Value) -> Result<()> {
        let kind = mount["Type"].as_str();
        if kind == Some("tmpfs") {
            return Ok(());
        }
        require(matches!(kind, Some("bind" | "volume")), INVENTORY)?;
        let declared = Path::new(model::string(mount, "Source")?);
        require(declared.is_absolute(), INVENTORY)?;
        let source = declared.canonicalize()?;
        self.confirm_path_disjoint(&source)
    }

    pub(super) fn confirm_path_disjoint(&self, source: &Path) -> Result<()> {
        require(
            !source.starts_with(self.target) && !self.target.starts_with(source),
            INVENTORY,
        )?;
        self.kernel
            .cold_host_aliases(
                &self.target_text,
                &mount_path(source)?,
                &self.mounts,
                self.end,
            )
            .map_err(|_| DeploymentError::new(INVENTORY))
    }
}

fn mount_path(path: &Path) -> Result<PosixPath> {
    path.to_str()
        .map(PosixPath::from_scalar_text)
        .ok_or_else(|| DeploymentError::new(INVENTORY))
}

#[cfg(test)]
mod tests;
