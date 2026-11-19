use super::delta::{Assembly, Display};
use reverie_host::embeddings::model_api::Failure;
use serde_json::Value;

pub(super) struct Stream {
    wire_bytes: usize,
    wire_limit: usize,
    line_limit: usize,
    line: Vec<u8>,
    event: Vec<u8>,
    has_data: bool,
    done: bool,
    assembly: Assembly,
}

impl Stream {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            wire_bytes: 0,
            wire_limit: limit.saturating_mul(32).min(8 * 1024 * 1024),
            line_limit: limit.saturating_add(4096),
            line: Vec::new(),
            event: Vec::new(),
            has_data: false,
            done: false,
            assembly: Assembly::new(limit),
        }
    }

    pub(super) fn feed(
        &mut self,
        bytes: &[u8],
        display: &mut impl Display,
    ) -> Result<bool, Failure> {
        for part in bytes.split_inclusive(|&byte| byte == b'\n') {
            self.wire_bytes = checked_count(self.wire_bytes, part.len(), self.wire_limit)?;
            checked_count(self.line.len(), part.len(), self.line_limit)?;
            self.line.extend_from_slice(part);
            if part.last() == Some(&b'\n') {
                self.line(display)?;
            }
            if self.done {
                break;
            }
        }
        Ok(self.done)
    }

    fn line(&mut self, display: &mut impl Display) -> Result<(), Failure> {
        if matches!(self.line.as_slice(), b"\n" | b"\r\n") {
            self.dispatch(display)?;
        } else if let Some(data) = self.line.strip_prefix(b"data:") {
            let data = trim(data);
            let separator = usize::from(self.has_data);
            checked_count(self.event.len(), data.len() + separator, self.line_limit)?;
            if self.has_data {
                self.event.push(b'\n');
            }
            self.event.extend_from_slice(data);
            self.has_data = true;
        }
        self.line.clear();
        Ok(())
    }

    fn dispatch(&mut self, display: &mut impl Display) -> Result<(), Failure> {
        if self.has_data {
            if trim(&self.event) == b"[DONE]" {
                self.done = true;
            } else {
                let data = serde_json::from_slice(&self.event).map_err(|_| Failure::Invalid)?;
                self.assembly.consume(data, display)?;
            }
        }
        self.event.clear();
        self.has_data = false;
        Ok(())
    }

    pub(super) fn finish(mut self, display: &mut impl Display) -> Result<Value, Failure> {
        if !self.done {
            self.line(display)?;
            self.dispatch(display)?;
        }
        if !self.done {
            return Err(Failure::Invalid);
        }
        self.assembly.finish()
    }
}

pub(super) fn checked_count(used: usize, add: usize, limit: usize) -> Result<usize, Failure> {
    used.checked_add(add)
        .filter(|&count| count <= limit)
        .ok_or(Failure::Invalid)
}

fn trim(data: &[u8]) -> &[u8] {
    let space = |byte: &u8| byte.is_ascii_whitespace() || *byte == b'\x0b';
    let start = data
        .iter()
        .position(|byte| !space(byte))
        .unwrap_or(data.len());
    let end = data
        .iter()
        .rposition(|byte| !space(byte))
        .map_or(start, |end| end + 1);
    &data[start..end]
}
