//! Fixed guest Nix diagnostics, independent of child success. At most the last
//! 16,384 four-byte Python characters plus one crossing scalar are retained
//! per stream. Invalid bytes are preserved; truncation is never UTF-8 repair.
const CONTENT: usize = 16_384 * 4;
const WINDOW: usize = CONTENT + 3;

pub(crate) fn append(output: &mut Vec<u8>, incoming: &[u8]) {
    if output.capacity() < WINDOW {
        output.reserve_exact(WINDOW - output.len());
    }
    if incoming.len() >= WINDOW {
        output.clear();
        output.extend_from_slice(&incoming[incoming.len() - WINDOW..]);
        return;
    }
    let discard = (output.len() + incoming.len()).saturating_sub(WINDOW);
    if discard != 0 {
        output.copy_within(discard.., 0);
        output.truncate(output.len() - discard);
    }
    output.extend_from_slice(incoming);
}

pub(crate) fn finish(output: &mut Vec<u8>) {
    let cut = output.len().saturating_sub(CONTENT);
    // Include a valid scalar crossing the cut. A continuation byte with no
    // valid leading scalar remains an original invalid byte, not silently
    // stripped or replaced. The three preceding bytes suffice for UTF-8.
    let start = (cut.saturating_sub(3)..cut)
        .find(|start| crossing_scalar(output, *start, cut))
        .unwrap_or(cut);
    output.drain(..start);
}

fn crossing_scalar(bytes: &[u8], start: usize, cut: usize) -> bool {
    let width = match bytes[start] {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return false,
    };
    start + width > cut
        && bytes
            .get(start..start + width)
            .is_some_and(|scalar| std::str::from_utf8(scalar).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_chunks_keep_a_bounded_exact_raw_suffix() {
        let mut output = Vec::new();
        let source = (0..3_000_001).map(|i| (i % 256) as u8).collect::<Vec<_>>();
        for (index, chunk) in source.chunks(997).enumerate() {
            append(&mut output, chunk);
            assert!(output.len() <= WINDOW);
            let end = ((index + 1) * 997).min(source.len());
            assert_eq!(output, source[end - output.len()..end]);
        }
        finish(&mut output);
        assert_eq!(output, source[source.len() - CONTENT..]);
    }

    #[test]
    fn each_valid_multibyte_crossing_is_retained_and_invalid_bytes_are_not_repaired() {
        for scalar in ["a", "é", "€", "𐀀"] {
            for boundary in 0..scalar.len() {
                assert_scalar(scalar, boundary);
            }
        }
        let mut invalid = vec![255; WINDOW];
        finish(&mut invalid);
        assert_eq!(invalid, vec![255; CONTENT]);
    }
    fn assert_scalar(scalar: &str, boundary: usize) {
        let mut source = vec![b'x'; WINDOW];
        source.extend_from_slice(scalar.as_bytes());
        source.extend(std::iter::repeat_n(b'y', CONTENT - boundary));
        let mut output = Vec::new();
        for chunk in source.chunks(11) {
            append(&mut output, chunk);
        }
        finish(&mut output);
        assert!(output.len() <= WINDOW);
        assert!(std::str::from_utf8(&output).is_ok());
        assert!(source.ends_with(&output));
    }
}
