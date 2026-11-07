use super::*;
use reverie_core::memory_configuration::{IntegerSetting, TextSetting};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-cfg-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn text(value: &str) -> PythonText {
    PythonText::from_scalar_text(value)
}
#[test]
fn default_and_literal_paths_match_source_without_expansion_or_creation() {
    let environment = BTreeMap::from([
        ("REVERIE_ROOT".into(), text("~/literal-root")),
        ("REVERIE_PERSONA".into(), text("override.txt")),
        ("REVERIE_EMBED_DIMS".into(), text("-1")),
    ]);
    let cfg = MemoryConfiguration::from_environment(&environment, &text("/owned/home")).unwrap();
    assert_eq!(
        cfg.path(MemoryPath::Home),
        &PosixPath::from_scalar_text("/owned/home")
    );
    assert_eq!(
        cfg.path(MemoryPath::Database),
        &PosixPath::from_scalar_text("~/literal-root/companies/default/data/memory.sqlite")
    );
    assert_eq!(
        cfg.path(MemoryPath::Persona),
        &PosixPath::from_scalar_text("override.txt")
    );
    assert_eq!(
        cfg.settings()
            .integer(IntegerSetting::EmbedDimensions)
            .as_str(),
        "-1"
    );
    assert_eq!(
        cfg.settings().text(TextSetting::EmbedDocumentPrefix),
        &text("search_document: ")
    );
    let empty_home = MemoryConfiguration::from_environment(&BTreeMap::new(), &text("")).unwrap();
    assert_eq!(
        empty_home.path(MemoryPath::Home),
        &PosixPath::from_scalar_text(".")
    );
    assert_eq!(
        empty_home.path(MemoryPath::Database),
        &PosixPath::from_scalar_text("reverie/companies/default/data/memory.sqlite")
    );
}
#[test]
fn explicit_instance_overrides_every_private_path_but_not_independent_model_or_gpu_paths() {
    let tree = Tree::new();
    let configs = tree.0.join("configs");
    fs::create_dir(&configs).unwrap();
    let path = configs.join("instance.json");
    fs::write(&path,r#"{"id":"agent","agent_name":"Selected","owner_name":"Owner","data_dir":"../state","persona":"Owner data"}"#).unwrap();
    let environment = BTreeMap::from([
        (
            "REVERIE_INSTANCE_CONFIG".into(),
            text(path.to_str().unwrap()),
        ),
        ("REVERIE_DATA_DIR".into(), text("forbidden-fallback")),
        ("REVERIE_PERSONA".into(), text("personal.txt")),
        ("REVERIE_EMBED_MODEL".into(), text("chosen-model")),
        ("REVERIE_EMBED_DOC_PREFIX".into(), text("chosen-doc:")),
        ("REVERIE_EMBED_QUERY_PREFIX".into(), text("chosen-query:")),
        ("REVERIE_GPU_LOCK".into(), text("independent.lock")),
    ]);
    let cfg = MemoryConfiguration::from_environment(&environment, &text("/owned/home")).unwrap();
    let state = tree.0.join("state");
    for (key, relative) in [
        (MemoryPath::Database, "memory.sqlite"),
        (MemoryPath::Profile, "profile.md"),
        (MemoryPath::Persona, "persona.txt"),
        (MemoryPath::DreamPrompt, "dream-prompt.txt"),
        (MemoryPath::LegacyHistory, "legacy-history.json"),
        (MemoryPath::Hold, "maintenance.hold"),
        (MemoryPath::LegacyHold, "legacy.hold"),
        (MemoryPath::Log, "logs/runtime.log"),
    ] {
        assert_eq!(cfg.native_path(key).unwrap(), state.join(relative));
    }
    assert_eq!(
        cfg.native_path(MemoryPath::GpuLock).unwrap(),
        Path::new("independent.lock")
    );
    assert_eq!(
        cfg.settings().text(TextSetting::EmbedModel),
        &text("chosen-model")
    );
    assert_eq!(
        cfg.settings().text(TextSetting::EmbedDocumentPrefix),
        &text("chosen-doc:")
    );
    assert_eq!(
        cfg.settings().text(TextSetting::EmbedQueryPrefix),
        &text("chosen-query:")
    );
    assert!(!state.exists());
    cfg.ensure_directories().unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&state).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(state.join("logs").is_dir());
    assert!(!state.join("memory.sqlite").exists());
    assert!(!state.join("profile.md").exists());
}
