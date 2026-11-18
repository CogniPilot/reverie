use super::{
    destination::Target,
    page::{BYTE_CAP, Page},
};
use bytes::Bytes;
use http::{HeaderMap, Request, StatusCode, header};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use reverie_http::{http1_builder, send_response};
use rustls_platform_verifier::BuilderVerifierExt;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::TlsConnector;

const ACCEPT: &str = "text/html, text/plain, application/rss+xml, application/atom+xml";

pub(super) async fn fetch(target: Target) -> Option<Page> {
    // TCP uses only a checked address; TLS still verifies the URL host.
    let address = target.resolve().await?;
    let name = rustls::pki_types::ServerName::try_from(target.host.clone()).ok()?;
    let socket = tokio::net::TcpStream::connect(address).await.ok()?;
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .ok()?
    .with_platform_verifier()
    .ok()?
    .with_no_client_auth();
    let tls = TlsConnector::from(Arc::new(config))
        .connect(name, socket)
        .await
        .ok()?;
    exchange(tls, request(target)?).await
}

fn request(target: Target) -> Option<Request<Full<Bytes>>> {
    Request::get(target.path.as_str())
        .header(header::HOST, target.authority)
        .header(header::ACCEPT, ACCEPT)
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::USER_AGENT, "Reverie-Public-Read/1")
        .header(header::CONNECTION, "close")
        .body(Full::default())
        .ok()
}

async fn exchange<T>(stream: T, request: Request<Full<Bytes>>) -> Option<Page>
where
    T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (mut sender, connection) = http1_builder().handshake(TokioIo::new(stream)).await.ok()?;
    let driver = tokio::spawn(connection);
    let result = read_reply(&mut sender, request).await;
    driver.abort();
    result
}

async fn read_reply(
    sender: &mut hyper::client::conn::http1::SendRequest<Full<Bytes>>,
    request: Request<Full<Bytes>>,
) -> Option<Page> {
    let reply = send_response(sender, request, true).await.ok()?;
    if reply.status() != StatusCode::OK {
        return None;
    }
    let plain = text_kind(reply.headers())?;
    let mut body = reply.into_body();
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.ok()?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        let remaining = BYTE_CAP - bytes.len();
        if data.len() > remaining {
            bytes.extend_from_slice(&data[..remaining]);
            return Some(Page {
                body: bytes,
                plain,
                partial: true,
            });
        }
        bytes.extend_from_slice(&data);
    }
    Some(Page {
        body: bytes,
        plain,
        partial: false,
    })
}

fn text_kind(headers: &HeaderMap) -> Option<bool> {
    if headers
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .any(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return None;
    }
    let content = headers
        .get(header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim();
    match content.to_ascii_lowercase().as_str() {
        "text/plain" => Some(true),
        "text/html"
        | "application/rss+xml"
        | "application/atom+xml"
        | "application/xml"
        | "text/xml" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
