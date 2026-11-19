use crate::Format;
use bytes::Bytes;

/// Recognize the browser's raw body and the legacy multipart audio field.
pub(super) fn audio(body: Bytes, content_type: &str) -> Option<(Bytes, Format)> {
    let mut parameters = content_type.split(';');
    if parameters
        .next()?
        .trim()
        .eq_ignore_ascii_case("multipart/form-data")
    {
        let boundary = parameters.find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            key.eq_ignore_ascii_case("boundary")
                .then_some(value.trim().trim_matches('"'))
        })?;
        return multipart(body, boundary);
    }
    Some((body, Format::from_content_type(content_type)?))
}

fn multipart(bytes: Bytes, boundary: &str) -> Option<(Bytes, Format)> {
    if !(1..=70).contains(&boundary.len())
        || !boundary
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"'()+_,-./:=?".contains(&b))
    {
        return None;
    }
    let delimiter = format!("--{boundary}");
    let between = format!("\r\n{delimiter}");
    let mut offset = delimiter.len();
    bytes.strip_prefix(delimiter.as_bytes())?;
    for _ in 0..16 {
        let next = bytes.get(offset..)?.strip_prefix(b"\r\n")?;
        let header_end = locate(next.get(..next.len().min(8192))?, b"\r\n\r\n")?;
        let (name, mime) = headers(std::str::from_utf8(&next[..header_end]).ok()?);
        let start = offset + 2 + header_end + 4;
        let end = start + part_end(bytes.get(start..)?, between.as_bytes())?;
        if name {
            return Some((bytes.slice(start..end), Format::from_content_type(mime)?));
        }
        offset = end + between.len();
    }
    None
}

fn headers(block: &str) -> (bool, &str) {
    let mut audio = false;
    let mut mime = "application/octet-stream";
    for line in block.split("\r\n") {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.eq_ignore_ascii_case("content-disposition") {
            audio = value
                .split(';')
                .any(|field| field.trim() == "name=\"audio\"");
        } else if key.eq_ignore_ascii_case("content-type") {
            mime = value.trim();
        }
    }
    (audio, mime)
}

fn part_end(mut bytes: &[u8], delimiter: &[u8]) -> Option<usize> {
    let mut offset = 0;
    loop {
        let index = locate(bytes, delimiter)?;
        let rest = bytes.get(index + delimiter.len()..)?;
        if rest.starts_with(b"\r\n") || rest.starts_with(b"--") {
            return Some(offset + index);
        }
        let consumed = index + delimiter.len();
        offset += consumed;
        bytes = rest;
    }
}

fn locate(bytes: &[u8], pattern: &[u8]) -> Option<usize> {
    bytes
        .windows(pattern.len())
        .position(|window| window == pattern)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_audio_field_without_treating_filename_as_a_path() {
        let request = Bytes::from_static(
            b"--part\r\nContent-Disposition: form-data; name=\"extra\"\r\n\r\nx\r\n--part\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"../../outside.mp4\"\r\nContent-Type: audio/mp4\r\n\r\nclip\r\n--part--\r\n"
        );
        let (body, format) =
            audio(request.clone(), "multipart/form-data; boundary=\"part\"").unwrap();
        assert_eq!(body, "clip");
        assert!(matches!(format, Format::Mp4));
        assert!(audio(request, "multipart/form-data; boundary=wrong").is_none());
    }
}
