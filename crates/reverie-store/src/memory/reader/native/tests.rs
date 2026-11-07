use super::*;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-native-read-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> PathBuf {
        self.0.join("memory.sqlite")
    }
    fn ready(&self) {
        let mut owner = MemoryStartupStore::open(self.path()).unwrap();
        owner.preflight().unwrap();
        owner
            .admit(Arc::new(HashedEmbedder::new(8)), 0.995)
            .unwrap();
        owner.ready().unwrap();
        owner.into_ready().unwrap().close().unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn isolated(name: &str) -> bool {
    const ENV: &str = "REVERIE_NATIVE_READ_OWNING_CASE";
    if std::env::var(ENV).as_deref() == Ok(name) {
        return true;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env(ENV, name)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("1 passed; 0 failed") && stdout.contains(&format!("test {name} ...")),
        "{stdout}"
    );
    false
}
fn busy(error: &MemoryError) -> bool {
    match error {
        MemoryError::Sqlite(rusqlite::Error::SqliteFailure(code, _)) => {
            code.code == rusqlite::ErrorCode::DatabaseBusy
        }
        MemoryError::Finalization { primary, secondary } => busy(primary) || busy(secondary),
        _ => false,
    }
}
#[test]
fn failed_native_qualification_retains_real_busy_connection_and_anchors() {
    const NAME: &str = "memory::reader::native::tests::failed_native_qualification_retains_real_busy_connection_and_anchors";
    if !isolated(NAME) {
        return;
    }
    let tree = Tree::new();
    let db = Connection::open(tree.path()).unwrap();
    db.execute_batch("CREATE TABLE retained(id INTEGER PRIMARY KEY, body BLOB); INSERT INTO retained VALUES(41,x'0001ff00');").unwrap();
    db.close().unwrap();
    let before = fs::read(tree.path()).unwrap();
    let owner = NativeMemoryRead::capture(tree.path()).unwrap();
    {
        let state = owner.state.lock().unwrap();
        let db = state.profile.connection.as_ref().unwrap();
        // Safe test-only forgotten statement forces actual sqlite3_close BUSY.
        // This owning subprocess releases it only at process exit; no product
        // unsafe, raw-connection accessor or fake finalization receipt exists.
        std::mem::forget(db.prepare("SELECT 1").unwrap());
    }
    let primary = owner.qualify().unwrap_err();
    assert!(matches!(primary, MemoryError::NotInitialized));
    let MemoryError::NativeReadPending { primary, reader } = owner.failed(primary) else {
        panic!("actual BUSY owner discarded")
    };
    assert!(busy(&primary));
    assert!(matches!(reader.shutdown(), ShutdownStatus::Pending(_)));
    assert!(matches!(
        reader.qualify(),
        Err(MemoryError::ReadinessUnconfirmed)
    ));
    let state = reader.state.lock().unwrap();
    let db = state
        .profile
        .connection
        .as_ref()
        .expect("actual SQLite handle retained");
    state
        .profile
        .source
        .as_ref()
        .expect("anchors retained")
        .assert_identity(db)
        .unwrap();
    assert_eq!(
        db.query_row("SELECT body FROM retained WHERE id=41", [], |r| r
            .get::<_, Vec<u8>>(0))
            .unwrap(),
        [0, 1, 255, 0]
    );
    assert_eq!(before, fs::read(tree.path()).unwrap());
}
#[test]
fn failed_bound_read_retains_real_busy_connection_and_anchors() {
    const NAME: &str =
        "memory::reader::native::tests::failed_bound_read_retains_real_busy_connection_and_anchors";
    if !isolated(NAME) {
        return;
    }
    let tree = Tree::new();
    tree.ready();
    let reader = MemoryReadProfile::open_native(tree.path())
        .unwrap()
        .bind(Arc::new(HashedEmbedder::new(8)), 0.995)
        .unwrap();
    {
        let connection = reader.connection.lock().unwrap();
        std::mem::forget(connection.as_ref().unwrap().prepare("SELECT 1").unwrap());
    }
    let MemoryError::ReaderPending { primary, reader } =
        reader.finalize_error(MemoryError::NeedsProfileRefresh)
    else {
        panic!("bound BUSY owner discarded")
    };
    assert!(busy(&primary));
    assert!(matches!(reader.shutdown(), ShutdownStatus::Pending(_)));
    let connection = reader.connection.lock().unwrap();
    let source = reader.source.lock().unwrap();
    source
        .as_ref()
        .expect("actual bound source retained")
        .assert_identity(
            connection
                .as_ref()
                .expect("actual bound connection retained"),
        )
        .unwrap();
}
#[test]
fn native_reader_refuses_rebound_source_and_consumed_close_stays_negative() {
    let tree = Tree::new();
    tree.ready();
    let reader = MemoryReadProfile::open_native(tree.path())
        .unwrap()
        .bind(Arc::new(HashedEmbedder::new(8)), 0.995)
        .unwrap();
    fs::rename(tree.path(), tree.0.join("original.sqlite")).unwrap();
    fs::write(tree.path(), b"foreign source must remain unchanged").unwrap();
    assert!(matches!(
        reader.native_readiness(),
        Err(MemoryError::ReadinessChanged)
    ));
    assert!(matches!(reader.shutdown(), ShutdownStatus::Refused(_)));
    assert!(reader.connection.lock().unwrap().is_none());
    assert!(matches!(reader.shutdown(), ShutdownStatus::Refused(_)));
    assert_eq!(
        fs::read(tree.path()).unwrap(),
        b"foreign source must remain unchanged"
    );
}
fn anchor_fd(path: &Path) -> u32 {
    for entry in fs::read_dir("/proc/self/fd").unwrap() {
        let entry = entry.unwrap();
        if fs::read_link(entry.path()).ok().as_deref() != Some(path) {
            continue;
        }
        let number = entry.file_name().to_str().unwrap().parse::<u32>().unwrap();
        let info = fs::read_to_string(format!("/proc/self/fdinfo/{number}")).unwrap();
        let flags = info
            .lines()
            .find_map(|line| line.strip_prefix("flags:\t"))
            .unwrap();
        let flags = u32::from_str_radix(flags.trim(), 8).unwrap();
        if flags & libc::O_PATH as u32 != 0 {
            return number;
        }
    }
    panic!("actual O_PATH main anchor absent")
}
#[test]
fn resolved_sqlite_name_survives_closed_anchor_and_actual_descriptor_reuse() {
    const NAME: &str = "memory::reader::native::tests::resolved_sqlite_name_survives_closed_anchor_and_actual_descriptor_reuse";
    if !isolated(NAME) {
        return;
    }
    let tree = Tree::new();
    tree.ready();
    let mut profile = MemoryReadProfile::open_native(tree.path()).unwrap();
    let fd = anchor_fd(&tree.path());
    let db = profile.connection.as_ref().unwrap();
    let resolved: String = db
        .query_row("PRAGMA database_list", [], |row| row.get(2))
        .unwrap();
    assert_eq!(resolved, tree.path().to_str().unwrap());
    // Deliberate OLD-lifetime discriminator only. Product owners now retain
    // the anchors until SQLite close; this test separately qualifies VFS name
    // resolution after the proc-fd spelling ceases to refer to this database.
    profile.source.as_mut().unwrap().close().unwrap();
    let mut decoys = Vec::new();
    for _ in 0..32 {
        use std::os::fd::AsRawFd;
        let file = fs::File::open("/dev/null").unwrap();
        let reused = file.as_raw_fd() as u32 == fd;
        decoys.push(file);
        if reused {
            break;
        }
    }
    assert_eq!(
        fs::read_link(format!("/proc/self/fd/{fd}")).unwrap(),
        PathBuf::from("/dev/null")
    );
    let mut moved = 1;
    db.file_control(Some("main"), rusqlite::FileControl::HasMoved(&mut moved))
        .unwrap();
    assert_eq!(moved, 0);
    assert_eq!(
        db.query_row("SELECT format FROM reverie_native_memory_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    profile.connection.take().unwrap().close().unwrap();
    drop(decoys);
}
