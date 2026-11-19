use super::{Server, bind_listeners};
use crate::{
    Lookup, Target,
    registry::{COOKIE, OPEN_PATH},
    responses::{Body, payload},
};
use bytes::Bytes;
use http::{HeaderMap, Method, Request, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full};
use hyper::{
    body::{Frame, Incoming, SizeHint},
    client::conn::http1 as client,
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, ServerName, pem::PemObject},
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    fs,
    future::Future,
    io,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    pin::Pin,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream, UnixStream},
    sync::{Notify, oneshot},
    task::JoinHandle,
};
use tokio_rustls::TlsConnector;

const SID: &str = "11111111-2222-4333-8444-555555555555";
const WASM: &[u8] = b"\0asm\x01\0\0\0";

#[derive(Clone)]
struct Resolver(Arc<Mutex<Target>>);
impl Lookup for Resolver {
    fn resolve<'a>(
        &'a self,
        _sid: &'a str,
    ) -> Pin<Box<dyn Future<Output = io::Result<Target>> + Send + 'a>> {
        Box::pin(async { Ok(self.0.lock().unwrap().clone()) })
    }
}

struct Fixture {
    dir: Directory,
    tls: TlsConnector,
    address: SocketAddr,
    upstream: Arc<Upstream>,
    resolver: Resolver,
    stop: Option<oneshot::Sender<()>>,
    _preview: Task,
    _upstream: Task,
}

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        if !self.0.join("preview.sock").exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
struct Task(JoinHandle<()>);
impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Default)]
struct Upstream {
    port: u16,
    seen: Mutex<Vec<HeaderMap>>,
    hold: Notify,
    entered: Notify,
}

impl Upstream {
    async fn wait_for_requests(&self, count: usize) {
        while self.seen.lock().unwrap().len() < count {
            self.entered.notified().await;
        }
    }
}

impl Fixture {
    async fn new() -> Self {
        let dir =
            Directory(nix::unistd::mkdtemp(&std::env::temp_dir().join("rvpv-XXXXXX")).unwrap());
        let tls = certificates(&dir);
        let resolver = Resolver(Arc::new(Mutex::new(Target {
            container: "test-container".into(),
            network: "test-network".into(),
            address: Ipv4Addr::LOCALHOST,
        })));
        let upstream_socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let upstream = Arc::new(Upstream {
            port: upstream_socket.local_addr().unwrap().port(),
            ..Upstream::default()
        });
        let config = serde_json::from_value(json!({
            "version":1, "domain":"preview.test", "officeOrigin":"https://office.test",
            "deployment":"fixture", "listenAddress":"127.0.0.1", "port":0,
            "auditFile":dir.0.join("audit.jsonl"), "certificate":dir.0.join("cert.pem"),
            "privateKey":dir.0.join("key.pem"), "controlSocket":dir.0.join("preview.sock"),
        }))
        .unwrap();
        let server = bind_listeners(config, Arc::new(resolver.clone()))
            .await
            .unwrap();
        let address = server.address();
        let upstream_task = Task(tokio::spawn(serve_upstream(
            upstream_socket,
            upstream.clone(),
        )));
        let (stop, stopped) = oneshot::channel();
        let preview_task = Task(tokio::spawn(run(server, stopped)));
        Fixture {
            dir,
            tls,
            address,
            upstream,
            resolver,
            stop: Some(stop),
            _preview: preview_task,
            _upstream: upstream_task,
        }
    }

    async fn finish(mut self) {
        self.stop.take().unwrap().send(()).unwrap();
        (&mut self._preview.0).await.unwrap();
        assert!(!self.dir.0.join("preview.sock").exists());
    }

