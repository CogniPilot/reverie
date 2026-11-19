//! Explicit real TLS/CONNECT qualification with a task-owned synthetic CA.
use reverie_core::memory::EmbeddingKind;
use reverie_host::embeddings::{LlamaConfig, LlamaEmbedder};
use std::{
    ffi::OsString,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::Command,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Direct,
    Connect,
    HttpsProxyConnect,
    Forward,
    Nested,
    Untrusted,
    UnicodeOrigin,
    UnicodeConnect,
    UnknownSchemeConnect,
    UnicodeForward,
    UnicodeNested,
}
impl Mode {
    fn tunnels(self) -> bool {
        matches!(
            self,
            Self::Connect
                | Self::HttpsProxyConnect
                | Self::Nested
                | Self::UnicodeConnect
                | Self::UnknownSchemeConnect
                | Self::UnicodeNested
        )
    }
    fn forwards(self) -> bool {
        matches!(
            self,
            Self::Forward | Self::Nested | Self::UnicodeForward | Self::UnicodeNested
        )
    }
    fn nested(self) -> bool {
        matches!(self, Self::Nested | Self::UnicodeNested)
    }
    fn unicode_proxy(self) -> bool {
        matches!(
            self,
            Self::UnicodeConnect | Self::UnicodeForward | Self::UnicodeNested
        )
    }
    fn endpoint(self, address: SocketAddr) -> String {
        if self.forwards() {
            "http://synthetic.invalid".into()
        } else if self == Self::UnicodeOrigin {
            format!("https://lo\u{ad}calhost:{}", address.port())
        } else {
            format!("https://localhost:{}", address.port())
        }
    }
    fn proxy(self, address: SocketAddr) -> Option<String> {
        let host = if self.unicode_proxy() {
            "ｌｏｃａｌｈｏｓｔ".to_owned()
        } else {
            address.ip().to_string()
        };
        if self.nested() {
            return Some(format!("https://first:password@{host}:9"));
        }
        let scheme = match self {
            Self::Connect | Self::UnicodeConnect => "http",
            Self::HttpsProxyConnect | Self::Forward | Self::UnicodeForward => "https",
            Self::UnknownSchemeConnect => "socks5",
            _ => return None,
        };
        Some(format!(
            "{scheme}://synthetic:password@{host}:{}",
            address.port()
        ))
    }
    fn configure(self, command: &mut Command, address: SocketAddr) {
        if matches!(self, Self::Forward | Self::UnicodeForward) {
            command.env_remove("https_proxy");
        }
        if self.nested() {
            let host = if self.unicode_proxy() {
                "ｌｏｃａｌｈｏｓｔ".to_owned()
            } else {
                address.ip().to_string()
            };
            command.env(
                "https_proxy",
                format!("http://synthetic:password@{host}:{}", address.port()),
            );
        }
    }
}
fn request(stream: &mut impl Read) -> std::io::Result<String> {
    let mut raw = Vec::new();
    let mut byte = [0];
    while !raw.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte)?;
        raw.push(byte[0]);
        if raw.len() > 65536 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
    }
    let headers = raw.iter().map(|&byte| char::from(byte)).collect::<String>();
    let length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .map_or(0, |(_, value)| value.trim().parse().unwrap());
    let mut body = vec![0; length];
    stream.read_exact(&mut body)?;
    Ok(headers)
}
fn accept(listener: &TcpListener) -> TcpStream {
    let start = Instant::now();
    loop {
        match listener.accept() {
            Ok((socket, _)) => return socket,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    start.elapsed() < Duration::from_secs(5),
                    "TLS fixture expected connection"
                );
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("{error}"),
        }
    }
}
fn configured_command(
    executable: impl AsRef<std::ffi::OsStr>,
    ca: &std::ffi::OsStr,
    endpoint: &str,
    proxy: Option<&str>,
) -> Command {
    let mut command = Command::new(executable);
    command
        .env_clear()
        .env("SSL_CERT_FILE", ca)
        .env(
            "SSL_CERT_DIR",
            std::env::var_os("REVERIE_TEST_TLS_EMPTY_DIR").unwrap(),
        )
        .env("REVERIE_TEST_TLS_ENDPOINT", endpoint);
    if let Some(proxy) = proxy {
        command.env("https_proxy", proxy).env("http_proxy", proxy);
    }
    command
}
#[test]
#[ignore = "qualification helper: requires isolated parent-supplied TLS endpoint/CA"]
fn embedding_tls_child() {
    let endpoint = std::env::var("REVERIE_TEST_TLS_ENDPOINT").unwrap();
    let model = LlamaEmbedder::new(LlamaConfig::new(endpoint, "model"));
    let result = model.request_embedding("TLS qualification", EmbeddingKind::Document);
    if std::env::var_os("REVERIE_TEST_TLS_REFUSE").is_some() {
        assert!(result.is_err());
    } else {
        assert_eq!(result.unwrap(), [0.6, 0.8]);
    }
}
struct Qualification {
    config: Arc<rustls::ServerConfig>,
    ca: OsString,
}
impl Qualification {
    fn load() -> Self {
        let cert = fs::read(std::env::var_os("REVERIE_TEST_TLS_CERT_DER").unwrap()).unwrap();
        let key = fs::read(std::env::var_os("REVERIE_TEST_TLS_KEY_DER").unwrap()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![rustls::pki_types::CertificateDer::from(cert)],
            rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(
                key,
            )),
        )
        .unwrap();
        Self {
            config: Arc::new(config),
            ca: std::env::var_os("REVERIE_TEST_TLS_CA_PEM").unwrap(),
        }
    }
    fn client(&self, mode: Mode, address: SocketAddr) {
        let endpoint = mode.endpoint(address);
        let proxy = mode.proxy(address);
        let trust = if mode == Mode::Untrusted {
            std::env::var_os("REVERIE_TEST_TLS_EMPTY_FILE").unwrap()
        } else {
            self.ca.clone()
        };
        let executable = std::env::current_exe().unwrap().into_os_string();
        let mut command = configured_command(executable, &trust, &endpoint, proxy.as_deref());
        mode.configure(&mut command, address);
        command.args(["--ignored", "--exact", "embedding_tls_child", "--nocapture"]);
        if mode == Mode::Untrusted {
            command.env("REVERIE_TEST_TLS_REFUSE", "1");
        }
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "mode={mode:?}: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
    fn run(&self, mode: Mode) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let config = Arc::clone(&self.config);
        let server = thread::spawn(move || serve(&listener, &config, mode));
        self.client(mode, address);
        verify(mode, address, server.join().unwrap());
    }
}
fn serve(
    listener: &TcpListener,
    config: &Arc<rustls::ServerConfig>,
    mode: Mode,
) -> (Option<String>, Option<String>) {
    let mut socket = accept(listener);
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let connect = if mode.tunnels() {
        let header = request(&mut socket).unwrap();
        socket
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .unwrap();
        Some(header)
    } else {
        None
    };
    let mut stream = rustls::StreamOwned::new(
        rustls::ServerConnection::new(Arc::clone(config)).unwrap(),
        socket,
    );
    let header = request(&mut stream);
    if mode == Mode::Untrusted {
        assert!(header.is_err());
        return (connect, None);
    }
    let header = header.unwrap();
    let body = br#"{"data":[{"embedding":[3,4]}]}"#;
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(body).unwrap();
    stream.flush().unwrap();
    (connect, Some(header))
}
fn verify(mode: Mode, address: SocketAddr, (connect, inner): (Option<String>, Option<String>)) {
    if mode.tunnels() {
        let connect = connect.unwrap().to_ascii_lowercase();
        let authority = if mode.nested() {
            if mode.unicode_proxy() {
                "localhost:9".to_owned()
            } else {
                "127.0.0.1:9".to_owned()
            }
        } else {
            format!("localhost:{}", address.port())
        };
        assert!(connect.starts_with(&format!("connect {authority} http/1.1")));
        assert!(connect.contains("proxy-authorization: basic c3ludghldgljonbhc3n3b3jk"));
    }
    let Some(header) = inner else {
        return;
    };
    let header = header.to_ascii_lowercase();
    let first = if mode.forwards() {
        "post http://synthetic.invalid/embeddings http/1.1"
    } else {
        "post /embeddings http/1.1"
    };
    assert!(header.starts_with(first));
    assert_eq!(
        header.contains("proxy-authorization:"),
        matches!(mode, Mode::Forward | Mode::UnicodeForward)
    );
    if mode == Mode::UnicodeOrigin {
        assert!(header.contains(&format!("host: lo\u{ad}calhost:{}", address.port())));
    }
}
#[test]
#[ignore = "requires task-owned CA/cert/key; local servers only"]
fn qualifies_tls_connect_proxy_and_untrusted_refusal() {
    let qualification = Qualification::load();
    for mode in [
        Mode::Direct,
        Mode::Connect,
        Mode::HttpsProxyConnect,
        Mode::Forward,
        Mode::Nested,
        Mode::Untrusted,
        Mode::UnicodeOrigin,
        Mode::UnicodeConnect,
        Mode::UnknownSchemeConnect,
        Mode::UnicodeForward,
        Mode::UnicodeNested,
    ] {
        qualification.run(mode);
    }
}
