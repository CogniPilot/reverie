//! Cache publication through the existing descriptor-anchored filesystem owner.
use crate::fs::{self, Directory, Stamp};
use std::{
    fs::DirBuilder,
    io::{self, Read, Seek, Write},
    os::unix::fs::DirBuilderExt,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP: AtomicU64 = AtomicU64::new(0);
#[derive(Debug)]
struct FinalizationError {
    primary: io::Error,
    cleanup: io::Error,
}
impl std::fmt::Display for FinalizationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            out,
            "{}; cleanup also failed: {}",
            self.primary, self.cleanup
        )
    }
}
impl std::error::Error for FinalizationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.primary)
    }
}
fn finalized<T>(result: io::Result<T>, cleanup: io::Result<()>) -> io::Result<T> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(primary), Err(cleanup)) => {
            Err(io::Error::other(FinalizationError { primary, cleanup }))
        }
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
    }
}
struct Prepared<'a> {
    directory: &'a Directory,
    file: Option<std::fs::File>,
    name: String,
    stamp: Stamp,
    published: bool,
    cleaned: bool,
}
impl Drop for Prepared<'_> {
    fn drop(&mut self) {
        // Panic fallback only; ordinary exits explicitly collect cleanup and
        // close outcomes while the creator descriptor still pins the inode.
        let _ = self.cleanup();
    }
}
impl<'a> Prepared<'a> {
    fn new(directory: &'a Directory, key: &str, raw: &[u8]) -> io::Result<Self> {
        let name = format!(
            ".{key}-{}-{}",
            std::process::id(),
            TEMP.fetch_add(1, Ordering::Relaxed)
        );
        let file = directory.create(&name)?;
        let stamp = match file.metadata() {
            Ok(metadata) => Stamp::from_metadata(&metadata),
            Err(error) => {
                return finalized(
                    Err(io::Error::other(format!(
                        "autoenv temporary {name} retained because its identity is unavailable: {error}"
                    ))),
                    fs::close(file),
                );
            }
        };
        let mut prepared = Self {
            directory,
            file: Some(file),
            name,
            stamp,
            published: false,
            cleaned: false,
        };
        if let Err(error) = prepared.write(raw) {
            return finalized(Err(error), prepared.finish());
        }
        Ok(prepared)
    }
    fn cleanup(&mut self) -> io::Result<()> {
        if self.cleaned || self.published {
            return Ok(());
        }
        self.cleaned = true;
        self.directory.remove_owned_checked(&self.name, &self.stamp)
    }
    fn finish(mut self) -> io::Result<()> {
        let cleanup = self.cleanup();
        let closed = self.file.take().map_or(Ok(()), close_creator);
        finalized(cleanup, closed)
    }
    fn write(&mut self, raw: &[u8]) -> io::Result<()> {
        let file = self.file.as_mut().expect("live creator descriptor");
        file.write_all(raw)?;
        file.sync_all()?;
        file.rewind()?;
        let before = Stamp::from_metadata(&file.metadata()?);
        let mut actual = Vec::new();
        file.read_to_end(&mut actual)?;
        let after = Stamp::from_metadata(&file.metadata()?);
        if actual != raw || before != after || !after.owned_file() || !self.stamp.same_inode(&after)
        {
            return Err(io::Error::other("autoenv temporary changed"));
        }
        self.stamp = after;
        Ok(())
    }
    fn publish(&mut self, destination: &str) -> io::Result<()> {
        if self.directory.stamp(&self.name)? != Some(self.stamp.clone())
            || self
                .directory
                .stamp(destination)?
                .is_some_and(|stamp| !stamp.owned_file())
        {
            return Err(io::Error::other("autoenv cache entry changed or is unsafe"));
        }
        self.directory.publish(&self.name, destination, false)?;
        self.published = true;
        self.directory.sync()
    }
}
fn same_directory(path: &Path, directory: &Directory) -> io::Result<()> {
    let current = Directory::open(path)?;
    let result = (|| {
        let current_stamp = current.metadata()?;
        if current_stamp.owned_directory() && current_stamp.same_inode(&directory.metadata()?) {
            Ok(())
        } else {
            Err(io::Error::other("autoenv cache directory changed"))
        }
    })();
    finalized(result, current.close())
}
pub(super) fn publish(
    path: &Path,
    key: &str,
    environment: &[u8],
    manifest: &[u8],
) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    let path = std::fs::canonicalize(path)?;
    let directory = Directory::open(&path)?;
    let result = (|| {
        if !directory.metadata()?.owned_directory() {
            return Err(io::Error::other(
                "autoenv cache must be an owned directory without foreign write access",
            ));
        }
        directory.lock()?;
        publish_locked(&path, &directory, key, environment, manifest)
    })();
    finalized(result, directory.close()).map_err(|error| io::Error::other(format!("cache publication failed or is unconfirmed; inspect the cache before rebuilding: {error}")))
}
fn publish_locked(
    path: &Path,
    directory: &Directory,
    key: &str,
    environment: &[u8],
    manifest: &[u8],
) -> io::Result<()> {
    let mut data = Prepared::new(directory, key, environment)?;
    let mut diagnostics = match Prepared::new(directory, key, manifest) {
        Ok(prepared) => prepared,
        Err(error) => return finalized(Err(error), data.finish()),
    };
    let result = (|| {
        same_directory(path, directory)?;
        data.publish(&format!("{key}.env"))?;
        diagnostics.publish(&format!("{key}.json"))?;
        same_directory(path, directory)
    })();
    let result = finalized(result, diagnostics.finish());
    finalized(result, data.finish())
}
pub(super) fn read(path: &Path, key: &str) -> io::Result<Vec<u8>> {
    let path = std::fs::canonicalize(path)?;
    let directory = Directory::open(&path)?;
    let result = (|| {
        if !directory.metadata()?.owned_directory() {
            return Err(io::Error::other("unsafe autoenv cache directory"));
        }
        read_locked(&directory, key)
    })();
    finalized(result, directory.close())
}
fn read_locked(directory: &Directory, key: &str) -> io::Result<Vec<u8>> {
    let mut file = directory
        .read(&format!("{key}.env"))?
        .ok_or(io::ErrorKind::NotFound)?;
    let result = (|| {
        let before = Stamp::from_metadata(&file.metadata()?);
        if !before.owned_file() {
            return Err(io::Error::other("unsafe autoenv cache file"));
        }
        let mut raw = Vec::new();
        file.read_to_end(&mut raw)?;
        if Stamp::from_metadata(&file.metadata()?) != before {
            return Err(io::Error::other("autoenv cache changed while reading"));
        }
        Ok(raw)
    })();
    finalized(result, fs::close(file))
}
fn close_creator(file: std::fs::File) -> io::Result<()> {
    let closed = fs::close(file);
    #[cfg(test)]
    if FAIL_CREATOR_CLOSE.with(|failure| failure.replace(false)) {
        return finalized(
            closed,
            Err(io::Error::other(
                "injected close failure after actual close",
            )),
        );
    }
    closed
}
#[cfg(test)]
thread_local! { static FAIL_CREATOR_CLOSE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[cfg(test)]
mod tests;
