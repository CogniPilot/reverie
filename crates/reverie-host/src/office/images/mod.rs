//! The M actor's three fixed authenticated Office GETs. It holds an actual
//! retained phone alias; no URL, credentials or filesystem image input exists.
use super::{OfficePhone, OfficeService};
use crate::worker_runtime::WorkerRuntime;
use reverie_contracts::chat_images::{image_format, message_file};
use reverie_core::{
    chat_images::{ImageScope, MAX_FILE_BYTES},
    ids::{ChatImageFileId, ProfileSessionId},
};
use std::{
    fmt, fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    time::{Duration, Instant},
};
mod binding;
mod exchange;
pub use binding::OfficeImageBinding;
mod io;
mod raw_headers;
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum OfficeImageError {
    Refused(&'static str),
    Io(std::io::Error),
    Close(std::io::Error),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl OfficeImageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Io(_) | Self::Close(_) => "office_unavailable",
            Self::Finalization { .. } => "office_unavailable",
        }
    }
    pub fn is_uncertain(&self) -> bool {
        match self {
            Self::Close(_) => true,
            Self::Finalization { primary, secondary } => {
                primary.is_uncertain() || secondary.is_uncertain()
            }
            Self::Refused(_) | Self::Io(_) => false,
        }
    }
}
impl fmt::Display for OfficeImageError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for OfficeImageError {}
impl From<std::io::Error> for OfficeImageError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
pub(super) type Result<T> = std::result::Result<T, OfficeImageError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(OfficeImageError::Refused(code))
    }
}
fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(OfficeImageError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
pub struct OfficeImageReader {
    binding: OfficeImageBinding,
}
impl OfficeImageReader {
    pub fn session(&self) -> &ProfileSessionId {
        self.binding.session()
    }
    /// Current bound endpoint DATA, usable in the original binding digest.
    pub fn identity(&self, runtime: &WorkerRuntime) -> Result<[u64; 2]> {
        let actual = self.binding.identity(runtime)?;
        let path = &self.binding.path;
        let info = fs::symlink_metadata(path)?;
        need(
            info.file_type().is_socket()
                && info.uid() == crate::native::uid()
                && info.mode() & 0o077 == 0
                && fs::canonicalize(path)? == *path
                && [info.dev(), info.ino()] == actual,
            "office_unavailable",
        )?;
        Ok(actual)
    }
    pub fn fetch(
        &self,
        runtime: &WorkerRuntime,
        scope: &ImageScope,
        file: &ChatImageFileId,
    ) -> Result<Vec<u8>> {
        need(
            scope.session() == self.session() && scope.files().contains(file),
            "invalid_identity",
        )?;
        let end = Instant::now() + Duration::from_secs(10);
        let mime = self.message(runtime, scope, file, end)?;
        let endpoint = format!("/api/v1/chatrooms/{}/files/{file}", scope.room());
        let (bytes, headers) = self.read(runtime, &endpoint, MAX_FILE_BYTES, end)?;
        need(headers == [mime.mime().as_bytes()], "unsupported_image")?;
        need(
            image_format(&bytes).map_err(|e| OfficeImageError::Refused(e.code()))? == mime,
            "unsupported_image",
        )?;
        need(
            self.message(runtime, scope, file, end)? == mime,
            "message_or_file_refused",
        )?;
        Ok(bytes)
    }
    fn message(
        &self,
        runtime: &WorkerRuntime,
        scope: &ImageScope,
        file: &ChatImageFileId,
        end: Instant,
    ) -> Result<reverie_core::chat_images::Raster> {
        let endpoint = format!(
            "/api/v1/chatrooms/{}/messages/{}",
            scope.room(),
            scope.message()
        );
        let (bytes, _) = self.read(runtime, &endpoint, 1024 * 1024, end)?;
        message_file(&bytes, scope, file).map_err(|e| OfficeImageError::Refused(e.code()))
    }
    fn read(
        &self,
        runtime: &WorkerRuntime,
        endpoint: &str,
        maximum: usize,
        end: Instant,
    ) -> Result<(Vec<u8>, Vec<Vec<u8>>)> {
        need(Instant::now() < end, "timeout")?;
        let identity = self.identity(runtime)?;
        let mut stream = io::connect(&self.binding.path, runtime, end)?;
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(OfficeImageError::Io)
            .and_then(|executor| {
                executor.block_on(exchange::read(&mut stream, runtime, endpoint, maximum, end))
            });
        let result = result.and_then(|output| {
            need(
                self.identity(runtime)? == identity,
                "body_or_binding_changed",
            )?;
            Ok(output)
        });
        finalized(
            result,
            crate::native::owned_process::close(stream.into()).map_err(OfficeImageError::Close),
        )
    }
}
