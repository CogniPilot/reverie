//! Synthetic upstream for the real HTTPS preview browser test.
use crate::{
    Lookup, Target,
    responses::{Reply, json, status_reply},
    server::bind_listeners,
    shutdown,
};
use bytes::Bytes;
use http::{Request, StatusCode, header};
use hyper::{body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use std::{
    collections::BTreeMap,
    convert::Infallible,
    future::Future,
    io::{self, Write},
    net::Ipv4Addr,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, task::JoinHandle};

struct FixtureLookup;
impl Lookup for FixtureLookup {
    fn resolve<'a>(
        &'a self,
        _session: &'a str,
    ) -> Pin<Box<dyn Future<Output = io::Result<Target>> + Send + 'a>> {
        Box::pin(async {
            Ok(Target {
                container: "fixture-container".into(),
                network: "fixture-network".into(),
                address: Ipv4Addr::LOCALHOST,
            })
        })
    }
}

pub async fn run(task: &Path) -> io::Result<()> {
    let config = serde_json::from_value(serde_json::json!({
        "version":1, "domain":"preview.test", "officeOrigin":"https://office.test",
        "deployment":"fixture", "listenAddress":"127.0.0.1", "port":0,
        "auditFile":task.join("audit.jsonl"), "certificate":task.join("cert.pem"),
        "privateKey":task.join("key.pem"), "controlSocket":task.join("preview.sock"),
    }))?;
    let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = upstream.local_addr()?.port();
    let server = bind_listeners(config, Arc::new(FixtureLookup)).await?;
    let upstream = Serving(tokio::spawn(pages(upstream)));
    println!(
        "{}",
        serde_json::json!({"ready": true, "upstreamPort": port})
    );
    io::stdout().flush()?;
    server.run(shutdown()).await?;
    drop(upstream);
    Ok(())
}

type Headers = Vec<BTreeMap<String, String>>;

async fn pages(upstream: TcpListener) {
    let seen = Arc::new(Mutex::new(Headers::new()));
    while let Ok((socket, _)) = upstream.accept().await {
        let seen = seen.clone();
        tokio::spawn(async move {
            let _ = http1::Builder::new()
                .keep_alive(false)
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(|request| async { Ok::<_, Infallible>(page(request, &seen)) }),
                )
                .await;
        });
    }
}

fn page(request: Request<Incoming>, seen: &Mutex<Headers>) -> Reply {
    let mut seen = seen.lock().expect("fixture capture mutex");
    seen.push(
        request
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_owned()))
            })
            .collect(),
    );
    let (content, mime): (&[u8], _) = match request.uri().path() {
        "/seen" => return json(StatusCode::OK, &*seen),
        "/app.js" => (b"document.getElementById('app').textContent = 'Agent page ready';", "application/javascript"),
        "/module.wasm" => (b"\0asm\x01\0\0\0", "application/wasm"),
        _ => (b"<!doctype html><title>Agent preview</title><p id=\"app\"></p><script src=\"/app.js\"></script>", "text/html"),
    };
    let mut reply = status_reply(StatusCode::OK);
    *reply.body_mut() = crate::responses::payload(Bytes::from_static(content));
    reply
        .headers_mut()
        .insert(header::CONTENT_TYPE, header::HeaderValue::from_static(mime));
    reply
}

struct Serving(JoinHandle<()>);
impl Drop for Serving {
    fn drop(&mut self) {
        self.0.abort();
    }
}
