//! Explicit migration qualification using only task-owned synthetic databases.
use reverie_contracts::{
    memory_documents::{BallotProposal, DocumentBody, SelfModelDraft},
    storage_identity::MetadataText,
};
use reverie_core::memory_documents::{
    BallotCategory, DeveloperName, DocumentName, DocumentRevision,
};
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
    prepare_documents(&store);
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
    check_python_updates(&path);
}
fn prepare_documents(store: &MemoryStore) {
    let documents = store.documents(None);
    documents.initialize().unwrap();
    let name = DocumentName::from_scalar_text("shared");
    documents
        .write(
            &name,
            &DocumentBody::decode_json(
                r#"{"order":{"second":2,"first":1},"text":"native K","number":-0.0}"#,
            )
            .unwrap(),
            DocumentRevision::try_new(0).unwrap(),
        )
        .unwrap();
    documents
        .write(
            &name,
            &DocumentBody::decode_json(
                r#"{"order":{"second":2,"first":1},"text":"native revised K","number":-0.0}"#,
            )
            .unwrap(),
            DocumentRevision::try_new(1).unwrap(),
        )
        .unwrap();
    documents.save_profile(&DeveloperName::parse("compiler").unwrap(),&DocumentBody::decode_json(r#"{"role":"native role","long_term":"retained-private","memory_queries":["query"]}"#).unwrap(),DocumentRevision::try_new(0).unwrap()).unwrap();
    documents
        .save_self(
            &SelfModelDraft::decode_json(
                r#"{"consciousness":"native self","directives":[],"persona":"native persona"}"#,
            )
            .unwrap(),
            &MetadataText::from_scalar_text("initial native"),
            DocumentRevision::try_new(0).unwrap(),
        )
        .unwrap();
    documents
        .vote(
            &BallotCategory::parse("vacation").unwrap(),
            &BallotProposal::decode_json(r#"{"z":"K","a":[true,1.0]}"#).unwrap(),
            &MetadataText::from_scalar_text("native ballot"),
        )
        .unwrap();
}
fn check_python_updates(path: &std::path::Path) {
    let store = MemoryStore::open(path).unwrap();
    let documents = store.documents(None);
    assert_eq!(
        documents
            .read(&DocumentName::from_scalar_text("shared"), None)
            .unwrap()
            .revision
            .value(),
        3
    );
    let history = documents
        .history(&DocumentName::from_scalar_text("shared"))
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].revision.value(), 2);
    assert_eq!(
        history[0].body,
        r#"{"order": {"second": 2, "first": 1}, "text": "native revised K", "number": -0.0}"#
    );
    assert_eq!(
        documents.profiles().unwrap()["compiler"].revision.value(),
        2
    );
    assert_eq!(documents.self_model().unwrap().revision.value(), 2);
    assert_eq!(documents.ballot_history().unwrap().len(), 2);
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
from reverie.reverie import Reverie
path,backup,views=map(Path,sys.argv[2:])
s=MemoryStore(path)
assert [json.dumps(m.as_dict()) for m in s.all()]==json.loads(views.read_text())
assert s.get_state('native')=='retained'
assert s.answered('native:claim')
assert s.is_voice_claimed('hello kelvin',now=100)
assert s.beliefs()[0].protected
assert s.get(3).meta=={'recall':' waking only ','tone':'calm','released':True,'summary_only':True}
assert s.add_external_episode('synthetic:external','ignored','ignored').id==4
r=Reverie(s)
assert r.read('shared')['revision']==2
assert r.read('shared')['body']=={'order':{'second':2,'first':1},'text':'native revised K','number':-0.0}
assert s._db.execute("SELECT revision FROM reverie_document_history WHERE name='shared'").fetchone()[0]==1
assert r.profiles()['compiler']['body']['long_term']=='retained-private'
assert r.self_model()['body']['consciousness']=='native self'
r.write('shared',{'python':'retained K','ordered':{'last':2,'first':1}},2)
r.save_profile('compiler',{'role':'python role','long_term':'still-private','memory_queries':['python query']},1)
model=r.self_model()['body'].copy();model['persona']='python persona'
r.save_self(model,'style only',1)
ballot=r.ballot_history()[0]
assert ballot['proposal']==json.dumps({'z':'K','a':[True,1.0]},sort_keys=True,separators=(',',':'),ensure_ascii=False)
from unittest.mock import patch
with patch('reverie.reverie.time.time',return_value=345600+ballot['week']*604800+100):
 assert r.vote('vacation',{'z':'K','a':[True,1.0]},'same proposal')['consecutive_weeks']==1
 r.vote('publication',{'python':'retained'},'new category')
s.add_episode('python user','python answer',created_at=400)
s.set_importance(1,9)
s.set_state('python','retained')
s.claim_message('python:claim',now=100)
s.claim_voice('python voice',now=100)
s.close()
b=MemoryStore(backup)
assert b.count()==4 and b.get_state('python') is None
assert Reverie(b).read('shared')['revision']==2
assert Reverie(b).self_model()['revision']==1
assert len(Reverie(b).ballot_history())==1
b.close()
"#;
