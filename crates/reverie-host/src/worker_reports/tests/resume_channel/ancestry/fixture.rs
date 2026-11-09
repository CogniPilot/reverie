use super::*;
use crate::{website_facts::WebsiteFactsError, worker_reports::WorkerActorChannelFailure};
pub(super) type TestResult<T> = std::result::Result<T, String>;
fn cause(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}
pub(super) fn request(stream: &mut UnixStream) -> std::io::Result<()> {
    let bytes = br#"{"purpose":"resource-replacement-v1","version":1}"#;
    let header = WorkerFrameHeader::for_payload(b'Q', bytes.len()).expect("fixed Q payload");
    stream.write_all(&header.encode())?;
    stream.write_all(bytes)
}
pub(super) struct PeerFixture {
    fixture: Fixture,
    service: Arc<WorkerReportService>,
    listener: Option<UnixListener>,
    server: Option<UnixStream>,
    client: Option<UnixStream>,
    child: Option<Child>,
    child_status: Option<ExitStatus>,
    channel: Option<WorkerActorChannel>,
    failure: Option<Box<WorkerActorChannelFailure>>,
    unexpected: Option<AcceptedWorkerServiceConnection>,
    observer: WebsiteProcessObserver,
    uncertain: bool,
}
impl PeerFixture {
    pub(super) fn new() -> Self {
        let fixture = Fixture::new();
        let service = Arc::new(fixture.service());
        Self {
            fixture,
            service,
            listener: None,
            server: None,
            client: None,
            child: None,
            child_status: None,
            channel: None,
            failure: None,
            unexpected: None,
            observer: WebsiteProcessObserver::default(),
            uncertain: false,
        }
    }
    fn listen(&mut self) -> TestResult<PathBuf> {
        let path = self.fixture.root.join("ancestry");
        self.listener = Some(UnixListener::bind(&path).map_err(cause)?);
        self.listener
            .as_ref()
            .expect("owned listener")
            .set_nonblocking(true)
            .map_err(cause)?;
        Ok(path)
    }
    fn accept(&mut self) -> TestResult<()> {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            match self.listener.as_ref().expect("owned listener").accept() {
                Ok((server, _)) => {
                    self.server = Some(server);
                    break;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
                {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => return Err(cause(error)),
            }
        }
        let result = close_listener(self.listener.take().expect("owned listener"));
        self.uncertain |= result.is_err();
        result.map_err(cause)
    }
    fn retain(&mut self) -> TestResult<()> {
        let registered = self
            .service
            .register_worker_connection(self.server.take().expect("owned server"))
            .map_err(cause)?;
        let received = registered
            .receive_service_for_worker(
                &self.fixture.collector,
                &super::super::super::launch::configuration(),
            )
            .map_err(cause)?;
        let connection = match received {
            AcceptedWorkerServiceConnection::Service(connection) => connection,
            other => {
                self.unexpected = Some(other);
                return Err("unexpected fixed Q owner".into());
            }
        };
        match connection.retain_resource_website_channel(&self.fixture.runtime) {
            Ok(channel) => self.channel = Some(channel),
            Err(failure) => {
                let error = cause(failure.cause());
                self.failure = Some(failure);
                return Err(error);
            }
        }
        let channel = self.channel.as_mut().expect("owned channel");
        channel.pin_peer().map_err(cause)?;
        channel.greet(end()).map_err(cause)
    }
    pub(super) fn connect_child(&mut self) -> TestResult<u32> {
        let path = self.listen()?;
        self.child = Some(
            Command::new(std::env::current_exe().map_err(cause)?)
                .args([
                    "--ignored",
                    "--exact",
                    "worker_reports::tests::resume_channel::ancestry::ancestry_child",
                ])
                .env("REVERIE_ANCESTRY_SOCKET", &path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(cause)?,
        );
        self.accept()?;
        self.retain()?;
        Ok(self.child.as_ref().expect("owned child").id())
    }
    pub(super) fn connect_self(&mut self) -> TestResult<()> {
        let path = self.listen()?;
        self.client = Some(UnixStream::connect(path).map_err(cause)?);
        request(self.client.as_mut().expect("owned client")).map_err(cause)?;
        self.accept()?;
        self.retain()
    }
    pub(super) fn spawn_init(&mut self) -> TestResult<u32> {
        self.child = Some(
            Command::new(std::env::current_exe().map_err(cause)?)
                .args([
                    "--ignored",
                    "--exact",
                    "website_facts::process::tests::snapshot_child",
                ])
                .env("REVERIE_WEBSITE_SNAPSHOT_CHILD", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(cause)?,
        );
        Ok(self.child.as_ref().expect("owned child").id())
    }
    pub(super) fn observe(
        &mut self,
        init: u32,
    ) -> TestResult<crate::website_facts::PeerInitSnapshot> {
        let result = self.observer.observe_peer_ancestry(
            self.channel.as_mut().ok_or("missing channel")?,
            &process_test_metadata(init),
            end(),
        );
        self.uncertain |= matches!(&result, Err(WebsiteFactsError::Finalization { .. }))
            || result
                .as_ref()
                .err()
                .is_some_and(|error| error.code() == "BACKEND_CODE_CLOSE_UNCONFIRMED");
        result.map_err(cause)
    }
    pub(super) fn close_channel(&mut self) -> TestResult<()> {
        let result = self
            .channel
            .as_mut()
            .ok_or("missing channel")?
            .close_for_worker();
        self.uncertain |= result.is_err();
        result.map(|_| ()).map_err(cause)
    }
    pub(super) fn finish<T>(mut self, body: TestResult<T>) -> TestResult<T> {
        let mut errors = Vec::new();
        self.cleanup(&mut errors);
        if errors.is_empty() {
            if let Some(status) = self.child_status.filter(|status| !status.success()) {
                return Err(format!(
                    "body={:?}; known owned child exit={status}",
                    body.as_ref().err()
                ));
            }
            return body;
        }
        let primary = body.as_ref().err().cloned();
        std::mem::forget(self);
        Err(format!(
            "body={primary:?}; retained uncertain cleanup={errors:?}"
        ))
    }
    fn cleanup(&mut self, errors: &mut Vec<String>) {
        if self.uncertain {
            errors.push("prior consumed-close uncertainty".into());
        } else if let Some(channel) = self.channel.as_mut() {
            note(channel.close_for_worker().map(|_| ()), errors);
        }
        if let Some(failure) = self.failure.as_mut() {
            note(failure.close_for_worker(), errors);
        }
        for stream in [self.server.take(), self.client.take()]
            .into_iter()
            .flatten()
        {
            note(super::super::super::super::record::close(stream), errors);
        }
        if let Some(listener) = self.listener.take() {
            note(close_listener(listener), errors);
        }
        if let Some(child) = self.child.as_mut() {
            if let Some(stdin) = child.stdin.take() {
                note(
                    crate::native::close(std::fs::File::from(OwnedFd::from(stdin))),
                    errors,
                );
            }
            match finish(child) {
                Ok(status) => self.child_status = Some(status),
                Err(error) => errors.push(cause(error)),
            }
        }
        if self.unexpected.is_some() {
            errors.push("retained unexpected connection owner".into());
        }
        note(self.service.close(end()), errors);
    }
}
fn note<E: std::fmt::Debug>(result: std::result::Result<(), E>, errors: &mut Vec<String>) {
    if let Err(error) = result {
        errors.push(cause(error));
    }
}
