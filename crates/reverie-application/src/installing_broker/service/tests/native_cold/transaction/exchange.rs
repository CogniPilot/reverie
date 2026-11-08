use super::*;
#[derive(Default)]
pub(super) struct Frames {
    count: usize,
    pending: Vec<u8>,
    pub output: Vec<u8>,
    pub replies: Vec<Vec<u8>>,
    pub errors: Vec<Vec<u8>>,
    pub exit: Option<Vec<u8>>,
    pub eof: bool,
}
pub(super) fn connect(path: &Path, kind: u8, raw: &[u8]) -> Result<UnixStream> {
    let mut socket = UnixStream::connect(path).map_err(|e| e.to_string())?;
    socket
        .write_all(
            &WorkerFrameHeader::for_payload(kind, raw.len())
                .ok_or("fixed frame bound")?
                .encode(),
        )
        .and_then(|()| socket.write_all(raw))
        .map_err(|e| e.to_string())?;
    socket.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(socket)
}
impl Frames {
    pub(super) fn read(&mut self, socket: &mut UnixStream) -> Result<()> {
        let mut raw = [0; 4096];
        loop {
            match socket.read(&mut raw) {
                Ok(0) => {
                    self.eof = true;
                    break;
                }
                Ok(n) => {
                    require(
                        self.pending.len() + n <= 1_048_576,
                        "bounded actual worker frames",
                    )?;
                    self.pending.extend_from_slice(&raw[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        while self.pending.len() >= HEADER_BYTES {
            let mut raw = [0; HEADER_BYTES];
            raw.copy_from_slice(&self.pending[..HEADER_BYTES]);
            let header = WorkerFrameHeader::decode(raw);
            let length = header.payload_length() as usize;
            require(length <= 1_048_576, "bounded declared worker frame")?;
            if self.pending.len() < HEADER_BYTES + length {
                break;
            }
            let body = self.pending[HEADER_BYTES..HEADER_BYTES + length].to_vec();
            self.pending.drain(..HEADER_BYTES + length);
            self.count += 1;
            require(self.count <= 65536, "bounded actual frame count")?;
            let total = self.output.len()
                + self.replies.iter().map(Vec::len).sum::<usize>()
                + self.errors.iter().map(Vec::len).sum::<usize>()
                + body.len();
            require(total <= 1_048_576, "bounded complete worker response")?;
            match header.kind() {
                b'O' => self.output.extend_from_slice(&body),
                b'J' => self.replies.push(body),
                b'E' => self.errors.push(body),
                b'X' => {
                    require(self.exit.is_none(), "one actual exit frame")?;
                    self.exit = Some(body);
                }
                _ => return Err("unexpected actual worker frame kind".into()),
            }
        }
        require(
            !self.eof || self.pending.is_empty(),
            "EOF cannot truncate a worker frame",
        )
    }
}
impl Attempt {
    pub(super) fn until(&mut self, frames: &mut Frames, started: bool) -> Result<()> {
        loop {
            require(Instant::now() < self.end, "original actual Cold-J deadline")?;
            self.service
                .as_ref()
                .expect("actual service")
                .poll_handler()
                .map_err(|e| e.to_string())?;
            frames.read(self.client.as_mut().expect("original J client"))?;
            if started
                && frames
                    .output
                    .windows(b"native-cold-canary-started".len())
                    .any(|v| v == b"native-cold-canary-started")
            {
                return Ok(());
            }
            if frames.eof {
                self.joined()?;
                return require(!started, "native child start marker must precede EOF");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub(super) fn joined(&self) -> Result<()> {
        loop {
            match self
                .broker()
                .reports
                .collect_worker_handlers()
                .map_err(|e| e.to_string())?
            {
                reverie_host::worker_reports::WorkerHandlersProgress::Settled => return Ok(()),
                reverie_host::worker_reports::WorkerHandlersProgress::Pending => {
                    require(
                        Instant::now() < self.end,
                        "original HandlerJob join deadline",
                    )?;
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }
}
