//! Actual installed service and SQLite processes on owned synthetic roots.
use reverie_application::memory_lifecycle::{
    InstalledMemory, MemoryLifecycleError, ScopeStartupReport,
};
use reverie_core::memory::{EmbeddingText, MemoryScope, ProjectName};
use reverie_host::memory_lifecycle::LifecycleError;
use reverie_store::memory::{MemoryStore, ReflectionInput};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const ENTRY: &str = "service_child";
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "installed-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("config")).unwrap();
        fs::write(root.join("config/instance.json"),r#"{"id":"synthetic","agent_name":"Agent","owner_name":"Owner","data_dir":"../state","persona":"Chosen persona"}"#).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn run(&self, case: &str) {
        successful(self.command(case).output().unwrap());
    }
    fn command(&self, case: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", ENTRY, "--nocapture"])
            .env_clear()
            .env("HOME", &self.0)
            .env(
                "REVERIE_INSTANCE_CONFIG",
                self.0.join("config/instance.json"),
            )
            .env("REVERIE_EMBED_DIMS", "8")
            .env("REVERIE_RECALL_K", "2")
            .env("OWNED_INSTALLED_MEMORY", case);
        command
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
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn explicit_private_boot_is_idempotent_and_readonly_cli_count_stays_eight() {
    Tree::new().run("private");
}
#[test]
fn project_initialization_and_six_result_recall_never_create_private_memory() {
    Tree::new().run("project");
}
#[test]
fn missing_scope_returns_typed_not_initialized_without_creating_any_state() {
    let tree = Tree::new();
    tree.run("missing");
    assert!(!tree.0.join("state").exists());
}
#[test]
fn shutdown_busy_fence_is_real_and_does_not_close_an_active_scope() {
    let tree = Tree::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let root = tree.0.clone();
    let worker = std::thread::spawn(move || blocking_server(listener, &root));
    successful(
        tree.command("busy")
            .env("REVERIE_EMBED_URL", url)
            .output()
            .unwrap(),
    );
    worker.join().unwrap();
}
#[test]
fn service_child() {
    let Ok(case) = std::env::var("OWNED_INSTALLED_MEMORY") else {
        return;
    };
    let service = Arc::new(InstalledMemory::capture_current().unwrap());
    let root = PathBuf::from(std::env::var_os("HOME").unwrap());
    let project = MemoryScope::Project(ProjectName::parse("project-one").unwrap());
    match case.as_str() {
        "missing" => {
            for scope in [&MemoryScope::Private, &project] {
                assert!(matches!(
                    service.recall(scope, EmbeddingText::from_scalar_text("topic")),
                    Err(MemoryLifecycleError::Control(
                        LifecycleError::NotInitialized
                    ))
                ));
            }
        }
        "private" => private(&service, &root),
        "project" => project_case(&service, &root, &project),
        "busy" => busy(&service),
        _ => panic!("unknown owned case"),
    }
    service.close().unwrap();
    assert!(matches!(
        service.recall(
            &MemoryScope::Private,
            EmbeddingText::from_scalar_text("topic")
        ),
        Err(MemoryLifecycleError::Closed)
    ));
    service.close().unwrap();
}
fn private(service: &InstalledMemory, root: &std::path::Path) {
    let first = service.startup(&MemoryScope::Private, &[]).unwrap();
    assert!(matches!(first, ScopeStartupReport::Private(_)));
    let profile = fs::read(root.join("state/profile.md")).unwrap();
    let store = MemoryStore::open_with(
        root.join("state/memory.sqlite"),
        Arc::new(reverie_core::memory::HashedEmbedder::new(8)),
        0.995,
    )
    .unwrap();
    add_memories(&store);
    let before = store.reflections().unwrap();
    let revision = store.documents(None).self_model().unwrap().revision.value();
    store.close().unwrap();
    let memories = service
        .recall(
            &MemoryScope::Private,
            EmbeddingText::from_scalar_text("topic"),
        )
        .unwrap();
    assert_eq!(
        memories.len(),
        8,
        "memory_cli's fixed8, independent of chat recall settings"
    );
    service.startup(&MemoryScope::Private, &[]).unwrap();
    assert_eq!(fs::read(root.join("state/profile.md")).unwrap(), profile);
    let store = MemoryStore::open(root.join("state/memory.sqlite")).unwrap();
    let after = store.reflections().unwrap();
    assert_eq!(before.len(), after.len());
    for (old, new) in before.iter().zip(&after) {
        assert_eq!(old.id, new.id);
        assert_eq!(old.last_accessed, new.last_accessed);
        assert_eq!(old.text, new.text);
    }
    assert_eq!(
        store.documents(None).self_model().unwrap().revision.value(),
        revision
    );
    store.close().unwrap();
}
fn project_case(service: &InstalledMemory, root: &std::path::Path, scope: &MemoryScope) {
    service.startup(scope, &[]).unwrap();
    assert!(!root.join("state/memory.sqlite").exists());
    assert!(!root.join("state/profile.md").exists());
    let store = MemoryStore::open(root.join("state/projects/project-one/memory.sqlite")).unwrap();
    add_memories(&store);
    store.close().unwrap();
    assert_eq!(
        service
            .recall(scope, EmbeddingText::from_scalar_text("topic"))
            .unwrap()
            .len(),
        6
    );
    assert!(!root.join("state/memory.sqlite").exists());
}
fn add_memories(store: &MemoryStore) {
    for index in 0..10 {
        store
            .add_reflection(ReflectionInput::new(
                &format!("topic synthetic {index}"),
                5.0,
                &[],
            ))
            .unwrap();
    }
}
fn busy(service: &Arc<InstalledMemory>) {
    service.startup(&MemoryScope::Private, &[]).unwrap();
    let other = Arc::clone(service);
    let worker = std::thread::spawn(move || {
        other.recall(
            &MemoryScope::Private,
            EmbeddingText::from_scalar_text("topic"),
        )
    });
    let root = PathBuf::from(std::env::var_os("HOME").unwrap());
    wait_path(&root.join("query-held"));
    assert!(matches!(service.close(), Err(MemoryLifecycleError::Busy)));
    assert!(matches!(
        service.startup(&MemoryScope::Private, &[]),
        Err(MemoryLifecycleError::Busy)
    ));
    fs::write(root.join("release-query"), b"test-sync-only").unwrap();
    assert!(worker.join().unwrap().unwrap().is_empty());
}
fn wait_path(path: &std::path::Path) {
    let until = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(Instant::now() < until, "owned test phase not reached");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn blocking_server(listener: TcpListener, root: &std::path::Path) {
    for index in 0..2 {
        let mut socket = accept(&listener);
        consume_request(&mut socket);
        if index == 1 {
            fs::write(root.join("query-held"), b"actual-inference-pending").unwrap();
            wait_path(&root.join("release-query"));
        }
        let body = br#"{"data":[{"embedding":[3,4]}]}"#;
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        socket.write_all(body).unwrap();
    }
    assert!(
        matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
        "no extra probe/replayed request"
    );
}
fn accept(listener: &TcpListener) -> TcpStream {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return socket;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < until);
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{error}"),
        }
    }
}
fn consume_request(socket: &mut TcpStream) {
    let mut raw = Vec::new();
    while !raw.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        raw.push(byte[0]);
        assert!(raw.len() < 65536);
    }
    let header = String::from_utf8(raw).unwrap();
    let size = header
        .split("\r\n")
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    let mut body = vec![0; size];
    socket.read_exact(&mut body).unwrap();
}
