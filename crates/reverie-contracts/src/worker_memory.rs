//! Existing identity-only soft-limit helper protocol. Values are DATA only.
use crate::legacy_json::{self, Node, Number, Text, Value};
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, ProfileSessionId},
};

pub const HELPER_FRAME_MAX: usize = 512;
#[derive(Debug, Eq, PartialEq)]
pub enum HelperReply {
    Confirmed,
    Refused(String),
    EffectUnconfirmed,
}
pub fn helper_request(session: &ProfileSessionId, container: &ContainerId) -> Vec<u8> {
    format!(
        "{{\"v\":1,\"sessionId\":\"{session}\",\"containerId\":\"{}\"}}\n",
        container.as_str()
    )
    .into_bytes()
}
pub fn helper_reply(raw: &[u8], expected: &UnsignedInteger) -> HelperReply {
    if raw.is_empty()
        || raw.len() > HELPER_FRAME_MAX
        || raw.last() != Some(&b'\n')
        || raw.iter().filter(|byte| **byte == b'\n').count() != 1
    {
        return HelperReply::EffectUnconfirmed;
    }
    let Ok(value) = legacy_json::decode_soft_limit_reply(&raw[..raw.len() - 1]) else {
        return HelperReply::EffectUnconfirmed;
    };
    let Node::Object(fields) = &value.0 else {
        return HelperReply::EffectUnconfirmed;
    };
    let key = |name: &str| Text(name.chars().map(u32::from).collect());
    if fields.len() != 2 {
        return HelperReply::EffectUnconfirmed;
    }
    match fields.get(&key("ok")) {
        Some(Value(Node::Bool(true))) => {
            if matches!(fields.get(&key("memoryHighBytes")), Some(Value(Node::Number(Number::Integer(bytes)))) if bytes == expected.as_str())
            {
                return HelperReply::Confirmed;
            }
        }
        Some(Value(Node::Bool(false))) => {
            if let Some(Value(Node::String(code))) = fields.get(&key("code")) {
                let code: Option<String> = code.0.iter().map(|&c| char::from_u32(c)).collect();
                if let Some(code) = code.filter(|code| {
                    !code.is_empty()
                        && code.len() <= 40
                        && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
                        && code != "EFFECT_UNCONFIRMED"
                }) {
                    return HelperReply::Refused(code);
                }
            }
        }
        _ => {}
    }
    HelperReply::EffectUnconfirmed
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_identity_request_and_exact_reply_preserve_existing_helper_protocol() {
        let session = ProfileSessionId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
        let cid = ContainerId::parse(&"c".repeat(64)).unwrap();
        let raw = helper_request(&session, &cid);
        assert_eq!(
            raw,
            format!(
                "{{\"v\":1,\"sessionId\":\"{session}\",\"containerId\":\"{}\"}}\n",
                cid.as_str()
            )
            .as_bytes()
        );
        assert!(raw.len() < HELPER_FRAME_MAX);
        let expected = UnsignedInteger::from_u64(1_073_741_824);
        assert_eq!(
            helper_reply(b"{\"ok\":true,\"memoryHighBytes\":1073741824}\n", &expected),
            HelperReply::Confirmed
        );
        assert_eq!(
            helper_reply(b"{\"ok\":false,\"code\":\"WRITE_REFUSED\"}\n", &expected),
            HelperReply::Refused("WRITE_REFUSED".into())
        );
        for raw in [
            "",
            "{}\n",
            "[]\n",
            "{\"ok\":true,\"memoryHighBytes\":1073741824}",
            "{\"ok\":true,\"memoryHighBytes\":1073741824}\n\n",
            "{\"ok\":1,\"memoryHighBytes\":1073741824}\n",
            "{\"ok\":true,\"memoryHighBytes\":1073741824.0}\n",
            "{\"ok\":true,\"memoryHighBytes\":true}\n",
            "{\"ok\":true,\"memoryHighBytes\":1073741825}\n",
            "{\"ok\":true,\"memoryHighBytes\":1073741824,\"extra\":0}\n",
            "{\"ok\":false,\"code\":\"EFFECT_UNCONFIRMED\"}\n",
            "{\"ok\":false,\"code\":\"lowercase\"}\n",
            "{\"ok\":false,\"code\":\"\"}\n",
            "{\"ok\":true,\"ok\":true,\"memoryHighBytes\":1073741824}\n",
            "{\"ok\":true,\"\\u006fk\":true,\"memoryHighBytes\":1073741824}\n",
            "{\"ok\":true,\"memoryHighBytes\":NaN}\n",
        ] {
            assert_eq!(
                helper_reply(raw.as_bytes(), &expected),
                HelperReply::EffectUnconfirmed,
                "{raw:?}"
            );
        }
        assert_eq!(
            helper_reply(&vec![b'x'; HELPER_FRAME_MAX + 1], &expected),
            HelperReply::EffectUnconfirmed
        );
        assert_eq!(
            helper_reply(b"\xff\n", &expected),
            HelperReply::EffectUnconfirmed
        );
        let utf16: Vec<_> = "{\"ok\":true,\"memoryHighBytes\":1073741824}"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .chain([b'\n'])
            .collect();
        assert_eq!(
            helper_reply(&utf16, &expected),
            HelperReply::EffectUnconfirmed
        );
    }
}