    async fn control(&self, method: Method, path: &str, body: Value) -> Read {
        let connection = UnixStream::connect(self.dir.0.join("preview.sock"))
            .await
            .unwrap();
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "owner.test")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(serde_json::to_vec(&body).unwrap().into()))
            .unwrap();
        collect(connection, request).await
    }

    async fn register(&self, path: &str) -> Ticket {
        let reply = self
            .control(
                Method::POST,
                "/previews",
                json!({"sessionId": SID, "port": self.upstream.port, "path": path}),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED);
        let value: Value = serde_json::from_slice(&reply.body).unwrap();
        Ticket {
            id: value["preview"]["id"].as_str().unwrap().to_owned(),
            link: value["url"].as_str().unwrap().parse().unwrap(),
        }
    }

    async fn public(
        &self,
        method: Method,
        authority: &str,
        path: &str,
        cookie: Option<&str>,
    ) -> Read {
        self.public_as(
            method,
            authority,
            authority.split(':').next().unwrap(),
            path,
            cookie,
        )
        .await
    }

    async fn public_as(
        &self,
        method: Method,
        authority: &str,
        sni: &str,
        path: &str,
        cookie: Option<&str>,
    ) -> Read {
        let socket = TcpStream::connect(self.address).await.unwrap();
        let stream = self
            .tls
            .connect(ServerName::try_from(sni.to_owned()).unwrap(), socket)
            .await
            .unwrap();
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, authority);
        if let Some(cookie) = cookie {
            req = req
                .header(header::COOKIE, format!("{cookie}; reverie_owner=private"))
                .header(header::AUTHORIZATION, "Bearer secret")
                .header("X-Reverie-Service-Token", "secret");
        }
        collect(stream, req.body(Full::new(Bytes::new())).unwrap()).await
    }

    async fn open(&self, ticket: &Ticket) -> Read {
        self.public(Method::GET, ticket.authority(), ticket.path(), None)
            .await
    }
}

async fn run(server: Server, stopped: oneshot::Receiver<()>) {
    server
        .run(async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
}

struct Ticket {
    id: String,
    link: Uri,
}

impl Ticket {
    fn authority(&self) -> &str {
        self.link.authority().unwrap().as_str()
    }
    fn path(&self) -> &str {
        self.link.path_and_query().unwrap().as_str()
    }
}

struct Read {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}
impl Read {
    fn cookie(&self) -> &str {
        self.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
    }
}

async fn collect<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: S,
    request: Request<Full<Bytes>>,
) -> Read {
    let (mut sender, connection) = client::handshake(TokioIo::new(stream)).await.unwrap();
    let driver = Task(tokio::spawn(async move {
        let _ = connection.await;
    }));
    let (parts, body) = sender.send_request(request).await.unwrap().into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    drop(driver);
    Read {
        status: parts.status,
        headers: parts.headers,
        body,
    }
}

fn certificates(dir: &Directory) -> TlsConnector {
    let status = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-keyout",
            "key.pem",
            "-out",
            "cert.pem",
            "-subj",
            "/CN=*.preview.test",
            "-addext",
            "subjectAltName=DNS:*.preview.test",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
        ])
        .current_dir(&dir.0)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let certificate = CertificateDer::from_pem_file(dir.0.join("cert.pem")).unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(certificate).unwrap();
    let tls =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
    TlsConnector::from(Arc::new(tls))
}

async fn serve_upstream(listener: TcpListener, upstream: Arc<Upstream>) {
    while let Ok((socket, _)) = listener.accept().await {
        let upstream = upstream.clone();
        tokio::spawn(async move {
            let _ = http1::Builder::new()
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(|request| answer_upstream(&upstream, request)),
                )
                .await;
        });
    }
}

async fn answer_upstream(
    upstream: &Upstream,
    request: Request<Incoming>,
) -> Result<http::Response<Body>, Infallible> {
    upstream
        .seen
        .lock()
        .unwrap()
        .push(request.headers().clone());
    let mut reply = http::Response::builder()
        .header(header::CONTENT_TYPE, "application/wasm")
        .header(header::SET_COOKIE, "reverie_owner=upstream")
        .header("access-control-allow-origin", "*")
        .header("x-secret", "upstream");
    match request.uri().path() {
        "/redirect" => {
            reply = reply
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "https://example.invalid/")
        }
        "/local" => {
            reply = reply
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "/page?part=2")
        }
        "/large" => return Ok(reply.body(Oversized.boxed_unsync()).unwrap()),
        "/hold" => {
            let release = upstream.hold.notified();
            upstream.entered.notify_one();
            release.await;
        }
        _ => {}
    }
    Ok(reply.body(payload(Bytes::from_static(WASM))).unwrap())
}

struct Oversized;
impl hyper::body::Body for Oversized {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        Poll::Pending
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact((64 << 20) + 1)
    }
}

