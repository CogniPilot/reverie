//! Original lease.retirement protocol on the SAME held Bases. No old-tree walk,
//! PID/heartbeat inference or reconstructed lock owner is available here.
use super::super::*;
use super::{Base, Bases};
use crate::worker_storage::cold_tmp::retained::scope::RetirementPaths;
use reverie_contracts::worker_cold_tmp::{
    ColdLeaseState, RetainedLeaseKind, RetainedLeaseName, RetainedLeaseRecord,
};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    time::{SystemTime, UNIX_EPOCH},
};
mod records;
#[cfg(test)]
mod tests;
const MAX_RECORDS: usize = 4096;
pub(in crate::worker_storage::cold_tmp) struct Inventory {
    pub(in crate::worker_storage::cold_tmp) registered: usize,
    pub(in crate::worker_storage::cold_tmp) relevant: usize,
}
impl Bases {
    pub(in crate::worker_storage::cold_tmp) fn retained_locks(
        &mut self,
        paths: &RetirementPaths,
        end: Instant,
    ) -> Result<Inventory> {
        self.check(end)?;
        let mut inventory = Inventory {
            registered: 0,
            relevant: 0,
        };
        for base in &mut self.bases {
            base.retained_inventory(paths, &mut inventory, end)?;
        }
        self.check(end)?;
        Ok(inventory)
    }
}
type Groups = BTreeMap<String, Vec<(OsString, RetainedLeaseKind)>>;
fn group(names: Vec<OsString>) -> Result<Groups> {
    let mut groups = Groups::new();
    for name in names {
        if name == "barrier.lock" {
            continue;
        }
        let text = name
            .to_str()
            .ok_or(StorageError::Refused(StorageFault::ColdLease))?;
        let parsed = RetainedLeaseName::parse(text)
            .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
        let key = parsed.key().to_owned();
        let kind = parsed.kind();
        groups.entry(key).or_default().push((name, kind));
    }
    Ok(groups)
}
impl Base {
    fn retained_inventory(
        &mut self,
        paths: &RetirementPaths,
        inventory: &mut Inventory,
        end: Instant,
    ) -> Result<()> {
        need(self.barrier.is_some(), StorageFault::ColdLease)?;
        let names = raw_names(
            &self.directory.file,
            MAX_RECORDS - inventory.registered,
            end,
        )?;
        inventory.registered += names.len();
        for (key, names) in group(names)? {
            check(end)?;
            if self.retained_group(&key, &names, paths, end)? {
                inventory.relevant += 1;
            }
        }
        Ok(())
    }
    fn retained_group(
        &mut self,
        key: &str,
        names: &[(OsString, RetainedLeaseKind)],
        paths: &RetirementPaths,
        end: Instant,
    ) -> Result<bool> {
        let records = names
            .iter()
            .filter(|(_, kind)| *kind != RetainedLeaseKind::Lock)
            .map(|(name, kind)| {
                self.retained_record(name, end)
                    .map(|record| (*kind, record))
            })
            .collect::<Result<Vec<_>>>()?;
        let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(value) => value.as_secs_f64(),
            Err(error) => -error.duration().as_secs_f64(),
        };
        let reservation = records
            .iter()
            .find(|(kind, _)| *kind == RetainedLeaseKind::Reservation)
            .map(|(_, record)| record.reservation_state(now))
            .transpose()
            .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?
            .unwrap_or(ColdLeaseState::Free);
        need(
            reservation != ColdLeaseState::Unknown,
            StorageFault::ColdLease,
        )?;
        let mut lock = None;
        let result = (|| {
            let held = if names
                .iter()
                .any(|(_, kind)| *kind == RetainedLeaseKind::Lock)
            {
                lock = Some(self.retained_open_lock(key)?);
                Self::retained_probe_lock(
                    lock.as_ref().expect("actual existing lock"),
                    self.directory.file.metadata()?.uid(),
                )?
            } else {
                false
            };
            let active = held || reservation == ColdLeaseState::InUse;
            need(!active || !records.is_empty(), StorageFault::ColdLease)?;
            let mut relevant = paths.ancestor(key);
            for (_, record) in records {
                relevant |= paths.classify(&record, key, active, end)?;
            }
            need(!relevant || !active, StorageFault::ColdLease)?;
            Ok(relevant)
        })();
        if let Some(lock) = lock {
            if result.as_ref().is_ok_and(|relevant| *relevant) {
                self.locks.push(lock);
            } else {
                return finalized(result, fs::close(lock));
            }
        }
        result
    }
    fn retained_open_lock(&self, key: &str) -> Result<File> {
        native::open_at(
            self.directory.file.as_raw_fd(),
            OsStr::new(&format!("{key}.lock")),
            libc::O_RDWR | libc::O_NONBLOCK,
        )
        .map_err(Into::into)
    }
    fn retained_probe_lock(file: &File, owner: u32) -> Result<bool> {
        let info = file.metadata()?;
        need(
            info.is_file() && info.uid() == owner && info.mode() & 0o077 == 0 && info.nlink() == 1,
            StorageFault::ColdLease,
        )?;
        match file.try_lock() {
            Ok(()) => Ok(false),
            Err(std::fs::TryLockError::WouldBlock) => Ok(true),
            Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}
