//! Fixed OS-owner metadata observations. No broker, website or mutation grant.
use crate::{
    gpu_access::{GpuFileStamp, GpuHostError},
    native,
    worker_image::{ImageControlFiles, ImageFileError, ImagePrivateSnapshot},
};
use reverie_contracts::{
    storage_identity::Metadata, worker_config::EffectiveWorkerConfig, worker_launch::LaunchSettings,
};
use reverie_store::storage_identity::{self, IdentityError};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

#[derive(Debug)]
pub enum InventoryReadError {
    Refused(&'static str),
    Identity(IdentityError),
    File(ImageFileError),
    Stamp(GpuHostError),
    Io(std::io::Error),
    Retained(Arc<Self>),
}
impl std::fmt::Display for InventoryReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Refused(code) => code,
            Self::Identity(_) => "OWNER_INVENTORY_METADATA",
            Self::File(_) => "OWNER_INVENTORY_SOURCE",
            Self::Stamp(_) => "OWNER_INVENTORY_STAMP",
            Self::Io(_) => "OWNER_INVENTORY_IO",
            Self::Retained(error) => return error.fmt(f),
        })
    }
}
impl std::error::Error for InventoryReadError {}
impl InventoryReadError {
    pub fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::File(error) => error.has_unconfirmed_close(),
            Self::Identity(error) => error.has_unconfirmed_close(),
            Self::Retained(error) => error.has_unconfirmed_close(),
            _ => false,
        }
    }
}
impl From<IdentityError> for InventoryReadError {
    fn from(e: IdentityError) -> Self {
        Self::Identity(e)
    }
}
impl From<std::io::Error> for InventoryReadError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
fn need(value: bool, code: &'static str) -> Result<(), InventoryReadError> {
    value.then_some(()).ok_or(InventoryReadError::Refused(code))
}
type Parent = (PathBuf, (u64, u64, u32, u32, u32));
/// Native registered-source observation, captured before configuration-dependent
/// readers. This is neither a website identity nor permission to mutate files.
pub struct OwnerInventorySource {
    root: PathBuf,
    source: PathBuf,
    stamp: GpuFileStamp,
}
impl OwnerInventorySource {
    pub fn capture(source: &Path) -> Result<Self, InventoryReadError> {
        let home = native::python_path(&native::home_directory(None)?)?;
        Self::at(&home.join("reverie"), source)
    }
    fn at(root: &Path, source: &Path) -> Result<Self, InventoryReadError> {
        let uid = native::policy_effective_uid();
        need(uid != 0, "OWNER_INVENTORY_ORDINARY_OWNER")?;
        storage_identity::canonical(root)?;
        storage_identity::canonical(source)?;
        need(
            source.starts_with(root) && source != root,
            "OWNER_INVENTORY_REGISTERED_SOURCE",
        )?;
        for parent in source.ancestors().skip(1) {
            parent_stamp(parent)?;
        }
        let stamp = GpuFileStamp::observe(source).map_err(InventoryReadError::Stamp)?;
        need(stamp.private(uid), "OWNER_INVENTORY_SOURCE_CUSTODY")?;
        Ok(Self {
            root: root.to_owned(),
            source: source.to_owned(),
            stamp,
        })
    }
    pub fn source(&self) -> &Path {
        &self.source
    }
}
fn capture_parents(paths: &[PathBuf], source: &Path) -> Result<Vec<Parent>, InventoryReadError> {
    let mut parents = Vec::new();
    for path in paths
        .iter()
        .map(PathBuf::as_path)
        .chain(std::iter::once(source))
    {
        storage_identity::canonical(path)?;
        for parent in path.ancestors().skip(1) {
            if parents.iter().any(|(p, _)| p == parent) {
                continue;
            }
            parents.push((parent.to_owned(), parent_stamp(parent)?));
        }
    }
    Ok(parents)
}
fn parent_stamp(path: &Path) -> Result<(u64, u64, u32, u32, u32), InventoryReadError> {
    let m = fs::symlink_metadata(path)?;
    let uid = native::policy_effective_uid();
    let sticky = m.uid() == 0 && m.mode() & libc::S_ISVTX != 0;
    need(
        m.is_dir() && (m.uid() == uid || m.uid() == 0) && (m.mode() & 0o022 == 0 || sticky),
        "OWNER_INVENTORY_PARENT",
    )?;
    Ok((m.dev(), m.ino(), m.mode(), m.uid(), m.gid()))
}
pub struct OwnerInventoryReader {
    source: PathBuf,
    files: ImageControlFiles,
    original: ImagePrivateSnapshot,
    paths: [PathBuf; 3],
    parents: Vec<Parent>,
    uid: u32,
    end: Instant,
    failure: Option<Arc<InventoryReadError>>,
}
struct Document {
    metadata: Metadata,
    stamp: GpuFileStamp,
}
pub struct OwnerInventoryDocuments {
    documents: [Option<Document>; 3],
}
impl OwnerInventoryDocuments {
    pub fn company(&self) -> &Metadata {
        &self.documents[0]
            .as_ref()
            .expect("required company")
            .metadata
    }
    pub fn state(&self) -> Option<&Metadata> {
        self.documents[1].as_ref().map(|d| &d.metadata)
    }
    pub fn declared_plans(&self) -> Option<&Metadata> {
        self.documents[2].as_ref().map(|d| &d.metadata)
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.documents
            .iter()
            .zip(&other.documents)
            .all(|(a, b)| match (a, b) {
                (None, None) => true,
                (Some(a), Some(b)) => a.stamp == b.stamp && a.metadata.equivalent(&b.metadata),
                _ => false,
            })
    }
}
impl OwnerInventoryReader {
    pub fn capture(
        source: &OwnerInventorySource,
        config: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<Self, InventoryReadError> {
        need(
            GpuFileStamp::observe(source.source()).map_err(InventoryReadError::Stamp)?
                == source.stamp,
            "OWNER_INVENTORY_SOURCE_CHANGED",
        )?;
        let reader = Self::capture_at(&source.root, source.source(), config, end)?;
        need(
            GpuFileStamp::observe(source.source()).map_err(InventoryReadError::Stamp)?
                == source.stamp,
            "OWNER_INVENTORY_SOURCE_CHANGED",
        )?;
        Ok(reader)
    }
    fn capture_at(
        root: &Path,
        source: &Path,
        config: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<Self, InventoryReadError> {
        let uid = native::policy_effective_uid();
        need(
            uid != 0 && Instant::now() < end,
            "OWNER_INVENTORY_ORDINARY_OWNER",
        )?;
        storage_identity::canonical(root)?;
        storage_identity::canonical(source)?;
        need(
            source.starts_with(root) && source != root,
            "OWNER_INVENTORY_REGISTERED_SOURCE",
        )?;
        let settings = LaunchSettings::capture(config)
            .map_err(|_| InventoryReadError::Refused("OWNER_INVENTORY_CONFIGURATION"))?;
        need(settings.uid() == uid, "OWNER_INVENTORY_UID")?;
        let company = native::python_path(settings.company_file().codepoints())?;
        let parent = company
            .parent()
            .ok_or(InventoryReadError::Refused("OWNER_INVENTORY_COMPANY"))?;
        let paths = [
            company.clone(),
            parent.join("state.json"),
            parent.join("subscription-profiles.json"),
        ];
        let parents = capture_parents(&paths, source)?;
        let mut files = ImageControlFiles::capture(source, config);
        let original = files
            .read_configuration()
            .map_err(InventoryReadError::File)?;
        let decoded = reverie_contracts::worker_config::decode(original.bytes())
            .map_err(|_| InventoryReadError::Refused("OWNER_INVENTORY_CONFIGURATION"))?;
        need(
            reverie_contracts::worker_config::equivalent(&decoded, config),
            "OWNER_INVENTORY_SOURCE_CHANGED",
        )?;
        Ok(Self {
            source: source.to_owned(),
            files,
            original,
            paths,
            parents,
            uid,
            end,
            failure: None,
        })
    }
    pub fn read(&mut self) -> Result<OwnerInventoryDocuments, InventoryReadError> {
        self.require_unfailed()?;
        let result = self.read_current();
        self.retain(result)
    }
    fn read_current(&mut self) -> Result<OwnerInventoryDocuments, InventoryReadError> {
        self.assert_source_current()?;
        let company = self.read_document(0)?.ok_or(InventoryReadError::Refused(
            "OWNER_INVENTORY_COMPANY_MISSING",
        ))?;
        let state = self.read_document(1)?;
        let plans = self.read_document(2)?;
        self.assert_source_current()?;
        Ok(OwnerInventoryDocuments {
            documents: [Some(company), state, plans],
        })
    }
    fn read_document(&self, index: usize) -> Result<Option<Document>, InventoryReadError> {
        need(Instant::now() < self.end, "OWNER_INVENTORY_DEADLINE")?;
        let path = &self.paths[index];
        storage_identity::canonical(path)?;
        let Some(stamp) =
            GpuFileStamp::observe_optional(path).map_err(InventoryReadError::Stamp)?
        else {
            return Ok(None);
        };
        let metadata = storage_identity::read_metadata(
            path,
            self.uid,
            storage_identity::DEFAULT_METADATA_LIMIT,
        )?;
        need(
            GpuFileStamp::observe(path).map_err(InventoryReadError::Stamp)? == stamp,
            "OWNER_INVENTORY_DOCUMENT_CHANGED",
        )?;
        Ok(Some(Document { metadata, stamp }))
    }
    pub fn assert_current(
        &mut self,
        documents: &OwnerInventoryDocuments,
    ) -> Result<(), InventoryReadError> {
        self.require_unfailed()?;
        let result = self.assert_documents_current(documents);
        self.retain(result)
    }
    fn require_unfailed(&self) -> Result<(), InventoryReadError> {
        self.failure.as_ref().map_or(Ok(()), |error| {
            Err(InventoryReadError::Retained(Arc::clone(error)))
        })
    }
    fn retain<T>(
        &mut self,
        result: Result<T, InventoryReadError>,
    ) -> Result<T, InventoryReadError> {
        result.map_err(|error| {
            let error = Arc::new(error);
            self.failure = Some(Arc::clone(&error));
            InventoryReadError::Retained(error)
        })
    }
    fn assert_documents_current(
        &mut self,
        documents: &OwnerInventoryDocuments,
    ) -> Result<(), InventoryReadError> {
        self.assert_source_current()?;
        for (path, document) in self.paths.iter().zip(&documents.documents) {
            storage_identity::canonical(path)?;
            need(
                GpuFileStamp::observe_optional(path)
                    .map_err(InventoryReadError::Stamp)?
                    .as_ref()
                    == document.as_ref().map(|d| &d.stamp),
                "OWNER_INVENTORY_DOCUMENT_CHANGED",
            )?;
        }
        self.assert_source_current()
    }
    fn assert_source_current(&mut self) -> Result<(), InventoryReadError> {
        need(Instant::now() < self.end, "OWNER_INVENTORY_DEADLINE")?;
        storage_identity::canonical(&self.source)?;
        for (path, stamp) in &self.parents {
            need(
                parent_stamp(path)? == *stamp,
                "OWNER_INVENTORY_PARENT_CHANGED",
            )?;
        }
        let current = self
            .files
            .read_configuration()
            .map_err(InventoryReadError::File)?;
        need(
            current.stamp() == self.original.stamp() && current.bytes() == self.original.bytes(),
            "OWNER_INVENTORY_SOURCE_CHANGED",
        )
    }
}
#[cfg(test)]
mod tests;
