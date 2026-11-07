//! Existing project-wide recall, physically separate from employee memory.
use reverie_contracts::memory::{MemoryMetadata, MemorySources, MemoryView, embedding_text};
use reverie_core::memory::{EmbeddingText, ProjectName};
use reverie_store::memory::{MemoryError, MemoryStore, ReflectionInput, RetrievalOptions};
use std::{fmt, path::Path};
#[derive(Debug)]
pub enum ProjectMemoryError {
    InvalidProject,
    MissingFactOrSource,
    Store(MemoryError),
}
impl fmt::Display for ProjectMemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProjectMemoryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        if let Self::Store(e) = self {
            Some(e)
        } else {
            None
        }
    }
}
impl From<MemoryError> for ProjectMemoryError {
    fn from(error: MemoryError) -> Self {
        Self::Store(error)
    }
}
pub struct ProjectMemory {
    project: ProjectName,
    store: MemoryStore,
}
impl ProjectMemory {
    pub fn open(root: impl AsRef<Path>, project: &str) -> Result<Self, ProjectMemoryError> {
        let project = ProjectName::parse(project).ok_or(ProjectMemoryError::InvalidProject)?;
        let store = MemoryStore::open(root.as_ref().join(project.as_str()).join("memory.sqlite"))?;
        Ok(Self { project, store })
    }
    pub fn project(&self) -> &ProjectName {
        &self.project
    }
    pub fn store(&self) -> &MemoryStore {
        &self.store
    }
    pub fn lookup(&self, query: &str) -> Result<Vec<MemoryView>, ProjectMemoryError> {
        self.lookup_text(EmbeddingText::from_scalar_text(query))
    }
    pub fn lookup_text(
        &self,
        query: EmbeddingText<'_>,
    ) -> Result<Vec<MemoryView>, ProjectMemoryError> {
        Ok(self
            .store
            .retrieve_text(query, RetrievalOptions::default())?
            .into_iter()
            .map(|memory| memory.as_dict())
            .collect())
    }
    pub fn remember(&self, text: &str, source: &str) -> Result<MemoryView, ProjectMemoryError> {
        self.remember_text(
            EmbeddingText::from_scalar_text(text),
            EmbeddingText::from_scalar_text(source),
        )
    }
    pub fn remember_text(
        &self,
        text: EmbeddingText<'_>,
        source: EmbeddingText<'_>,
    ) -> Result<MemoryView, ProjectMemoryError> {
        if text.trimmed().is_empty() || source.trimmed().is_empty() {
            return Err(ProjectMemoryError::MissingFactOrSource);
        }
        let mut input = ReflectionInput::from_text(
            embedding_text(text.take(8000)),
            7.0,
            MemorySources::new(&[]),
        );
        input.metadata =
            MemoryMetadata::project_text(self.project.as_str(), &embedding_text(source.take(1000)));
        Ok(self.store.add_reflection(input)?.as_dict())
    }
    pub fn close(&self) -> Result<(), ProjectMemoryError> {
        Ok(self.store.close()?)
    }
}