#[tokio::test]
async fn serves_real_isolated_tls_and_revokes_pinned_origins() {
    let fixture = Fixture::new().await;
    let ticket = fixture.register("/page?q=1").await;
    assert_eq!(
        fixture
            .public(Method::GET, ticket.authority(), "/", None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        fixture
            .public(Method::POST, ticket.authority(), "/", None)
            .await
            .status,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let opened = fixture.open(&ticket).await;
    assert_eq!(opened.status, StatusCode::SEE_OTHER);
    assert_eq!(opened.headers[header::LOCATION], "/page?q=1");
    let header = opened.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(header.contains("HttpOnly; Secure; SameSite=Lax; Path=/"));
    assert!(!header.contains("Domain="));
    assert!(opened.cookie().starts_with(COOKIE));
    assert_eq!(fixture.open(&ticket).await.status, StatusCode::FORBIDDEN);
    let reply = fixture
        .public(
            Method::GET,
            ticket.authority(),
            "/module.wasm",
            Some(opened.cookie()),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, Bytes::from_static(WASM));
    assert_eq!(reply.headers[header::CONTENT_TYPE], "application/wasm");
    assert_eq!(
        reply.headers["cross-origin-embedder-policy"],
        "require-corp"
    );
    for key in ["set-cookie", "access-control-allow-origin", "x-secret"] {
        assert!(!reply.headers.contains_key(key));
    }
    for key in ["cookie", "authorization", "x-reverie-service-token"] {
        assert!(!fixture.upstream.seen.lock().unwrap()[0].contains_key(key));
    }
    assert_eq!(
        fixture
            .public(
                Method::GET,
                ticket.authority(),
                "/redirect",
                Some(opened.cookie())
            )
            .await
            .status,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(
        fixture
            .public(
                Method::GET,
                ticket.authority(),
                "/local",
                Some(opened.cookie())
            )
            .await
            .headers[header::LOCATION],
        "/page?part=2"
    );
    assert_eq!(
        fixture
            .public(
                Method::GET,
                ticket.authority(),
                "/large",
                Some(opened.cookie())
            )
            .await
            .status,
        StatusCode::BAD_GATEWAY
    );
    let audit = fs::read_to_string(fixture.dir.0.join("audit.jsonl")).unwrap();
    assert!(audit.contains("preview_open") && audit.contains("preview_expose"));
    assert!(!audit.contains(opened.cookie()) && !audit.contains(ticket.path()));
    fixture.resolver.0.lock().unwrap().container = "replacement".to_owned();
    assert_eq!(
        fixture
            .public(Method::GET, ticket.authority(), "/", Some(opened.cookie()))
            .await
            .status,
        StatusCode::GONE
    );
    assert_eq!(
        fixture
            .public(Method::GET, ticket.authority(), "/", Some(opened.cookie()))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    fixture.finish().await;
}

#[tokio::test]
async fn grants_and_tls_names_cannot_be_retargeted_or_share_authority() {
    let fixture = Fixture::new().await;
    let first = fixture.register("/").await;
    let second = fixture.register("/").await;
    assert_eq!(
        fixture
            .public(Method::GET, second.authority(), first.path(), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let different_sni = second.link.host().unwrap();
    assert_eq!(
        fixture
            .public_as(
                Method::GET,
                first.authority(),
                different_sni,
                first.path(),
                None
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let raw = TcpStream::connect(fixture.address).await.unwrap();
    assert!(
        fixture
            .tls
            .connect(ServerName::try_from("office.test").unwrap(), raw)
            .await
            .is_err()
    );
    for (port, path) in [
        (8092, "/"),
        (8093, "/"),
        (8094, "//foreign"),
        (8094, OPEN_PATH),
    ] {
        let reply = fixture
            .control(
                Method::POST,
                "/previews",
                json!({"sessionId": SID, "port": port, "path": path}),
            )
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        fixture
            .control(
                Method::DELETE,
                &format!("/previews/{}", first.id),
                Value::Null
            )
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(fixture.open(&first).await.status, StatusCode::NOT_FOUND);
    assert_eq!(fixture.open(&second).await.status, StatusCode::SEE_OTHER);
    fixture.finish().await;
}

#[tokio::test]
async fn concurrent_requests_remain_bounded_and_revocation_closes_inflight_access() {
    let fixture = Fixture::new().await;
    let ticket = fixture.register("/").await;
    let opened = fixture.open(&ticket).await;
    let hold = || {
        fixture.public(
            Method::GET,
            ticket.authority(),
            "/hold",
            Some(opened.cookie()),
        )
    };
    let four = async { tokio::join!(hold(), hold(), hold(), hold()) };
    let revoke = async {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture.upstream.wait_for_requests(4),
        )
        .await
        .unwrap();
        let limited = fixture
            .public(Method::GET, ticket.authority(), "/", Some(opened.cookie()))
            .await;
        assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(limited.headers[header::RETRY_AFTER], "5");
        assert_eq!(
            fixture
                .control(
                    Method::DELETE,
                    &format!("/previews/{}", ticket.id),
                    Value::Null
                )
                .await
                .status,
            StatusCode::OK
        );
    };
    let ((a, b, c, d), ()) = tokio::join!(four, revoke);
    for reply in [a, b, c, d] {
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
    }
    fixture.upstream.hold.notify_waiters();
    fixture.finish().await;
}
