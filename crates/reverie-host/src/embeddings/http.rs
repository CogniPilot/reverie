use super::{
    LlamaError, Result,
    policy::{Endpoint, Origin, ProxySettings},
    redirect::redirect_url,
    timed_io::{BoxStream, TimedIo},
    transport,
};
use bytes::Bytes;
use http::{Method, Request};
use http_body_util::{BodyExt, Full};
use hyper::{body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use rustls_platform_verifier::BuilderVerifierExt;
use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::net::TcpStream;
type Response = hyper::Response<Incoming>;
use reverie_http::http1_builder;
async fn send_response(
    sender: &mut http1::SendRequest<Full<Bytes>>,
    request: Request<Full<Bytes>>,
    allow_continue: bool,
) -> Result<Response> {
    reverie_http::send_response(sender, request, allow_continue)
        .await
        .map_err(|error| match error {
            reverie_http::ResponseError::Informational(status) => LlamaError::HttpStatus(status),
            reverie_http::ResponseError::Transport(error) => transport(error),
        })
}
async fn tls(stream: BoxStream, host: &str, timeout: Duration) -> Result<BoxStream> {
    let host = super::idna::host_to_ascii(host).map_err(|_| LlamaError::InvalidEndpoint)?;
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(transport)?
    .with_platform_verifier()
    .map_err(transport)?
    .with_no_client_auth();
    let server_name = rustls::pki_types::ServerName::try_from(host).map_err(transport)?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let stream = tokio::time::timeout(timeout, connector.connect(server_name, stream))
        .await
        .map_err(transport)?
        .map_err(transport)?;
    Ok(Box::new(stream))
}
async fn socket(endpoint: &Endpoint, timeout: Duration) -> Result<BoxStream> {
    let stream = tcp(endpoint, timeout).await?;
    if endpoint.secure {
        tls(stream, &endpoint.host, timeout).await
    } else {
        Ok(stream)
    }
}
async fn tcp(endpoint: &Endpoint, timeout: Duration) -> Result<BoxStream> {
    let host = endpoint.ascii_host()?;
    let port = endpoint.port()?;
    // socket.create_connection resolves outside its socket timeout, then
    // attempts each address with a fresh connect budget, preserving order.
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(transport)?;
    let socket = connect_each(addresses, timeout, TcpStream::connect).await?;
    let stream: BoxStream = Box::new(socket);
    Ok(stream)
}
async fn connect_each<T, F, Fut>(
    addresses: impl IntoIterator<Item = std::net::SocketAddr>,
    timeout: Duration,
    mut connect: F,
) -> Result<T>
where
    F: FnMut(std::net::SocketAddr) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<T>>,
{
    let mut last = None;
    for address in addresses {
        match tokio::time::timeout(timeout, connect(address)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => last = Some(error),
            Err(_) => {
                last = Some(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "embedding socket connect timeout",
                ))
            }
        }
    }
    Err(transport(last.unwrap_or_else(|| {
        std::io::Error::other("getaddrinfo returns an empty list")
    })))
}
async fn tunnel(proxy: &Endpoint, target: &Endpoint, timeout: Duration) -> Result<BoxStream> {
    // urllib's HTTPS-origin proxy path opens a plaintext CONNECT tunnel even
    // for an https_proxy URI; TLS then authenticates the origin, not the proxy.
    let encoded_host = target.ascii_host()?;
    let port = target.port()?;
    let host = if encoded_host.contains(':') {
        format!("[{encoded_host}]")
    } else {
        encoded_host.clone()
    };
    let authority = format!("{host}:{port}");
    let host_header = format!("{encoded_host}:{port}");
    let stream = TimedIo::new(tcp(proxy, timeout).await?, timeout, 0);
    let active = stream.active_handle();
    let (mut sender, connection) = http1_builder()
        .handshake(TokioIo::new(stream))
        .await
        .map_err(transport)?;
    let driver = tokio::spawn(connection.with_upgrades());
    let mut request = Request::builder()
        .method(Method::CONNECT)
        .uri(&authority)
        .header("Host", host_header);
    if let Some(authorization) = &proxy.authorization {
        request = request.header("Proxy-Authorization", authorization);
    }
    let response = send_response(
        &mut sender,
        request
            .body(Full::<Bytes>::new(Bytes::new()))
            .map_err(transport)?,
        false,
    )
    .await;
    let result = match response {
        Ok(response) if response.status() == http::StatusCode::OK => hyper::upgrade::on(response)
            .await
            .map(|upgraded| Box::new(TokioIo::new(upgraded)) as BoxStream)
            .map_err(transport),
        Ok(response) => Err(LlamaError::HttpStatus(response.status().as_u16())),
        Err(error) => Err(error),
    };
    driver.abort();
    let _ = driver.await;
    active.store(false, Ordering::Release);
    result
}
async fn connect(
    target: &Endpoint,
    proxy: Option<&Endpoint>,
    timeout: Duration,
    proxies: &ProxySettings,
) -> Result<BoxStream> {
    match proxy {
        Some(proxy) if target.secure => {
            tls(tunnel(proxy, target, timeout).await?, &target.host, timeout).await
        }
        Some(proxy) if proxy.secure => {
            let next = proxies.selected(proxy)?;
            let stream = match next.as_ref() {
                Some(next) => tunnel(next, proxy, timeout).await?,
                None => tcp(proxy, timeout).await?,
            };
            tls(stream, &proxy.host, timeout).await
        }
        Some(proxy) => socket(proxy, timeout).await,
        None => socket(target, timeout).await,
    }
}
async fn body(response: Response) -> Result<Vec<u8>> {
    let mut body = response.into_body();
    let mut output = Vec::new();
    while let Some(frame) = body.frame().await {
        if let Ok(data) = frame.map_err(transport)?.into_data() {
            output.try_reserve(data.len()).map_err(transport)?;
            output.extend_from_slice(&data);
        }
    }
    Ok(output)
}
struct Reply {
    next: Option<String>,
    body: Vec<u8>,
}
struct Exchange<'a> {
    target: &'a Origin,
    proxy: Option<&'a Endpoint>,
    method: &'a Method,
    url: &'a str,
    timeout: Duration,
    proxies: &'a ProxySettings,
}
async fn exchange(
    exchange: Exchange<'_>,
    bytes: Vec<u8>,
    visited: &mut BTreeMap<String, usize>,
) -> Result<Reply> {
    let Exchange {
        target,
        proxy,
        method,
        url,
        timeout,
        proxies,
    } = exchange;
    if proxy.is_some() && !target.network.secure && target.forward.is_none() {
        return Err(LlamaError::InvalidEndpoint);
    }
    let stream = TimedIo::new(
        connect(&target.network, proxy, timeout, proxies).await?,
        timeout,
        bytes.len(),
    );
    let (mut sender, connection) = http1_builder()
        .handshake(TokioIo::new(stream))
        .await
        .map_err(transport)?;
    let driver = tokio::spawn(connection);
    let result = send(
        &mut sender,
        Exchange {
            target,
            proxy,
            method,
            url,
            timeout,
            proxies,
        },
        bytes,
        visited,
    )
    .await;
    driver.abort();
    let _ = driver.await;
    result
}
async fn send(
    sender: &mut http1::SendRequest<Full<Bytes>>,
    exchange: Exchange<'_>,
    bytes: Vec<u8>,
    visited: &mut BTreeMap<String, usize>,
) -> Result<Reply> {
    let Exchange {
        target,
        proxy,
        method,
        url,
        proxies,
        ..
    } = exchange;
    let uri = if proxy.is_some() && !target.network.secure {
        target.forward.clone().ok_or(LlamaError::InvalidEndpoint)?
    } else {
        http::Uri::builder()
            .path_and_query(target.path.clone())
            .build()
            .map_err(transport)?
    };
    let mut request = Request::builder()
        .method(method.clone())
        .uri(uri)
        .header("Host", &target.host_header)
        .header("User-Agent", "Python-urllib/3.13")
        .header("Accept-Encoding", "identity")
        .header("Connection", "close");
    if *method == Method::POST {
        request = request
            .header("Content-Type", "application/json")
            .header("Content-Length", bytes.len());
    }
    let nested = proxy
        .filter(|proxy| !target.network.secure && proxy.secure)
        .map(|proxy| proxies.selected(proxy))
        .transpose()?
        .flatten()
        .is_some();
    // On urllib's two-proxy route the inner request has no proxy auth: the
    // second proxy's credential is consumed by CONNECT, never sent onward.
    if !target.network.secure
        && !nested
        && let Some(authorization) = proxy.and_then(|proxy| proxy.authorization.as_ref())
    {
        request = request.header("Proxy-Authorization", authorization);
    }
    let response = send_response(
        sender,
        request
            .body(Full::new(Bytes::from(bytes)))
            .map_err(transport)?,
        true,
    )
    .await?;
    let next = next_location(&response, method, url, visited)?;
    // A complete body is read before following a redirect, just as urllib's
    // redirect handler drains the previous response. There is no JSON body cap
    // or total-transfer timer silently narrowing existing large/slow responses.
    Ok(Reply {
        next,
        body: body(response).await?,
    })
}
fn next_location(
    response: &Response,
    method: &Method,
    url: &str,
    visited: &mut BTreeMap<String, usize>,
) -> Result<Option<String>> {
    let status = response.status();
    if status.is_success() {
        return Ok(None);
    }
    let code = status.as_u16();
    if ![301, 302, 303, 307, 308].contains(&code)
        || method == Method::POST && [307, 308].contains(&code)
    {
        return Err(LlamaError::HttpStatus(code));
    }
    let location = response
        .headers()
        .get("location")
        .or_else(|| response.headers().get("uri"))
        .ok_or(LlamaError::HttpStatus(code))?;
    let selected = redirect_url(url, location.as_bytes())?;
    if visited.get(&selected).copied().unwrap_or(0) >= 4 || visited.len() >= 10 {
        return Err(LlamaError::Redirect);
    }
    *visited.entry(selected.clone()).or_default() += 1;
    Ok(Some(selected))
}
pub(super) async fn request(
    url: reverie_contracts::storage_identity::MetadataText,
    mut bytes: Vec<u8>,
    timeout: Duration,
    proxies: &ProxySettings,
) -> Result<Vec<u8>> {
    let mut method = Method::POST;
    let mut visited = BTreeMap::<String, usize>::new();
    let mut target = Origin::parse_text(&url)?;
    loop {
        let url = target.full_url.clone();
        let proxy = proxies.selected(&target.network)?;
        let reply = exchange(
            Exchange {
                target: &target,
                proxy: proxy.as_ref(),
                method: &method,
                url: &url,
                timeout,
                proxies,
            },
            bytes.clone(),
            &mut visited,
        )
        .await?;
        let Some(selected) = reply.next else {
            return Ok(reply.body);
        };
        target = Origin::parse(&selected)?;
        method = Method::GET;
        bytes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, io, net::SocketAddr, time::Instant};
    async fn delayed_candidate(address: SocketAddr) -> io::Result<SocketAddr> {
        if address.port() == 9 {
            std::future::pending::<()>().await;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        Ok(address)
    }
    async fn failed_candidate(address: SocketAddr) -> io::Result<()> {
        let kind = if address.port() == 9 {
            io::ErrorKind::AddrNotAvailable
        } else {
            io::ErrorKind::ConnectionRefused
        };
        Err(io::Error::new(kind, "synthetic connect"))
    }
    #[test]
    fn each_resolved_address_receives_its_own_connect_budget() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let addresses = [
                "127.0.0.1:9".parse::<SocketAddr>().unwrap(),
                "127.0.0.1:10".parse().unwrap(),
            ];
            let attempted = RefCell::new(Vec::new());
            let budget = Duration::from_millis(120);
            let started = Instant::now();
            let selected = connect_each(addresses, budget, |address| {
                attempted.borrow_mut().push(address);
                delayed_candidate(address)
            })
            .await
            .unwrap();
            assert_eq!(selected, addresses[1]);
            assert_eq!(*attempted.borrow(), addresses);
            assert!(started.elapsed() >= budget);
        });
    }
    #[test]
    fn all_failed_addresses_return_the_last_error_and_empty_resolution_refuses() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let addresses = [
                "127.0.0.1:9".parse::<SocketAddr>().unwrap(),
                "127.0.0.1:10".parse().unwrap(),
            ];
            let result = connect_each(addresses, Duration::from_secs(1), failed_candidate).await;
            let Err(LlamaError::Transport(error)) = result else {
                panic!("last connect must fail");
            };
            assert_eq!(
                error.downcast_ref::<io::Error>().unwrap().kind(),
                io::ErrorKind::ConnectionRefused
            );
            let empty = connect_each([], Duration::from_secs(1), |_| async { Ok(()) }).await;
            assert!(matches!(empty, Err(LlamaError::Transport(_))));
        });
    }
}
