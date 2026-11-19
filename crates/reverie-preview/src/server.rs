use crate::{
    Config, Lookup,
    configuration::{INTERNAL_PATH, hostname, page, port_allowed, session_id},
    control_socket::ControlSocket,
    invalid,
    registry::{COOKIE, OPEN_PATH, Registry},
    responses::{Reply, json, protect, status_reply},
    upstream,
};
use http::{HeaderValue, Method, Request, StatusCode, header, uri::Authority};
use http_body_util::{BodyExt, Limited};
use hyper::{body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use rustls::{
    ServerConfig,
    pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
};
use serde::{Deserialize, de::DeserializeOwned};
use std::{
    convert::Infallible,
    fs::OpenOptions,
    future::Future,
    io::{self, Read},
    net::SocketAddr,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream},
    signal::unix::{SignalKind, signal},
    sync::Semaphore,
    task::JoinSet,
    time::timeout,
};
use tokio_rustls::LazyConfigAcceptor;

#[cfg(test)]
mod tests;

const CONNECTION_LIMIT: Duration = Duration::from_secs(36);

pub struct Server {
    tls: Arc<ServerConfig>,
    public: TcpListener,
    control: ControlSocket,
    address: SocketAddr,
    app: Arc<App>,
}

struct App {
    registry: Registry,
    deployment_domain: String,
    lookup: Arc<dyn Lookup>,
    management: Semaphore,
}

pub async fn bind(config: Config, lookup: Arc<dyn Lookup>) -> io::Result<Server> {
    config.validate()?;
    bind_listeners(config, lookup).await
}

pub(crate) async fn bind_listeners(config: Config, lookup: Arc<dyn Lookup>) -> io::Result<Server> {
    let tls = tls(&config)?;
    let public = TcpListener::bind((config.listen_address, config.port)).await?;
    let address = public.local_addr()?;
    let control = ControlSocket::bind(&config.control_socket).await?;
    let app = Arc::new(App {
        registry: Registry::new(&config, address.port()),
        deployment_domain: config.domain,
        lookup,
        management: Semaphore::new(2),
    });
    Ok(Server {
        tls,
        public,
        control,
        address,
        app,
    })
}

impl Server {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub async fn run(self, stop: impl Future<Output = ()>) -> io::Result<()> {
        let mut clients = JoinSet::new();
        let public_slots = Arc::new(Semaphore::new(32));
        let control_slots = Arc::new(Semaphore::new(8));
        tokio::pin!(stop);
        loop {
            tokio::select! {
                _ = &mut stop => break,
                result = self.public.accept() => {
                    let (socket, _) = result?;
                    let Ok(slot) = public_slots.clone().try_acquire_owned() else { continue };
                    let app = self.app.clone();
                    let tls = self.tls.clone();
                    clients.spawn(async move {
                        let _slot = slot;
                        let _ = timeout(CONNECTION_LIMIT, public(socket, tls, app)).await;
                    });
                }
                result = self.control.listener.accept() => {
                    let (socket, _) = result?;
                    let Ok(slot) = control_slots.clone().try_acquire_owned() else { continue };
                    let app = self.app.clone();
                    clients.spawn(async move {
                        let _slot = slot;
                        let _ = timeout(CONNECTION_LIMIT, http(socket, |request| control_reply(&app, request))).await;
                    });
                }
                _ = clients.join_next(), if !clients.is_empty() => {}
            }
        }
        clients.shutdown().await;
        Ok(())
    }
}

pub async fn shutdown() {
    let Ok(mut terminate) = signal(SignalKind::terminate()) else {
        return;
    };
    tokio::select! {
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

async fn public(socket: TcpStream, tls: Arc<ServerConfig>, app: Arc<App>) -> io::Result<()> {
    let (socket, name) = timeout(
        Duration::from_secs(5),
        handshake(socket, tls, &app.deployment_domain),
    )
    .await??;
    http(socket, |request| public_reply(&app, &name, request)).await
}

async fn handshake(
    socket: TcpStream,
    tls: Arc<ServerConfig>,
    domain: &str,
) -> io::Result<(tokio_rustls::server::TlsStream<TcpStream>, String)> {
    let start = LazyConfigAcceptor::new(rustls::server::Acceptor::default(), socket).await?;
    let name = start
        .client_hello()
        .server_name()
        .filter(|name| hostname(name, domain))
        .ok_or_else(|| invalid("unrecognized preview TLS server name"))?
        .to_owned();
    Ok((start.into_stream(tls).await?, name))
}

async fn http<S, F, R>(socket: S, respond: F) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn(Request<Incoming>) -> R,
    R: Future<Output = Reply>,
{
    http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(5))
        .max_headers(64)
        .max_buf_size(24 << 10)
        .keep_alive(false)
        .serve_connection(
            TokioIo::new(socket),
            service_fn(|request| async {
                let mut reply = respond(request).await;
                protect(reply.headers_mut());
                Ok::<_, Infallible>(reply)
            }),
        )
        .await
        .map_err(io::Error::other)
}

fn tls(config: &Config) -> io::Result<Arc<ServerConfig>> {
    let key =
        PrivateKeyDer::from_pem_slice(&material(&config.private_key)?).map_err(io::Error::other)?;
    let certificates = CertificateDer::pem_slice_iter(&material(&config.certificate)?)
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)?;
    let mut tls =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(io::Error::other)?
            .with_no_client_auth()
            .with_single_cert(certificates, key)
            .map_err(io::Error::other)?;
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(tls))
}

fn material(path: &Path) -> io::Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)?;
    let mut bytes = Vec::new();
    if !file.metadata()?.is_file() || file.take(65_537).read_to_end(&mut bytes)? > 65_536 {
        return Err(invalid("invalid preview TLS material"));
    }
    Ok(bytes)
}

