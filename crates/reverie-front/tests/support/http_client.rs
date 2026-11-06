//! Maintained HTTP decoding for actual TLS and chunked-body qualifications.
use crate::support::Running;
use http_body_util::{BodyExt, Empty};
use hyper::{
    Request,
    body::{Bytes, Incoming},
    client::conn::http1,
};
use hyper_util::rt::TokioIo;
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, ServerName, pem::PemObject},
};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    task::JoinHandle,
};
use tokio_rustls::TlsConnector;

trait Wire: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Wire for T {}

pub(crate) struct Response {
    body: Incoming,
    driver: Driver,
}
struct Driver(JoinHandle<Result<(), hyper::Error>>);
impl Drop for Driver {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Response {
    pub(crate) async fn get(running: &Running, target: &str, certificate: Option<&Path>) -> Self {
        let raw = TcpStream::connect(("127.0.0.1", running.port))
            .await
            .unwrap();
        let stream: Box<dyn Wire> = if let Some(certificate) = certificate {
            let mut roots = RootCertStore::empty();
            let pem = std::fs::read(certificate).unwrap();
            for cert in CertificateDer::pem_slice_iter(&pem) {
                roots.add(cert.unwrap()).unwrap();
            }
            let mut config = ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            let tls = TlsConnector::from(Arc::new(config));
            Box::new(
                tokio::time::timeout(
                    Duration::from_secs(10),
                    tls.connect(ServerName::try_from("localhost").unwrap(), raw),
                )
                .await
                .unwrap()
                .unwrap(),
            )
        } else {
            Box::new(raw)
        };
        let (mut sender, connection) = http1::handshake(TokioIo::new(stream)).await.unwrap();
        let driver = Driver(tokio::spawn(connection));
        let request = Request::builder()
            .uri(target)
            .header("Host", "localhost")
            .header("Connection", "close")
            .body(Empty::<Bytes>::new())
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), sender.send_request(request))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status(), hyper::StatusCode::OK);
        Self {
            body: result.into_body(),
            driver,
        }
    }
    pub(crate) async fn next(&mut self) -> Option<Bytes> {
        self.next_result()
            .await
            .map(|chunk| chunk.expect("complete HTTP response framing"))
    }
    pub(crate) async fn next_result(&mut self) -> Option<Result<Bytes, hyper::Error>> {
        loop {
            let frame = match self.body.frame().await? {
                Ok(frame) => frame,
                Err(error) => return Some(Err(error)),
            };
            if let Ok(data) = frame.into_data() {
                return Some(Ok(data));
            }
        }
    }
    pub(crate) async fn settled(&mut self) {
        self.settled_result().await.unwrap();
    }
    pub(crate) async fn settled_result(&mut self) -> Result<(), hyper::Error> {
        tokio::time::timeout(Duration::from_secs(10), &mut self.driver.0)
            .await
            .unwrap()
            .unwrap()
    }
}

pub(crate) fn append(received: &mut Vec<u8>, data: &[u8], bound: usize) {
    assert!(
        received
            .len()
            .checked_add(data.len())
            .is_some_and(|size| size <= bound),
        "decoded response bound"
    );
    received.extend_from_slice(data);
}
pub(crate) fn finished(event: &serde_json::Value, target: &str) -> bool {
    event["event"] == "response_finish"
        && event["url"] == target
        && event["socketDestroyed"] == false
}
