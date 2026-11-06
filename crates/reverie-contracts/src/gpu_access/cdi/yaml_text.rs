//! Preserve Python SafeLoader's escaped surrogate codepoints across a scalar
//! Rust parser. Chosen private-use markers cannot collide with source literals
//! or escapes; literal backslash spellings are restored separately from parsed
//! escapes. No replacement-character normalization is performed.
use super::*;
mod version;
pub(super) struct Restoration {
    values: BTreeMap<u32, (String, u32)>,
}
pub(super) fn input(raw: &[u8]) -> Result<(String, Restoration)> {
    let mut raw = decode(raw)?;
    let mut reserved = raw.chars().map(u32::from).collect::<BTreeSet<_>>();
    let mut spellings = BTreeMap::new();
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if let Some((size, point)) = escape(&bytes[index..]) {
            reserved.insert(point);
            if (0xd800..=0xdfff).contains(&point) {
                spellings.insert(raw[index..index + size].to_owned(), point);
            }
            index += size;
        } else {
            index += 1;
        }
    }
    // Reserve semantic scalar literals too: backslash-newline or hex escapes
    // can assemble a marker spelling which never appeared contiguously in raw
    // input. The same parser runs a grammar-only control with safe ASCII in
    // place of surrogate escapes; no constructor/tag acceptance is inferred.
    loop {
        match reserve_control(&raw, &spellings, &mut reserved) {
            Ok(()) => break,
            Err(ControlError::Grammar(error)) => {
                if !version::correct(&mut raw, &error) {
                    return Err(GpuDataError::CdiDocument);
                }
            }
            Err(ControlError::Directive) => return Err(GpuDataError::CdiDocument),
        }
    }
    let mut next = 0xf0000;
    let mut values = BTreeMap::new();
    let mut replacements = BTreeMap::new();
    for (spelling, point) in spellings {
        while reserved.contains(&next) || matches!(next, 0xffffe | 0xfffff | 0x10fffe | 0x10ffff) {
            next += 1;
        }
        if next > 0x10fffd {
            return Err(GpuDataError::CdiDocument);
        }
        replacements.insert(spelling.clone(), next);
        values.insert(next, (spelling, point));
        next += 1;
    }
    Ok((transform(&raw, &replacements), Restoration { values }))
}
enum ControlError {
    Grammar(libyaml_safer::Error),
    Directive,
}
fn reserve_control(
    raw: &str,
    spellings: &BTreeMap<String, u32>,
    reserved: &mut BTreeSet<u32>,
) -> std::result::Result<(), ControlError> {
    let control = transform(
        raw,
        &spellings.keys().map(|key| (key.clone(), 65)).collect(),
    );
    let mut scanner = libyaml_safer::Scanner::new();
    scanner.set_input(control.as_bytes());
    for token in scanner {
        let token = token.map_err(ControlError::Grammar)?;
        if !version::token_valid(&control, &token) {
            return Err(ControlError::Directive);
        }
    }
    let mut parser = libyaml_safer::Parser::new();
    parser.set_input(control.as_bytes());
    for event in parser {
        if let libyaml_safer::EventData::Scalar { value, .. } =
            event.map_err(ControlError::Grammar)?.data
        {
            reserve(&value, reserved);
        }
    }
    Ok(())
}
fn reserve(raw: &str, reserved: &mut BTreeSet<u32>) {
    reserved.extend(raw.chars().map(u32::from));
    let mut index = 0;
    while index < raw.len() {
        if let Some((size, point)) = escape(&raw.as_bytes()[index..]) {
            reserved.insert(point);
            index += size;
        } else {
            index += 1;
        }
    }
}
fn transform(raw: &str, replacements: &BTreeMap<String, u32>) -> String {
    let mut output = String::new();
    let mut index = 0;
    while index < raw.len() {
        if let Some((size, _)) = escape(&raw.as_bytes()[index..])
            && let Some(marker) = replacements.get(&raw[index..index + size])
        {
            output.push_str(&format!("\\U{marker:08x}"));
            index += size;
        } else {
            let point = raw[index..].chars().next().expect("UTF8 boundary");
            output.push(point);
            index += point.len_utf8();
        }
    }
    output
}
fn decode(raw: &[u8]) -> Result<String> {
    let (raw, little) = if let Some(raw) = raw.strip_prefix(&[0xff, 0xfe]) {
        (raw, Some(true))
    } else if let Some(raw) = raw.strip_prefix(&[0xfe, 0xff]) {
        (raw, Some(false))
    } else {
        (raw, None)
    };
    if let Some(little) = little {
        if !raw.len().is_multiple_of(2) {
            return Err(GpuDataError::CdiDocument);
        }
        let words = raw.chunks_exact(2).map(|word| {
            if little {
                u16::from_le_bytes([word[0], word[1]])
            } else {
                u16::from_be_bytes([word[0], word[1]])
            }
        });
        char::decode_utf16(words)
            .collect::<std::result::Result<String, _>>()
            .map_err(|_| GpuDataError::CdiDocument)
    } else {
        String::from_utf8(raw.to_vec()).map_err(|_| GpuDataError::CdiDocument)
    }
}
fn escape(bytes: &[u8]) -> Option<(usize, u32)> {
    if bytes.first() != Some(&b'\\') {
        return None;
    }
    let digits = match bytes.get(1)? {
        b'u' => 4,
        b'U' => 8,
        _ => return None,
    };
    let value = bytes.get(2..2 + digits)?;
    if !value.iter().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((
        2 + digits,
        u32::from_str_radix(std::str::from_utf8(value).ok()?, 16).ok()?,
    ))
}
impl Restoration {
    pub(super) fn text(&self, value: &str) -> MetadataText {
        let mut points = Vec::new();
        let mut index = 0;
        while index < value.len() {
            if let Some((size, marker)) = escape(&value.as_bytes()[index..])
                && let Some((spelling, _)) = self.values.get(&marker)
            {
                points.extend(spelling.chars().map(u32::from));
                index += size;
            } else {
                let point = value[index..].chars().next().expect("UTF8 boundary");
                points.push(
                    self.values
                        .get(&u32::from(point))
                        .map_or(u32::from(point), |(_, point)| *point),
                );
                index += point.len_utf8();
            }
        }
        MetadataText::from_text(Text(points))
    }
}