async fn public_reply(app: &App, name: &str, request: Request<Incoming>) -> Reply {
    match public_request(app, name, request).await {
        Ok(reply) => reply,
        Err(status) => status_reply(status),
    }
}

async fn public_request(
    app: &App,
    name: &str,
    request: Request<Incoming>,
) -> Result<Reply, StatusCode> {
    let host = exact_host(&request, name).ok_or(StatusCode::NOT_FOUND)?;
    if !app.registry.exists(host) {
        return Err(StatusCode::NOT_FOUND);
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD)
        || request.headers().contains_key(header::UPGRADE)
    {
        let mut reply = status_reply(StatusCode::METHOD_NOT_ALLOWED);
        reply
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return Ok(reply);
    }
    if request.uri().scheme().is_some()
        || request.headers().contains_key(header::TRANSFER_ENCODING)
        || request
            .headers()
            .get(header::CONTENT_LENGTH)
            .is_some_and(|length| length != "0")
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    if request.uri().path() == OPEN_PATH {
        return exchange(&app.registry, host, &request);
    }
    let cookie = preview_cookie(&request);
    let routable = !request.uri().path().starts_with(INTERNAL_PATH);
    let access = match app.registry.access(host, cookie, routable) {
        Ok(access) => access,
        Err(StatusCode::TOO_MANY_REQUESTS) => {
            let mut reply = status_reply(StatusCode::TOO_MANY_REQUESTS);
            reply
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
            return Ok(reply);
        }
        Err(status) => return Err(status),
    };
    let path = request
        .uri()
        .path_and_query()
        .and_then(|raw| page(raw.as_str()))
        .ok_or(StatusCode::BAD_REQUEST)?;
    Ok(upstream::forward(&app.registry, app.lookup.as_ref(), access, request, path).await)
}

fn exact_host<'a>(request: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    let mut values = request.headers().get_all(header::HOST).iter();
    let host = values.next()?.to_str().ok()?;
    if values.next().is_some() || host.parse::<Authority>().ok()?.host() != name {
        return None;
    }
    Some(host)
}

fn preview_cookie(request: &Request<Incoming>) -> &str {
    request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|item| {
            item.trim()
                .split_once('=')
                .filter(|(key, _)| *key == COOKIE)
                .map(|(_, value)| value)
        })
        .unwrap_or("")
}

fn exchange(
    registry: &Registry,
    host: &str,
    request: &Request<Incoming>,
) -> Result<Reply, StatusCode> {
    if *request.method() != Method::GET {
        return Err(StatusCode::BAD_REQUEST);
    }
    let token = request
        .uri()
        .query()
        .and_then(|query| query.strip_prefix("token="))
        .filter(|token| !token.contains('&'))
        .ok_or(StatusCode::BAD_REQUEST)?;
    let opened = registry.exchange(host, token)?;
    let cookie = format!(
        "{COOKIE}={}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={}",
        opened.cookie, opened.max_age
    );
    let mut reply = status_reply(StatusCode::SEE_OTHER);
    reply.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(opened.page.as_str()).map_err(|_| StatusCode::BAD_REQUEST)?,
    );
    reply.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("preview cookie is ASCII"),
    );
    Ok(reply)
}

async fn control_reply(app: &App, request: Request<Incoming>) -> Reply {
    match manage(app, request).await {
        Ok(reply) => reply,
        Err(status) => status_reply(status),
    }
}

async fn manage(app: &App, request: Request<Incoming>) -> Result<Reply, StatusCode> {
    let _slot = app
        .management
        .try_acquire()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let (parts, incoming) = request.into_parts();
    if parts.uri.scheme().is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    match (parts.method, parts.uri.path()) {
        (Method::GET, "/previews") => Ok(json(
            StatusCode::OK,
            serde_json::json!({"previews": app.registry.list()}),
        )),
        (Method::POST, "/previews") => expose(app, incoming).await,
        (Method::POST, path) => {
            let id = path
                .strip_prefix("/previews/")
                .and_then(|id| id.strip_suffix("/open"))
                .ok_or(StatusCode::NOT_FOUND)?;
            let input: Open = control_body(incoming).await?;
            let url = app
                .registry
                .link(id, page(&input.path).ok_or(StatusCode::BAD_REQUEST)?)?;
            Ok(json(StatusCode::OK, serde_json::json!({"url": url})))
        }
        (Method::DELETE, path) => {
            let id = path
                .strip_prefix("/previews/")
                .ok_or(StatusCode::NOT_FOUND)?;
            app.registry.revoke(id)?;
            Ok(json(StatusCode::OK, serde_json::json!({"success": true})))
        }
        _ => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Expose {
    session_id: String,
    port: u16,
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open {
    path: String,
}

async fn expose(app: &App, incoming: Incoming) -> Result<Reply, StatusCode> {
    let input: Expose = control_body(incoming).await?;
    if !session_id(&input.session_id) || !port_allowed(input.port) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let page = page(&input.path).ok_or(StatusCode::BAD_REQUEST)?;
    let target = app
        .lookup
        .resolve(&input.session_id)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let created = app
        .registry
        .expose(input.session_id, input.port, target, page)?;
    Ok(json(StatusCode::CREATED, created))
}

async fn control_body<T: DeserializeOwned>(incoming: Incoming) -> Result<T, StatusCode> {
    let body = timeout(
        Duration::from_secs(5),
        Limited::new(incoming, 4096).collect(),
    )
    .await
    .map_err(|_| StatusCode::REQUEST_TIMEOUT)?
    .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?
    .to_bytes();
    serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)
}
