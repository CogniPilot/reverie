//! Fixed descriptive leaf creation under one actual pinned scratch directory.
//! Occupied leaves are preserved without following; failed attempts never unlink.
use super::*;
use crate::worker_storage::{LabelDisposition, StorageError, StoragePaths};
#[cfg(test)]
mod tests;
use std::time::{SystemTime, UNIX_EPOCH};
const LEAF: &str = ".reverie-drive.json";
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Hooks {
    pub before_create: Option<Box<dyn FnOnce()>>,
    pub after_write: Option<Box<dyn FnOnce()>>,
    pub partial_write: bool,
    pub close_error: bool,
    pub clock: Option<f64>,
}
#[cfg(test)]
thread_local! {pub(crate) static HOOKS:std::cell::RefCell<Hooks>=std::cell::RefCell::new(Hooks::default());}
fn now() -> f64 {
    #[cfg(test)]
    if let Some(clock) = HOOKS.with(|slot| slot.borrow().clock) {
        return clock;
    }
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_secs_f64(),
        Err(error) => -error.duration().as_secs_f64(),
    }
}
fn exists(directory: &Directory) -> Result<bool> {
    match native::open_at(directory.file.as_raw_fd(), OsStr::new(LEAF), libc::O_PATH) {
        Ok(anchor) => {
            close(anchor)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn current(directory: &Directory, data: &File) -> Result<()> {
    let anchor = native::open_at(directory.file.as_raw_fd(), OsStr::new(LEAF), libc::O_PATH)?;
    let result = (|| {
        let named = anchor.metadata()?;
        let held = data.metadata()?;
        need(same(&named, &held), StorageFault::ScratchLabelChanged)?;
        directory.check()
    })();
    finalized(result, close(anchor))
}
fn write_bytes(data: &mut File, bytes: &[u8]) -> Result<()> {
    #[cfg(test)]
    if HOOKS.with(|slot| std::mem::take(&mut slot.borrow_mut().partial_write)) {
        data.write_all(&bytes[..1])?;
        return Err(io::Error::from_raw_os_error(libc::ENOSPC).into());
    }
    Ok(data.write_all(bytes)?)
}
fn close_data(data: File) -> Result<()> {
    let closed = close(data);
    #[cfg(test)]
    if HOOKS.with(|slot| std::mem::take(&mut slot.borrow_mut().close_error)) {
        return finalized(closed, Err(io::Error::from_raw_os_error(libc::EIO).into()));
    }
    closed
}
pub(super) fn write(
    directory: &Directory,
    paths: &StoragePaths,
    effects: &mut bool,
) -> Result<LabelDisposition> {
    directory.check()?;
    if exists(directory)? {
        directory.check()?;
        return Ok(LabelDisposition::Preserved);
    }
    let bytes = reverie_contracts::worker_storage::scratch_label_bytes(
        paths.employee(),
        paths.session(),
        now(),
    )
    .map_err(StorageError::LabelClock)?;
    #[cfg(test)]
    {
        let hook = HOOKS.with(|slot| slot.borrow_mut().before_create.take());
        if let Some(hook) = hook {
            hook();
        }
    }
    let mut data = match native::open_at_mode(
        directory.file.as_raw_fd(),
        OsStr::new(LEAF),
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
        0o666,
    ) {
        Ok(data) => {
            *effects = true;
            data
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            directory.check()?;
            return Ok(LabelDisposition::Preserved);
        }
        Err(error) => {
            *effects = true;
            return Err(error.into());
        }
    };
    let result = (|| {
        write_bytes(&mut data, &bytes)?;
        #[cfg(test)]
        {
            let hook = HOOKS.with(|slot| slot.borrow_mut().after_write.take());
            if let Some(hook) = hook {
                hook();
            }
        }
        current(directory, &data)?;
        Ok(LabelDisposition::Created)
    })();
    finalized(result, close_data(data))
}
