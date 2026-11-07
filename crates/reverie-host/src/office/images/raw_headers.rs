//! Observe original header occurrences/whitespace before Hyper normalizes its
//! HeaderMap. Hyper still owns parsing, framing, status and body decoding.
use super::{Result, need};
use std::{collections::BTreeMap, io};
#[derive(Default)]
pub(super) struct Headers {
    line: Vec<u8>,
    fields: BTreeMap<Vec<u8>, Vec<Vec<u8>>>,
    previous: Option<Vec<u8>>,
    status: bool,
    count: usize,
    continuing: bool,
    complete: bool,
}
impl Headers {
    pub(super) fn observe(&mut self, bytes: &[u8]) -> io::Result<()> {
        for &byte in bytes {
            if self.complete {
                break;
            }
            self.line.push(byte);
            if self.line.len() > 65536 {
                return Err(io::Error::other("image header line bound"));
            }
            if byte == b'\n' {
                self.finish_line()?;
            }
        }
        Ok(())
    }
    fn finish_line(&mut self) -> io::Result<()> {
        let line = std::mem::take(&mut self.line);
        if !self.status {
            self.continuing = line.split(|&byte| byte == b' ').nth(1) == Some(b"100".as_slice());
            self.status = true;
            return Ok(());
        }
        self.count += 1;
        if self.count > 100 {
            return Err(io::Error::other("image header count bound"));
        }
        if line == b"\r\n" || line == b"\n" {
            if self.continuing {
                *self = Self::default();
            } else {
                self.complete = true;
            }
            return Ok(());
        }
        let line = line.strip_suffix(b"\n").unwrap_or(&line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.starts_with(b" ") || line.starts_with(b"\t") {
            if let Some(previous) = &self.previous {
                let value = self
                    .fields
                    .get_mut(previous)
                    .and_then(|values| values.last_mut())
                    .expect("previous header");
                value.extend_from_slice(b"\r\n");
                value.extend_from_slice(line);
            }
        } else if let Some(colon) = line.iter().position(|&byte| byte == b':') {
            let key = line[..colon].to_ascii_lowercase();
            let raw = &line[colon + 1..];
            let start = raw
                .iter()
                .position(|byte| !matches!(byte, b' ' | b'\t'))
                .unwrap_or(raw.len());
            let value = raw[start..].to_vec();
            self.fields.entry(key.clone()).or_default().push(value);
            self.previous = Some(key);
        }
        Ok(())
    }
    fn values(&self, name: &[u8]) -> &[Vec<u8>] {
        self.fields.get(name).map_or(&[], Vec::as_slice)
    }
    pub(super) fn expected(&self, maximum: usize) -> Result<usize> {
        let lengths = self.values(b"content-length");
        need(
            self.complete
                && lengths.len() == 1
                && !lengths[0].is_empty()
                && lengths[0].iter().all(u8::is_ascii_digit)
                && !self.fields.contains_key(b"transfer-encoding".as_slice()),
            "access_or_body_refused",
        )?;
        let encoding = self.values(b"content-encoding");
        need(
            encoding.is_empty() || encoding == [b"identity"],
            "access_or_body_refused",
        )?;
        let size = lengths[0].iter().try_fold(0usize, |size, digit| {
            size.checked_mul(10)?.checked_add(usize::from(digit - b'0'))
        });
        let size = size.ok_or(super::OfficeImageError::Refused("access_or_body_refused"))?;
        need(size <= maximum, "access_or_body_refused")?;
        Ok(size)
    }
    pub(super) fn content_types(&self) -> Vec<Vec<u8>> {
        self.values(b"content-type").to_vec()
    }
}
