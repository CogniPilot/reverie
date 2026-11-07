//! The original terminal frame and tmux client-row grammars. These values are
//! untrusted DATA; client PIDs never select a host signal target.
use crate::legacy_json::{self, Node, Number, Value};
use reverie_core::worker_launch::TerminalSize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalFrameError {
    Json,
    UnpackCount(usize),
    NotIterable,
    Resize,
    Kind,
}
impl std::fmt::Display for TerminalFrameError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnpackCount(n) if *n < 2 => {
                write!(out, "not enough values to unpack (expected 2, got {n})")
            }
            Self::UnpackCount(_) => out.write_str("too many values to unpack (expected 2)"),
            Self::Resize => out.write_str("Invalid resize"),
            Self::Kind => out.write_str("Invalid terminal frame"),
            // Detailed CPython JSON diagnostics remain the shared decoder's
            // existing open compatibility obligation; no second parser here.
            Self::Json | Self::NotIterable => out.write_str("Worker transport failed"),
        }
    }
}
impl std::error::Error for TerminalFrameError {}
pub enum TerminalFrame<'a> {
    Input(&'a [u8]),
    Resize(TerminalSize),
}
pub fn decode_terminal_frame(
    kind: u8,
    payload: &[u8],
) -> Result<TerminalFrame<'_>, TerminalFrameError> {
    match kind {
        b'I' => Ok(TerminalFrame::Input(payload)),
        b'R' => resize(payload).map(TerminalFrame::Resize),
        _ => Err(TerminalFrameError::Kind),
    }
}
fn resize(payload: &[u8]) -> Result<TerminalSize, TerminalFrameError> {
    let value =
        legacy_json::decode_worker_terminal_bytes(payload).map_err(|_| TerminalFrameError::Json)?;
    let count = match &value.0 {
        Node::Array(values) => values.len(),
        Node::Object(values) => values.len(),
        Node::String(value) => value.0.len(),
        _ => return Err(TerminalFrameError::NotIterable),
    };
    if count != 2 {
        return Err(TerminalFrameError::UnpackCount(count));
    }
    let Node::Array(values) = &value.0 else {
        return Err(TerminalFrameError::Resize);
    };
    TerminalSize::try_new(dimension(&values[0])?, dimension(&values[1])?)
        .map_err(|_| TerminalFrameError::Resize)
}
fn dimension(value: &Value) -> Result<u16, TerminalFrameError> {
    let Node::Number(Number::Integer(value)) = &value.0 else {
        return Err(TerminalFrameError::Resize);
    };
    value.parse().map_err(|_| TerminalFrameError::Resize)
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ViewerClient {
    pid: u64,
    cols: u16,
    rows: u16,
}
impl ViewerClient {
    pub fn guest_process_id(&self) -> u64 {
        self.pid
    }
    pub fn dimensions(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }
}
/// Every row must match the original ASCII fullmatch. In particular a bad
/// row invalidates the whole observation, and an empty inventory is valid.
pub fn viewer_clients(text: &str) -> Option<Vec<ViewerClient>> {
    reverie_core::python_split_lines(text)
        .map(|line| {
            let mut fields = line.split(' ');
            let pid = positive(fields.next()?, 10)?;
            let cols = positive(fields.next()?, 4)?.try_into().ok()?;
            let rows = positive(fields.next()?, 4)?.try_into().ok()?;
            if fields.next().is_some() {
                return None;
            }
            Some(ViewerClient { pid, cols, rows })
        })
        .collect()
}
fn positive(text: &str, maximum: usize) -> Option<u64> {
    if text.is_empty()
        || text.len() > maximum
        || !matches!(text.as_bytes()[0], b'1'..=b'9')
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    text.parse().ok()
}
