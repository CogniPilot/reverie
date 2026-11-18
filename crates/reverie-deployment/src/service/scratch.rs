//! Offline maintenance of the registered office's employee temporary mounts.
use super::*;
use reverie_host::lease::{DirectPaths, LeaseBase, RetirementPaths, retirement};
use std::{collections::BTreeSet, fs, num::NonZeroUsize, os::unix::fs::MetadataExt};
mod tree;
mod workspace;
mod writers;

const GROUPS: [&str; 3] = ["employees", "operator-recovery", "operator-sessions"];
const WORKER_HOMES: [&str; 4] = [
    "employees",
    "sessions",
    "operator-recovery",
    "operator-sessions",
];
const LEASE_UNCONFIRMED: &str = "SCRATCH_LEASE_INVENTORY_UNCONFIRMED";

impl DeploymentService {
    /// Preview or explicitly clear disposable entries in the registered scratch bind.
    pub fn prune_scratch(
        &self,
        apply: bool,
        force_read_only: bool,
        additional_leases: &[PathBuf],
    ) -> Result<Value> {
        let selection = self.storage_selection("/scratch")?;
        let layout = tree::Layout::open(selection.root.clone())?;
        let blockers = self.storage_blockers(&selection, &layout.path)?;
        if apply && !blockers.is_empty() {
            let mut blocked = report(&selection.root, &blockers, &[], true, false);
            blocked["code"] = json!("SCRATCH_IN_USE");
            return Ok(blocked);
        }
        let leases = if apply {
            Some(self.storage_leases(&layout.path, additional_leases)?)
        } else {
            None
        };
        let mut rows = Vec::new();
        for target in layout.targets()? {
            let mut inspection = target.inspect(force_read_only)?;
            if apply && inspection.has_eligible_entries() {
                let result = self.clear_scratch_target(&selection, &layout, &target, &inspection);
                record_apply(&mut inspection.row, result);
            }
            rows.push(inspection.row);
        }
        if let Some(leases) = leases {
            leases
                .finish()
                .map_err(|_| DeploymentError::new("SCRATCH_FINALIZATION_UNCONFIRMED"))?;
        }
        let success = rows.iter().all(|row| row["applyState"] != "unconfirmed");
        Ok(report(&selection.root, &blockers, &rows, apply, success))
    }

    fn clear_scratch_target(
        &self,
        selection: &writers::Selection,
        layout: &tree::Layout,
        target: &tree::Target,
        inspection: &tree::Inspection,
    ) -> Result<()> {
        let current = self.storage_selection("/scratch")?;
        require(*selection == current, "SCRATCH_BIND_CHANGED")?;
        require(
            self.storage_blockers(&current, &layout.path)?.is_empty(),
            "SCRATCH_IN_USE",
        )?;
        layout.check(target)?;
        target.clear(inspection)
    }

    fn storage_selection(&self, destination: &str) -> Result<writers::Selection> {
        self.installation.current()?;
        let office = self.engine.container(&self.installation.name)?;
        model::port_binding(&office, self.installation.port)?;
        writers::Selection::from_office(&office, destination)
    }

    fn storage_blockers(
        &self,
        selection: &writers::Selection,
        target: &Path,
    ) -> Result<Vec<String>> {
        let inventory = self.engine.json("GET", "/containers/json?all=1", None)?;
        writers::blockers(selection, target, &inventory)
    }

    fn storage_leases(
        &self,
        target: &Path,
        additional: &[PathBuf],
    ) -> Result<reverie_host::lease::Retirement> {
        let runtime = self.installation.root.join("runtime");
        let mut paths = BTreeSet::new();
        add_base(&mut paths, runtime.join("leases"), false)?;
        for category in WORKER_HOMES {
            let homes = runtime.join("workers").join(category);
            for entry in owned_homes(&homes)? {
                add_base(
                    &mut paths,
                    entry.join("home/.local/state/reverie/leases"),
                    false,
                )?;
            }
        }
        for path in additional {
            add_base(&mut paths, path.clone(), true)?;
        }
        let bases = paths
            .iter()
            .map(|base| LeaseBase::scan(base).map_err(|_| DeploymentError::new(LEASE_UNCONFIRMED)))
            .collect::<Result<Vec<_>>>()?;
        let aliases = writers::AliasCheck::new(target)?;
        for base in &bases {
            aliases
                .confirm_path_disjoint(base.path())
                .map_err(|_| DeploymentError::new(LEASE_UNCONFIRMED))?;
        }
        retirement(
            target,
            target
                .parent()
                .expect("storage selection inside registered bind"),
            &bases,
            Instant::now() + Duration::from_secs(3600),
            NonZeroUsize::new(100_000).expect("positive record threshold"),
            &mut LeasePaths(aliases),
        )
        .map_err(|error| {
            let code = match error.code() {
                reverie_host::lease::LeaseCode::InUse | reverie_host::lease::LeaseCode::Busy => {
                    "SCRATCH_LEASE_IN_USE"
                }
                reverie_host::lease::LeaseCode::Unknown => LEASE_UNCONFIRMED,
            };
            DeploymentError::new(code)
        })
    }
}

fn record_apply(row: &mut Value, result: Result<()>) {
    match result {
        Ok(()) => row["applyState"] = json!("cleared"),
        Err(error) => {
            row["applyState"] = json!("unconfirmed");
            row["code"] = json!(error.code());
        }
    }
}

struct LeasePaths<'a>(writers::AliasCheck<'a>);

impl RetirementPaths for LeasePaths<'_> {
    fn physical(&mut self, path: &Path, key: &str) -> reverie_host::lease::Result<Vec<PathBuf>> {
        DirectPaths.physical(path, key)
    }

    fn related(&mut self, physical: &Path) -> reverie_host::lease::Result<bool> {
        Ok(self.0.confirm_path_disjoint(physical).is_err())
    }
}

fn owned_homes(category: &Path) -> Result<Vec<PathBuf>> {
    match fs::read_dir(category) {
        Ok(entries) => entries
            .filter_map(|entry| match entry {
                Ok(entry) if !tree::is_uuid(&entry.file_name()) => None,
                Ok(entry) => Some(Ok(entry.path())),
                Err(error) => Some(Err(error.into())),
            })
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn add_base(bases: &mut BTreeSet<PathBuf>, path: PathBuf, required: bool) -> Result<()> {
    match path.canonicalize() {
        Ok(canonical) => {
            let info = fs::symlink_metadata(&path)?;
            require(
                path == canonical
                    && info.is_dir()
                    && info.uid() == nix::unistd::geteuid().as_raw()
                    && info.mode() & 0o077 == 0,
                LEASE_UNCONFIRMED,
            )?;
            bases.insert(path);
            Ok(())
        }
        Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(DeploymentError::new(LEASE_UNCONFIRMED)),
    }
}

fn report(
    root: &Path,
    blockers: &[String],
    targets: &[Value],
    apply: bool,
    success: bool,
) -> Value {
    fn total(targets: &[Value], name: &str) -> u64 {
        targets
            .iter()
            .filter_map(|row| row[name].as_u64())
            .fold(0, u64::saturating_add)
    }
    json!({
        "success": success,
        "mode": if apply { "apply" } else { "preview" },
        "scratch": root,
        "blockingContainers": blockers,
        "allocatedBytes": total(targets, "allocatedBytes"),
        "eligibleBytes": total(targets, "eligibleBytes"),
        "targets": targets,
    })
}
