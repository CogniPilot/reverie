//! Actual service capture/startup/recall in separate owned processes. No model
//! server, private configuration, employee namespace or live database is used.
use reverie_application::{
    memory_recall::MemoryRecall,
    memory_startup::{MemorySeed, StartedMemory},
};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::memory::HashedEmbedder;
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::{MemoryError, MemoryStore};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const ENTRY: &str = "service_entry";
struct Tree(PathBuf);
impl Tree {
    fn new(extra: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "memory-runtime-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        fs::create_dir(root.join("configs")).unwrap();
        fs::write(root.join("configs/instance.json"),format!(r#"{{"id":"synthetic","agent_name":"Agent","owner_name":"Owner","data_dir":"../state","persona":"Selected persona"{extra}}}"#)).unwrap();
        Self(root)
    }
    fn run(&self, case: &str) -> Output {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", ENTRY, "--nocapture"])
            .env_clear()
            .env("HOME", &self.0)
            .env(
                "REVERIE_INSTANCE_CONFIG",
                self.0.join("configs/instance.json"),
            )
            .env("REVERIE_EMBED_DIMS", "8")
            .env("REVERIE_EMBED_DOC_PREFIX", "chosen-doc:")
            .env("REVERIE_EMBED_QUERY_PREFIX", "chosen-query:")
            .env("OWNED_MEMORY_RUNTIME", case)
            .output()
            .unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn successful(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn service_entry() {
    let Ok(case) = std::env::var("OWNED_MEMORY_RUNTIME") else {
        return;
    };
    let cfg = MemoryConfiguration::capture().unwrap();
    let db = cfg.native_path(MemoryPath::Database).unwrap();
    if case == "read-missing" {
        assert!(matches!(
            MemoryRecall::open_existing(&db, Arc::new(HashedEmbedder::new(8)), 0.995, 6),
            Err(MemoryError::NotInitialized)
        ));
        assert!(!cfg.native_path(MemoryPath::Data).unwrap().exists());
        return;
    }
    let seeds = [
        MemorySeed {
            text: MetadataText::from_scalar_text("  selected   seed  "),
            weight: 4.0,
        },
        MemorySeed {
            text: MetadataText::from_scalar_text("selected seed"),
            weight: 8.0,
        },
    ];
    if case == "invalid-initial" {
        assert!(StartedMemory::initialize(&cfg, &seeds).is_err());
        let store = MemoryStore::open(&db).unwrap();
        assert!(store.beliefs().unwrap().is_empty());
        assert_eq!(
            store.documents(None).self_model().unwrap().revision.value(),
            0
        );
        assert_eq!(
            store
                .get_state("native_memory_startup_v1", None)
                .unwrap()
                .as_deref(),
            Some("initializing")
        );
        store.close().unwrap();
        return;
    }
    let started = StartedMemory::initialize(&cfg, &seeds).unwrap();
    let initial = case == "first";
    assert_eq!(started.report().seeded, usize::from(initial));
    assert_eq!(started.report().initial_identity_created, initial);
    assert_eq!(started.report().imported, if initial { 2 } else { 0 });
    let store = started.store();
    assert_eq!(store.beliefs().unwrap().len(), 1);
    assert_eq!(store.count(None).unwrap(), 2);
    assert_eq!(
        store.documents(None).self_model().unwrap().revision.value(),
        1
    );
    let before = store
        .all(None)
        .unwrap()
        .into_iter()
        .map(|memory| (memory.id, memory.last_accessed, memory.embedding))
        .collect::<Vec<_>>();
    let reader = started.recall_service().unwrap();
    assert!(matches!(
        MemoryRecall::open_existing(&db, Arc::new(HashedEmbedder::new(16)), 0.995, 6),
        Err(MemoryError::NeedsMigration)
    ));
    assert_eq!(reader.recall("retained source").unwrap().len(), 2);
    let after = store
        .all(None)
        .unwrap()
        .into_iter()
        .map(|memory| (memory.id, memory.last_accessed, memory.embedding))
        .collect::<Vec<_>>();
    assert_eq!(before, after);
    store
        .set_state("native_memory_startup_v1", "profile-pending")
        .unwrap();
    assert!(matches!(
        reader.recall("must not run a query"),
        Err(MemoryError::NeedsProfileRefresh)
    ));
    store
        .set_state("native_memory_startup_v1", "ready")
        .unwrap();
    started.close().unwrap();
    assert!(matches!(reader.recall("closed"), Err(MemoryError::Closed)));
    assert!(matches!(started.recall_service(), Err(MemoryError::Closed)));
    reader.close().unwrap();
}
#[test]
fn readonly_missing_boot_does_not_create_any_state_then_explicit_startup_is_repeatable() {
    let tree = Tree::new("");
    successful(tree.run("read-missing"));
    fs::create_dir(tree.0.join("state")).unwrap();
    fs::write(tree.0.join("state/legacy-history.json"),r#"[{"role":"user","content":"retained source"},{"role":"assistant","content":"one"},{"role":"user","content":"retained source"},{"role":"assistant","content":"two"}]"#).unwrap();
    successful(tree.run("first"));
    let profile = tree.0.join("state/profile.md");
    assert!(profile.exists());
    fs::write(&profile, b"owner selected profile\n").unwrap();
    successful(tree.run("repeat"));
    assert_eq!(fs::read(profile).unwrap(), b"owner selected profile\n");
}
#[test]
fn invalid_initial_identity_rolls_back_the_new_seed_identity_batch() {
    let directives = std::iter::repeat_n("\"valid\"", 21)
        .collect::<Vec<_>>()
        .join(",");
    let tree = Tree::new(&format!(
        r#", "initial_self":{{"consciousness":"owner statement","directives":[{directives}]}}"#
    ));
    successful(tree.run("invalid-initial"));
}
#[test]
#[ignore = "requires explicit REVERIE_TEST_PYTHON; qualifies actual legacy caller on owned synthetic data"]
fn actual_legacy_recall_mutation_and_seed_duplication_are_paired_with_new_read_controls() {
    let python = std::env::var_os("REVERIE_TEST_PYTHON").expect("explicit legacy interpreter");
    let native = Tree::new("");
    successful(native.run("read-missing"));
    let legacy = Tree::new("");
    fs::create_dir(legacy.0.join("state")).unwrap();
    fs::write(legacy.0.join("state/legacy-history.json"),r#"[{"role":"user","content":"retained source"},{"role":"assistant","content":"one"},{"role":"user","content":"retained source"},{"role":"assistant","content":"two"}]"#).unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../python");
    let output = Command::new(python)
        .args(["-B", "-c", LEGACY_CALLER])
        .arg(source)
        .arg(&legacy.0)
        .env_clear()
        .env("HOME", &legacy.0)
        .env("REVERIE_HOME", &legacy.0)
        .env("REVERIE_EMBED_DIMS", "8")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["recalled"], 2);
    assert_eq!(receipt["historyRows"], 2);
    assert_eq!(receipt["touched"], 2);
    assert_eq!(receipt["duplicateSeeds"], 3);
    assert!(legacy.0.join("state/memory.sqlite").exists());
    assert!(legacy.0.join("state/profile.md").exists());
    assert!(!native.0.join("state").exists());
}
// Qualification-only invocation of unchanged old modules. Network/command
// guards reject an unexpected call; no fake model response is supplied.
const LEGACY_CALLER: &str = r#"
import contextlib,io,json,sqlite3,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
root=Path(sys.argv[2])
from reverie.memory_cli import main
sys.stdin=io.StringIO(json.dumps({'action':'recall','private':True,'query':'retained source'}))
output=io.StringIO()
with patch('urllib.request.urlopen',side_effect=AssertionError('unexpected network')),patch('subprocess.run',side_effect=AssertionError('unexpected process')),contextlib.redirect_stdout(output):
 assert main(['--instance',str(root/'configs/instance.json')])==0
recalled=json.loads(output.getvalue())
db=sqlite3.connect(root/'state/memory.sqlite')
rows=db.execute('SELECT COUNT(*),COUNT(last_accessed) FROM memories').fetchone()
assert db.execute("SELECT value FROM state WHERE key='migrated_legacy_history'").fetchone()[0]=='2'
db.close()
from reverie.memory import MemoryStore
from reverie.beliefs import ensure_seeded
store=MemoryStore(root/'duplicate-seeds.sqlite')
seeds=[('  selected   seed  ',4.),('selected seed',8.)]
ensure_seeded(store,seeds);ensure_seeded(store,seeds)
duplicates=len(store.beliefs());store.close()
print(json.dumps({'recalled':len(recalled),'historyRows':rows[0],'touched':rows[1],'duplicateSeeds':duplicates}))
"#;
