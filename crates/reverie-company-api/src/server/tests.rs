use super::*;
use crate::{
    client, initialize,
    store::tests::{PublicationGate, hold_publish},
};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "reverie-company-server-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        initialize(path.join("office")).unwrap();
        Self(path)
    }
    fn office(&self) -> PathBuf {
        self.0.join("office")
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(self.office().join("company.json")).unwrap()
    }
    fn token(&self) -> String {
        client::credential(&self.office().join("owner-credential.json")).unwrap()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
struct Release(std::sync::Arc<PublicationGate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_unknown_blocking_job_is_never_acknowledged_stopped_or_allowed_to_publish_late() {
    let root = Root::new();
    let store = Arc::new(CompanyStore::open(root.office()).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    let service = tokio::spawn(serve(listener, Arc::clone(&store), rx));
    let before = root.bytes();
    let gate = hold_publish(&root.office());
    let _release = Release(Arc::clone(&gate));
    let token = root.token();
    let request = tokio::spawn(async move {
        client::call(address,&token,"POST","/api/company/employees",Some(json!({"requestId":"00000000-0000-4000-8000-000000000010","name":"Must stay unpublished"}))).await
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while !gate.entered() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tx.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), service)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result, Err(Error::PublicationUnconfirmed));
    assert_eq!(root.bytes(), before);
    gate.release();
    assert!(request.await.unwrap().is_err());
    let end = Instant::now() + Duration::from_secs(2);
    while store.active_requests() != 0 {
        assert!(Instant::now() < end);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(root.bytes(), before);
    assert!(TcpStream::connect(address).await.is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_cancels_an_incomplete_valid_owner_request_before_dispatch() {
    let root = Root::new();
    let store = Arc::new(CompanyStore::open(root.office()).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    let service = tokio::spawn(serve(listener, store, rx));
    let before = root.bytes();
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream.write_all(format!("POST /api/company/employees HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\n",root.token()).as_bytes()).await.unwrap();
    tx.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), service)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    let mut byte = [0];
    let _ = tokio::time::timeout(Duration::from_secs(1), stream.read(&mut byte))
        .await
        .unwrap();
    assert_eq!(root.bytes(), before);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_headers_and_overcapacity_are_bounded_without_dispatch() {
    let root = Root::new();
    let store = Arc::new(CompanyStore::open(root.office()).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    let service = tokio::spawn(serve(listener, store, rx));
    let before = root.bytes();
    let mut readers = JoinSet::new();
    for _ in 0..9 {
        let mut stream = TcpStream::connect(address).await.unwrap();
        let sent = stream
            .write_all(b"GET /api/company/employees HTTP/1.1\r\nHost: localhost\r\n")
            .await
            .is_ok();
        readers.spawn(async move {
            let mut byte = [0];
            let closed = !sent
                || matches!(
                    tokio::time::timeout(Duration::from_secs(1), stream.read(&mut byte)).await,
                    Ok(Ok(0) | Err(_))
                );
            (stream, closed)
        });
    }
    let mut closed = 0;
    let mut sockets = Vec::new();
    while let Some(result) = readers.join_next().await {
        let (stream, was_closed) = result.unwrap();
        closed += usize::from(was_closed);
        sockets.push(stream);
    }
    assert!(
        closed >= 1,
        "At least the ninth unfinished connection must be refused"
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let result = client::call(
        address,
        &root.token(),
        "GET",
        "/api/company/employees",
        None,
    )
    .await
    .unwrap();
    assert_eq!(result["data"]["employees"], json!([]));
    assert_eq!(root.bytes(), before);
    drop(sockets);
    tx.send(()).unwrap();
    assert_eq!(service.await.unwrap(), Ok(()));
}
