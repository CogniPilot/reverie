//! Service-owned configuration snapshot. Capturing resolves only an explicitly
//! selected instance; it never creates state, opens a DB, selects an embedding
//! fallback or copies identity/credentials into the shareable configuration.
use crate::{
    memory_instance::{InstanceLoadError, LoadedMemoryInstance},
    native,
};
use reverie_core::{
    PythonText,
    memory_configuration::{AgentSettings, lookup},
    posix_path::PosixPath,
};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MemoryPath {
    Home,
    Root,
    Cache,
    Data,
    Database,
    Profile,
    Persona,
    LegacyHistory,
    Hold,
    LegacyHold,
    Log,
    GpuLock,
    GpuYield,
    GpuActivity,
    DreamPrompt,
}
pub struct MemoryConfiguration {
    settings: AgentSettings,
    paths: BTreeMap<MemoryPath, PosixPath>,
    instance: Option<LoadedMemoryInstance>,
}
impl MemoryConfiguration {
    /// Same process filesystem/network namespace as the eventual consumer.
    /// Capture once at bootstrap instead of consulting mutable process env on
    /// individual API requests. Organizational instance labels grant no scope.
    pub fn capture() -> Result<Self, InstanceLoadError> {
        let environment = std::env::vars_os()
            .filter_map(|(key, value)| {
                let key = key.to_str()?;
                if key == "HOME" || key.starts_with("REVERIE_") {
                    Some((
                        key.to_owned(),
                        PythonText::try_new(native::python_text(Path::new(&value)))
                            .expect("OS codepoints"),
                    ))
                } else {
                    None
                }
            })
            .collect::<BTreeMap<_, _>>();
        let home = match environment.get("HOME") {
            Some(home) => home.clone(),
            None => PythonText::try_new(native::home_directory(None)?).expect("NSS codepoints"),
        };
        Self::from_environment(&environment, &home)
    }
    fn from_environment(
        environment: &BTreeMap<String, PythonText>,
        default_home: &PythonText,
    ) -> Result<Self, InstanceLoadError> {
        use MemoryPath::*;
        let home = path(lookup(environment, "HOME").unwrap_or(default_home));
        let root = selected(environment, "ROOT", join(&home, "reverie"));
        let cache = join(&root, "scratch/cache");
        let data = selected(
            environment,
            "DATA_DIR",
            join(&root, "companies/default/data"),
        );
        let mut paths = BTreeMap::from([
            (Home, home),
            (Root, root),
            (Cache, cache.clone()),
            (Data, data.clone()),
        ]);
        for (key, suffix, relative, base) in [
            (GpuLock, Some("GPU_LOCK"), "gpu.lock", &cache),
            (GpuYield, Some("GPU_YIELD"), "gpu.yield", &cache),
            (GpuActivity, Some("GPU_ACTIVITY"), "gpu.activity", &cache),
            (Database, None, "memory.sqlite", &data),
            (Profile, None, "profile.md", &data),
            (Persona, Some("PERSONA"), "persona.txt", &data),
            (
                LegacyHistory,
                Some("LEGACY_HISTORY"),
                "legacy-history.json",
                &data,
            ),
            (Hold, Some("HOLD"), "reverie.hold", &cache),
            (LegacyHold, None, "legacy.hold", &data),
            (Log, Some("LOG"), "reverie.log", &cache),
            (DreamPrompt, Some("DREAM_PROMPT"), "dream-prompt.txt", &data),
        ] {
            let fallback = join(base, relative);
            paths.insert(
                key,
                suffix.map_or(fallback.clone(), |suffix| {
                    selected(environment, suffix, fallback)
                }),
            );
        }
        let instance = lookup(environment, "INSTANCE_CONFIG")
            .map(|text| {
                LoadedMemoryInstance::load_captured(
                    &native::python_path(text.codepoints())?,
                    default_home.codepoints(),
                )
            })
            .transpose()?;
        if let Some(instance) = &instance {
            let data = instance.data_directory();
            paths.insert(Data, data.clone());
            for (key, relative) in [
                (Database, "memory.sqlite"),
                (Profile, "profile.md"),
                (Persona, "persona.txt"),
                (DreamPrompt, "dream-prompt.txt"),
                (LegacyHistory, "legacy-history.json"),
                (Hold, "maintenance.hold"),
                (LegacyHold, "legacy.hold"),
                (Log, "logs/runtime.log"),
            ] {
                paths.insert(key, join(data, relative));
            }
        }
        Ok(Self {
            settings: AgentSettings::capture(environment),
            paths,
            instance,
        })
    }
    pub fn settings(&self) -> &AgentSettings {
        &self.settings
    }
    pub fn path(&self, key: MemoryPath) -> &PosixPath {
        &self.paths[&key]
    }
    pub fn native_path(&self, key: MemoryPath) -> io::Result<PathBuf> {
        native::python_path(&self.path(key).codepoints())
    }
    pub fn instance(&self) -> Option<&LoadedMemoryInstance> {
        self.instance.as_ref()
    }
    pub fn deprecations(&self) -> &[String] {
        &[]
    }
    /// Explicit startup probe only. Read services receive the already selected
    /// backend and never call this method or silently change model identity.
    pub fn select_embeddings(&self) -> crate::embeddings::EmbeddingSelection {
        self.embedding_candidates().select_at_startup()
    }
    /// Restore only the actual persisted startup-selected backend. There is no
    /// probe, fallback selection or inference here. The profile is data, not a
    /// launch/scope grant; the lifecycle owner holds its scope lock separately.
    pub fn embedding_candidates(&self) -> crate::embeddings::EmbeddingCandidates {
        use reverie_core::memory_configuration::IntegerSetting;
        crate::embeddings::EmbeddingCandidates::configured(
            self.llama_configuration(),
            self.settings.integer(IntegerSetting::EmbedDimensions),
        )
    }
    fn llama_configuration(&self) -> Option<crate::embeddings::LlamaConfig> {
        use reverie_contracts::storage_identity::MetadataText;
        use reverie_core::memory_configuration::TextSetting;
        let text = |key| MetadataText::from_python_text(self.settings.text(key).clone());
        if self
            .settings
            .text(TextSetting::EmbedUrl)
            .codepoints()
            .is_empty()
        {
            None
        } else {
            let mut config = crate::embeddings::LlamaConfig::from_text(
                text(TextSetting::EmbedUrl),
                text(TextSetting::EmbedModel),
            );
            config.document_prefix = text(TextSetting::EmbedDocumentPrefix);
            config.query_prefix = text(TextSetting::EmbedQueryPrefix);
            Some(config)
        }
    }
    /// Explicit startup operation; recall never calls this method. Match the
    /// source's private data leaf and ordinary recursively created ancestors.
    pub fn ensure_directories(&self) -> io::Result<()> {
        use std::os::unix::fs::DirBuilderExt;
        let data = self.native_path(MemoryPath::Data)?;
        if let Some(parent) = data.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::DirBuilder::new().mode(0o700).create(&data) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && data.is_dir() => (),
            Err(error) => return Err(error),
        }
        let log = self.native_path(MemoryPath::Log)?;
        if let Some(parent) = log.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }
}
fn path(value: &PythonText) -> PosixPath {
    PosixPath::try_new(value.codepoints()).expect("checked text")
}
fn join(base: &PosixPath, suffix: &str) -> PosixPath {
    base.join(&PosixPath::from_scalar_text(suffix))
}
fn selected(
    environment: &BTreeMap<String, PythonText>,
    suffix: &str,
    fallback: PosixPath,
) -> PosixPath {
    lookup(environment, suffix).map(path).unwrap_or(fallback)
}
#[cfg(test)]
mod tests;
