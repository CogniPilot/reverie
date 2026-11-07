//! Staged actual descriptor ownership, including every partial constructor.
//! The original old-root fd is relocated only after acknowledged fixed rename.
use super::super::*;
use super::super::{directories::Directory, leases::Bases};
use reverie_core::ids::NativeOperationId;
use std::ffi::OsStr;
#[derive(Clone, Copy)]
pub(super) enum Slot {
    Old,
    Parent,
    Control,
    Scratch,
    Retained,
    Identity,
    Epoch,
    Fresh,
}
#[derive(Default)]
pub(super) struct Held {
    directories: Vec<Option<Directory>>,
    pub(super) bases: Option<Bases>,
}
impl Held {
    pub(super) fn directory(&self, slot: Slot) -> &Directory {
        self.directories[slot as usize]
            .as_ref()
            .expect("actual staged directory")
    }
    fn push(&mut self, slot: Slot, directory: Directory) {
        assert_eq!(
            self.directories.len(),
            slot as usize,
            "fixed construction order"
        );
        self.directories.push(Some(directory));
    }
    pub(super) fn capture(
        &mut self,
        original: &reverie_contracts::reservation_engine::StoragePathText,
        config: &Configuration,
        paths: &StoragePaths,
        attempt: &NativeOperationId,
    ) -> Result<()> {
        self.push(
            Slot::Old,
            Directory::open(
                original.scratch().join(&PosixPath::from_scalar_text("tmp")),
                config.uid(),
            )?,
        );
        self.push(
            Slot::Parent,
            Directory::open(original.scratch().clone(), config.uid())?,
        );
        self.push(
            Slot::Control,
            Directory::open(original.home().parent(), config.uid())?,
        );
        need(
            self.directory(Slot::Old).stamp().mode & 0o7777 == 0o700
                && mount(&self.directory(Slot::Old).file)?
                    == mount(&self.directory(Slot::Parent).file)?,
            StorageFault::ColdMount,
        )?;
        self.markers()?;
        let scratch = PosixPath::try_new(config.settings.scratch_root().codepoints())
            .expect("checked settings codepoints");
        self.push(Slot::Scratch, Directory::open(scratch, config.uid())?);
        need(
            mount(&self.directory(Slot::Scratch).file)?
                == mount(&self.directory(Slot::Parent).file)?,
            StorageFault::ColdMount,
        )?;
        self.child(
            Slot::Scratch,
            Slot::Retained,
            OsStr::new(".reverie-retained-tmp"),
            config.uid(),
        )?;
        need(
            mount(&self.directory(Slot::Retained).file)? == mount(&self.directory(Slot::Old).file)?,
            StorageFault::ColdMount,
        )?;
        let kind = if paths.employee().is_some() {
            "employee"
        } else {
            "session"
        };
        self.child(
            Slot::Retained,
            Slot::Identity,
            OsStr::new(&format!("{kind}-{}", paths.identity())),
            config.uid(),
        )?;
        let epoch = self
            .directory(Slot::Identity)
            .create_child(OsStr::new(attempt.as_str()), config.uid())?;
        self.push(Slot::Epoch, epoch);
        need(
            self.directory(Slot::Epoch).stamp().key.0 == self.directory(Slot::Old).stamp().key.0
                && mount(&self.directory(Slot::Epoch).file)?
                    == mount(&self.directory(Slot::Old).file)?,
            StorageFault::ColdMount,
        )
    }
    fn child(&mut self, parent: Slot, child: Slot, name: &OsStr, uid: u32) -> Result<()> {
        let directory = self.directory(parent).child(name, uid)?;
        self.push(child, directory);
        Ok(())
    }
    pub(super) fn create_fresh(&mut self, attempt: &NativeOperationId, uid: u32) -> Result<()> {
        let directory = self.directory(Slot::Parent).create_child(
            OsStr::new(&format!(".cold-fresh-{}", attempt.as_str())),
            uid,
        )?;
        self.push(Slot::Fresh, directory);
        need(
            self.directory(Slot::Fresh).stamp().key.0 == self.directory(Slot::Old).stamp().key.0
                && self.directory(Slot::Fresh).stamp().key != self.directory(Slot::Old).stamp().key,
            StorageFault::ColdMount,
        )?;
        let fresh = self.directory(Slot::Fresh);
        let probe = OsStr::new(".owned-write-probe");
        let stamp = fresh.publish(probe, b"fresh TMP writable")?;
        fresh.named(probe, &stamp)?;
        nix::unistd::unlinkat(&fresh.file, probe, nix::unistd::UnlinkatFlags::NoRemoveDir)
            .map_err(std::io::Error::from)?;
        fresh.file.sync_all()?;
        self.directory(Slot::Parent).file.sync_all()?;
        Ok(())
    }
    pub(super) fn reserve(
        &mut self,
        home: &PosixPath,
        attempt: &NativeOperationId,
        end: Instant,
    ) -> Result<reverie_contracts::worker_cold_tmp::RetainedReservationUntil> {
        let epoch = self.directories[Slot::Epoch as usize]
            .as_ref()
            .expect("actual epoch");
        self.bases
            .as_mut()
            .expect("captured lease directories")
            .reserve_epoch(home, epoch, attempt, end)
    }
    pub(super) fn move_roots(&mut self, attempt: &NativeOperationId, end: Instant) -> Result<()> {
        self.directory(Slot::Old).check()?;
        #[cfg(test)]
        self.retire_collision()?;
        native::retire_cold_temporary(
            &self.directory(Slot::Parent).file,
            &self.directory(Slot::Epoch).file,
        )?;
        #[cfg(test)]
        lost_reply(super::faults::Fault::LostRetireReply)?;
        self.directory(Slot::Parent).file.sync_all()?;
        self.directory(Slot::Epoch).file.sync_all()?;
        let old = self.directories[Slot::Old as usize]
            .take()
            .expect("same old root fd");
        self.directories[Slot::Old as usize] = Some(
            old.relocated(
                self.directory(Slot::Epoch)
                    .text
                    .join(&PosixPath::from_scalar_text("data")),
            )?,
        );
        self.check(end)?;
        self.directory(Slot::Fresh).check()?;
        #[cfg(test)]
        self.install_collision()?;
        native::install_cold_temporary(&self.directory(Slot::Parent).file, attempt)?;
        #[cfg(test)]
        lost_reply(super::faults::Fault::LostInstallReply)?;
        self.directory(Slot::Parent).file.sync_all()?;
        self.directory(Slot::Fresh).file.sync_all()?;
        let fresh = self.directories[Slot::Fresh as usize]
            .take()
            .expect("same new root fd");
        self.directories[Slot::Fresh as usize] = Some(
            fresh.relocated(
                self.directory(Slot::Parent)
                    .text
                    .join(&PosixPath::from_scalar_text("tmp")),
            )?,
        );
        Ok(())
    }
    pub(super) fn check(&self, end: Instant) -> Result<()> {
        check(end)?;
        self.directory(Slot::Control).check()?;
        self.directory(Slot::Parent).check()?;
        self.bases
            .as_ref()
            .expect("captured lease directories")
            .check(end)
    }
    pub(super) fn close(mut self) -> Result<()> {
        let mut result = Ok(());
        if let Some(bases) = self.bases.take() {
            result = finalized(result, bases.close());
        }
        while let Some(directory) = self.directories.pop() {
            if let Some(directory) = directory {
                result = finalized(result, directory.close());
            }
        }
        result
    }
    fn markers(&self) -> Result<()> {
        for name in [".keep", ".reverie-task.json", ".git", ".hg", ".svn"] {
            match std::fs::symlink_metadata(self.directory(Slot::Old).path.join(name)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
                Ok(_) => return Err(StorageError::Refused(StorageFault::ColdPreservation)),
            }
        }
        Ok(())
    }
}
#[cfg(test)]
fn lost_reply(fault: super::faults::Fault) -> Result<()> {
    if super::faults::take(fault) {
        Err(std::io::Error::from_raw_os_error(libc::EIO).into())
    } else {
        Ok(())
    }
}
#[cfg(test)]
impl Held {
    fn retire_collision(&self) -> Result<()> {
        if super::faults::take(super::faults::Fault::RetireCollision) {
            self.foreign(Slot::Epoch, "data")?;
        }
        Ok(())
    }
    fn install_collision(&self) -> Result<()> {
        if super::faults::take(super::faults::Fault::InstallCollision) {
            self.foreign(Slot::Parent, "tmp")?;
        }
        Ok(())
    }
    fn foreign(&self, parent: Slot, name: &str) -> Result<()> {
        let directory = self
            .directory(parent)
            .create_child(OsStr::new(name), native::uid())?;
        let result = directory
            .publish(
                OsStr::new("foreign"),
                b"foreign collision bytes stay untouched",
            )
            .map(|_| ());
        finalized(result, directory.close())
    }
}
