//! Relevant namespace observations over the actual complete engine census.
//! This snapshot is private DATA and never a retained permission to mutate.
use super::*;
use reverie_contracts::{
    kernel_mounts::MountTable,
    reservation_engine::StoragePathText,
    worker_cold_tmp::{ColdBind, ColdContainer},
};
pub(super) struct CensusMounts {
    target: PosixPath,
    control: PosixPath,
    retained: Option<PosixPath>,
    protected: BTreeSet<Key>,
    kernel: ReservationKernel,
    host: MountTable,
    end: Instant,
}
impl CensusMounts {
    pub(super) fn capture(
        config: &Configuration,
        original: &StoragePathText,
        paths: &StoragePaths,
        policy: &ColdConfiguration,
        keys: &BTreeSet<Key>,
        end: Instant,
    ) -> OwnerResult<Self> {
        let target = original.scratch().join(&PosixPath::from_scalar_text("tmp"));
        let control = original.home().parent();
        let mut protected = keys.clone();
        let native_target =
            native::python_path(&target.codepoints()).map_err(StorageOwnerError::Path)?;
        let scratch = config.scratch().map_err(StorageOwnerError::Storage)?;
        let mut path = native_target.as_path();
        loop {
            let info = std::fs::metadata(path).map_err(StorageOwnerError::Path)?;
            protected.insert((info.dev(), info.ino()));
            if path == scratch {
                break;
            }
            path = path
                .parent()
                .ok_or(StorageOwnerError::Refused("WORKER_COLD_STORAGE_PATH"))?;
        }
        let kernel = ReservationKernel::new();
        let host = kernel
            .mount_table(end)
            .map_err(StorageOwnerError::ColdKernel)?;
        let retained = if policy.strategy() == ColdStrategy::RetainAndReplace {
            let scratch = PosixPath::try_new(config.settings.scratch_root().codepoints())
                .expect("checked config codepoints");
            let kind = if paths.employee().is_some() {
                "employee"
            } else {
                "session"
            };
            Some(
                scratch
                    .join(&PosixPath::from_scalar_text(".reverie-retained-tmp"))
                    .join(&PosixPath::from_scalar_text(&format!(
                        "{kind}-{}",
                        paths.identity()
                    ))),
            )
        } else {
            None
        };
        Ok(Self {
            target,
            control,
            retained,
            protected,
            kernel,
            host,
            end,
        })
    }
    pub(super) fn declared(&self, policy: &ColdConfiguration) -> OwnerResult<()> {
        for declared in policy.mounts().map_err(StorageOwnerError::ColdData)? {
            let selected = declared.source().map_err(StorageOwnerError::ColdData)?;
            let real = native::resolve_strict_text(selected.codepoints())
                .map_err(StorageOwnerError::Path)?;
            self.kernel
                .cold_host_aliases(&self.control, &real, &self.host, self.end)
                .map_err(StorageOwnerError::ColdKernel)?;
            if let Some(retained) = &self.retained {
                self.kernel
                    .cold_host_aliases(retained, &real, &self.host, self.end)
                    .map_err(StorageOwnerError::ColdKernel)?;
            }
        }
        Ok(())
    }
    pub(super) fn rows(&self, rows: &ColdInventory, name: &str) -> OwnerResult<()> {
        for row in rows.rows() {
            self.row(row, name)?;
        }
        Ok(())
    }
    fn row(&self, row: &ColdContainer, name: &str) -> OwnerResult<()> {
        let state = row.state().map_err(StorageOwnerError::ColdData)?;
        require(!row.named(name), "WORKER_COLD_PRIOR_LAPTOP_PRESENT")?;
        if !state.active() {
            return Ok(());
        }
        let container = if row.has_bind().map_err(StorageOwnerError::ColdData)? {
            Some(
                self.kernel
                    .cold_process_mounts(state.pid_text(), self.end)
                    .map_err(StorageOwnerError::ColdKernel)?,
            )
        } else {
            None
        };
        for bind in row.mounts().map_err(StorageOwnerError::ColdData)? {
            if let Some(bind) = bind.map_err(StorageOwnerError::ColdData)? {
                self.bind(
                    bind,
                    container.as_ref().expect("actual bind table observed"),
                )?;
            }
        }
        Ok(())
    }
    fn bind(&self, bind: ColdBind<'_>, container: &MountTable) -> OwnerResult<()> {
        let selected = bind.source().map_err(StorageOwnerError::ColdData)?;
        let lexical = PosixPath::try_new(selected.codepoints())
            .map_err(|_| StorageOwnerError::Refused("WORKER_COLD_BIND_SOURCE"))?;
        require(lexical.is_absolute(), "WORKER_COLD_BIND_SOURCE")?;
        let real =
            native::resolve_strict_text(&lexical.codepoints()).map_err(StorageOwnerError::Path)?;
        let info = std::fs::metadata(
            native::python_path(&real.codepoints()).map_err(StorageOwnerError::Path)?,
        )
        .map_err(StorageOwnerError::Path)?;
        require(
            !self.protected.contains(&(info.dev(), info.ino()))
                && !self.target.overlaps(&lexical)
                && !self.target.overlaps(&real),
            "WORKER_COLD_LIVE_REFERENCE",
        )?;
        let destination = bind.destination().map_err(StorageOwnerError::ColdData)?;
        let destination_path = PosixPath::try_new(destination.codepoints())
            .map_err(|_| StorageOwnerError::Refused("WORKER_COLD_BIND_DESTINATION"))?;
        require(
            destination_path.is_absolute()
                && destination_path.codepoints() == destination.codepoints(),
            "WORKER_COLD_BIND_DESTINATION",
        )?;
        self.kernel
            .cold_live_aliases(
                &self.target,
                &real,
                &destination_path,
                &self.host,
                container,
                self.end,
            )
            .map_err(StorageOwnerError::ColdKernel)?;
        if let Some(retained) = &self.retained {
            self.kernel
                .cold_live_aliases(
                    retained,
                    &real,
                    &destination_path,
                    &self.host,
                    container,
                    self.end,
                )
                .map_err(StorageOwnerError::ColdKernel)?;
        }
        if bind.writable().map_err(StorageOwnerError::ColdData)? {
            self.kernel
                .cold_live_aliases(
                    &self.control,
                    &real,
                    &destination_path,
                    &self.host,
                    container,
                    self.end,
                )
                .map_err(StorageOwnerError::ColdKernel)?;
        }
        Ok(())
    }
}
