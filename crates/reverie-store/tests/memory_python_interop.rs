//! Explicit migration qualification using only task-owned synthetic databases.
use reverie_store::memory::{DreamInput, EpisodeInput, MemoryStore, ReflectionInput};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-python-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
#[ignore = "requires explicit REVERIE_TEST_PYTHON; runs actual legacy modules on synthetic SQLite only"]
fn actual_python_reads_native_writes_and_native_reads_python_updates() {
    let python =
        std::env::var_os("REVERIE_TEST_PYTHON").expect("explicit qualification interpreter");
    let tree = Tree::new();
    let path = tree.0.join("memory.sqlite");
    let backup = tree.0.join("snapshot.sqlite");
    let store = MemoryStore::open(&path).unwrap();
    let mut episode = EpisodeInput::new(" user K ", " answer ");
    episode.created_at = Some(100.0);
    let episode = store.add_episode(episode).unwrap();
    let sources = [episode.id];
    let mut reflection = ReflectionInput::new(" native reflection ", 7.0, &sources);
    reflection.created_at = Some(200.0);
    store.add_reflection(reflection).unwrap();
    let mut dream = DreamInput::new(" waking only ", "calm", &sources);
    dream.created_at = Some(300.0);
    let dream = store.add_dream(dream).unwrap();
    store.release_dream(dream.id, true).unwrap();
    store
        .add_external_episode("synthetic:external", "external", "answer", "project")
        .unwrap();
    store
        .add_belief(" native belief ", 8.0, None, true, Some(100.0))
        .unwrap();
    store.set_state("native", "retained").unwrap();
    assert!(store.claim_message("native:claim", Some(100.0)).unwrap());
    store.claim_voice("🎤 HELLO KELVIN", Some(100.0)).unwrap();
    store.backup_to(&backup).unwrap();
    let expected = store
        .all(None)
        .unwrap()
        .iter()
        .map(|memory| {
            std::str::from_utf8(&memory.as_dict_json())
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    store.close().unwrap();
    let views = tree.0.join("views.json");
    fs::write(&views, serde_json::to_vec(&expected).unwrap()).unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../python");
    let output = Command::new(python)
        .args(["-B", "-c", ORACLE])
        .arg(&source)
        .arg(&path)
        .arg(&backup)
        .arg(&views)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "legacy qualification failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let store = MemoryStore::open(&path).unwrap();
    assert_eq!(
        store.get_state("python", None).unwrap().as_deref(),
        Some("retained")
    );
    assert_eq!(store.count(None).unwrap(), 5);
    assert_eq!(
        store.get(5).unwrap().text,
        "User: python user\nAssistant: python answer"
    );
    assert!(store.answered("python:claim").unwrap());
    assert_eq!(store.get(1).unwrap().importance, 9.0);
    assert!(
        store
            .is_voice_claimed("python voice", 600.0, Some(100.0))
            .unwrap()
    );
    store.close().unwrap();
}
// This is a test-only invocation of the unchanged Python implementation, not a
// shipped replacement adapter, maintenance script or alternate product route.
const ORACLE: &str = r#"
import sys,json,sqlite3
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from reverie.memory import MemoryStore
path,backup,views=map(Path,sys.argv[2:])
s=MemoryStore(path)
assert [json.dumps(m.as_dict()) for m in s.all()]==json.loads(views.read_text())
assert s.get_state('native')=='retained'
assert s.answered('native:claim')
assert s.is_voice_claimed('hello kelvin',now=100)
assert s.beliefs()[0].protected
assert s.get(3).meta=={'recall':' waking only ','tone':'calm','released':True,'summary_only':True}
assert s.add_external_episode('synthetic:external','ignored','ignored').id==4
s.add_episode('python user','python answer',created_at=400)
s.set_importance(1,9)
s.set_state('python','retained')
s.claim_message('python:claim',now=100)
s.claim_voice('python voice',now=100)
s.close()
b=MemoryStore(backup)
assert b.count()==4 and b.get_state('python') is None
b.close()
"#;
