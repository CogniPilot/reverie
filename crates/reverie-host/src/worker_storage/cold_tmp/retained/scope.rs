//! Relationship observations over fixed original storage and actual mounts.
//! This does not inspect or enumerate any entry inside the old TMP tree.
use super::{super::*, mappings::Mappings};
use crate::reservation_kernel::ReservationKernel;
use reverie_contracts::{
    kernel_mounts::MountTable,
    worker_cold_tmp::{ColdConfiguration, RetainedLeaseRecord},
};

pub(in crate::worker_storage::cold_tmp) struct RetirementPaths {
    target: PosixPath,
    scope: PosixPath,
    ancestors: BTreeSet<String>,
    mappings: Mappings,
    kernel: ReservationKernel,
    mounts: MountTable,
}
impl RetirementPaths {
    pub(in crate::worker_storage::cold_tmp) fn capture(
        config: &Configuration,
        paths: &StoragePaths,
        policy: &ColdConfiguration,
        end: Instant,
    ) -> Result<Self> {
        check(end)?;
        let original = super::super::super::temporary::path_text(config, paths)?;
        let scope = original.scratch().clone();
        let target = scope.join(&PosixPath::from_scalar_text("tmp"));
        need(
            target.is_absolute()
                && native::resolve_strict_text(&target.codepoints())? == target
                && native::resolve_strict_text(&scope.codepoints())? == scope,
            StorageFault::ColdLease,
        )?;
        let mut current = target.clone();
        let mut ancestors = BTreeSet::new();
        loop {
            check(end)?;
            let info = std::fs::symlink_metadata(native::python_path(&current.codepoints())?)?;
            need(info.is_dir(), StorageFault::ColdLease)?;
            ancestors.insert(format!("{}-{}", info.dev(), info.ino()));
            if current == scope {
                break;
            }
            let parent = current.parent();
            need(parent != current, StorageFault::ColdLease)?;
            current = parent;
        }
        let kernel = ReservationKernel::new();
        let mounts = kernel.mount_table(end).map_err(kernel_error)?;
        need(
            !mounts
                .rows()
                .iter()
                .any(|row| row.point() != &target && row.point().is_relative_to(&target)),
            StorageFault::ColdMount,
        )?;
        Ok(Self {
            target,
            scope,
            ancestors,
            mappings: Mappings::capture(config, paths, policy)?,
            kernel,
            mounts,
        })
    }
    pub(in crate::worker_storage::cold_tmp) fn ancestor(&self, key: &str) -> bool {
        self.ancestors.contains(key)
    }
    pub(in crate::worker_storage::cold_tmp) fn classify(
        &self,
        record: &RetainedLeaseRecord,
        key: &str,
        active: bool,
        end: Instant,
    ) -> Result<bool> {
        check(end)?;
        let path = record
            .registered_path()
            .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
        let mut relevant = self.lexical(&path);
        if active {
            let physicals = self.mappings.candidates(&path, key, end)?;
            need(
                !physicals.is_empty() && physicals.len() <= 32,
                StorageFault::ColdLease,
            )?;
            for physical in physicals {
                check(end)?;
                let native = native::python_path(&physical.codepoints())?;
                let info = std::fs::metadata(native)?;
                need(
                    native::resolve_strict_text(&physical.codepoints())? == physical
                        && info.is_dir()
                        && format!("{}-{}", info.dev(), info.ino()) == key,
                    StorageFault::ColdLease,
                )?;
                relevant |= self.lexical(&physical)
                    || self
                        .kernel
                        .cold_retained_related(
                            &self.target,
                            &self.scope,
                            &physical,
                            &self.mounts,
                            end,
                        )
                        .map_err(kernel_error)?;
            }
        }
        Ok(relevant)
    }
    fn lexical(&self, path: &PosixPath) -> bool {
        path.is_relative_to(&self.target)
            || (self.target.is_relative_to(path) && path.is_relative_to(&self.scope))
    }
}
fn kernel_error(error: crate::reservation_kernel::ReservationKernelError) -> StorageError {
    StorageError::ColdKernel(Box::new(error))
}
