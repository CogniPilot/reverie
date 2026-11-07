use crate::{Result, need};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, Uri, client::conn::http1};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::{net::IpAddr, time::Duration};

pub(crate) async fn recognize(base: &str, wav: Vec<u8>) -> Result<String> {
    // The companion fixture writes this loopback HTTP address; this is not a
    // generic URL/credential transport. Hyper owns all HTTP framing.
    let uri: Uri = format!("{base}/stt").parse()?;
    need(
        uri.scheme_str() == Some("http"),
        "Expected local voice-CI HTTP adapter",
    )?;
    let authority = uri.authority().ok_or("Missing voice-CI authority")?;
    let address: IpAddr = uri
        .host()
        .ok_or("Missing voice-CI host")?
        .trim_matches(['[', ']'])
        .parse()?;
    need(address.is_loopback(), "Expected local voice-CI adapter")?;
    let request = Request::post(uri.path_and_query().ok_or("Missing STT path")?.as_str())
        .header("Host", authority.as_str())
        .header("Content-Type", "audio/wav")
        .body(Full::new(Bytes::from(wav)))?;
    let target = (address, uri.port_u16().unwrap_or(80));
    tokio::time::timeout(Duration::from_secs(90), exchange(target, request)).await?
}

async fn exchange(target: (IpAddr, u16), request: Request<Full<Bytes>>) -> Result<String> {
    let stream = tokio::net::TcpStream::connect(target).await?;
    let (mut sender, connection) = http1::handshake(TokioIo::new(stream)).await?;
    let response = async {
        let response = sender.send_request(request).await?;
        need(
            response.status().is_success(),
            "Speech recognition HTTP failure",
        )?;
        let body = Limited::new(response.into_body(), 16 * 1024 * 1024)
            .collect()
            .await?
            .to_bytes();
        let result: Value = serde_json::from_slice(&body)?;
        Ok(result["transcript"]
            .as_str()
            .ok_or("Missing recognized transcript")?
            .to_owned())
    };
    // Both futures are owned here. Returning or timing out drops the HTTP
    // connection on this runtime; there is no detached driver or background job.
    tokio::pin!(connection);
    tokio::pin!(response);
    tokio::select! {
        result = &mut response => result,
        result = &mut connection => {
            result?;
            response.await
        }
    }
}
