//! `JSON.stringify` of the route's reply objects, in their construction order: schema keys, then `modes`.
use super::{MAX_RESPONSE_BYTES, Modes, Profile, Refusal, Response};
use std::fmt::Write;

const INVALID_FILE: &str = r#"{"success":false,"error":"Subscription profile file is invalid; it has not been changed","errorCode":"OPERATION_FAILED"}"#;

/// The route's error-handler reply when the file cannot be read or parsed.
pub fn invalid_file() -> Response {
    Response {
        status: 500,
        body: INVALID_FILE.as_bytes().to_vec(),
    }
}

/// `{ success: true, data: { profiles: profiles.map((p) => ({ ...p, modes })) } }`.
pub fn profiles_response(profiles: &[Profile], modes: &Modes) -> Result<Response, Refusal> {
    const CLOSE: &str = "]}}";
    let mut body = String::from(r#"{"success":true,"data":{"profiles":["#);
    for (index, profile) in profiles.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str(r#"{"id":"#);
        quote(&mut body, profile.id.units());
        body.push_str(r#","label":"#);
        quote(&mut body, profile.label.units());
        body.push_str(r#","provider":""#);
        body.push_str(profile.provider.as_str());
        body.push_str(r#"","configDir":"#);
        quote(&mut body, profile.config_dir.units());
        body.push_str(r#","openCodeDataDir":"#);
        quote(&mut body, profile.open_code_data_dir.units());
        body.push_str(r#","modes":["#);
        for (position, mode) in modes.of(profile.provider).iter().enumerate() {
            if position > 0 {
                body.push(',');
            }
            quote(&mut body, &mode.encode_utf16().collect::<Vec<_>>());
        }
        body.push_str("]}");
        // The body only grows, so stop as soon as the finished reply could no longer fit.
        if body.len() + CLOSE.len() > MAX_RESPONSE_BYTES {
            return Err(Refusal::ResponseBound);
        }
    }
    body.push_str(CLOSE);
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(Refusal::ResponseBound);
    }
    Ok(Response {
        status: 200,
        body: body.into_bytes(),
    })
}

/// ECMAScript QuoteJSONString: short escapes, other C0 and lone surrogates as lowercase `\uXXXX`.
fn quote(output: &mut String, units: &[u16]) {
    output.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => output.push_str("\\\""),
            Ok('\\') => output.push_str("\\\\"),
            Ok('\u{8}') => output.push_str("\\b"),
            Ok('\u{c}') => output.push_str("\\f"),
            Ok('\n') => output.push_str("\\n"),
            Ok('\r') => output.push_str("\\r"),
            Ok('\t') => output.push_str("\\t"),
            Ok(control) if control < ' ' => push_escape(output, control as u16),
            Ok(character) => output.push(character),
            Err(lone) => push_escape(output, lone.unpaired_surrogate()),
        }
    }
    output.push('"');
}
fn push_escape(output: &mut String, unit: u16) {
    // Writing to a String cannot fail.
    let _ = write!(output, "\\u{unit:04x}");
}
