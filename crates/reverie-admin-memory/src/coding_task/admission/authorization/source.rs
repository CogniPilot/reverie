use super::{Decision, Denial};
use reverie_core::python_trim_text;
use serde_json::{Map, Number, Value};
use std::time::{SystemTime, UNIX_EPOCH};

struct Identity<'a> {
    id: &'a str,
    room: &'a str,
    text: &'a str,
    at: &'a Value,
    sender: Map<String, Value>,
}

impl<'a> Identity<'a> {
    fn read(message: &'a Value) -> Option<Self> {
        let mut sender = message["from"].as_object()?.clone();
        sender.remove("authenticatedOwner");
        Some(Self {
            id: message["id"].as_str().filter(|id| !id.is_empty())?,
            room: message["roomId"].as_str()?,
            text: message["text"].as_str()?,
            at: &message["at"],
            sender,
        })
    }
}

pub(super) fn matches(original: &Value, fresh: &Value, room: &str) -> Decision<bool> {
    let original = Identity::read(original).ok_or(Denial::AuthorizationUnavailable)?;
    let fresh = Identity::read(fresh).ok_or(Denial::AuthorizationUnavailable)?;
    Ok(fresh.room == room
        && original.room == fresh.room
        && original.id == fresh.id
        && original.text == fresh.text
        && equivalent(original.at, fresh.at)
        && same_fields(&original.sender, &fresh.sender))
}

// Legacy Python treated integer and floating encodings of the same number as
// equivalent. Compare integer pairs exactly and preserve that mixed encoding.
pub(super) fn equivalent(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => same_fields(left, right),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| equivalent(a, b))
        }
        (Value::Number(left), Value::Number(right)) if left.is_f64() != right.is_f64() => {
            if left.is_f64() {
                integer_matches_float(right, left)
            } else {
                integer_matches_float(left, right)
            }
        }
        _ => left == right,
    }
}

fn integer_matches_float(integer: &Number, float: &Number) -> bool {
    let Some(value) = float.as_f64().filter(|value| value.fract() == 0.0) else {
        return false;
    };
    if let Some(integer) = integer.as_i64() {
        ((i64::MIN as f64)..(-(i64::MIN as f64))).contains(&value) && integer == value as i64
    } else {
        (0.0..(u64::MAX as f64)).contains(&value) && integer.as_u64() == Some(value as u64)
    }
}

fn same_fields(left: &Map<String, Value>, right: &Map<String, Value>) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .all(|(key, value)| right.get(key).is_some_and(|other| equivalent(value, other)))
}

pub(super) fn timestamp(message: &Value) -> Decision<f64> {
    message
        .get("at")
        .map_or(Some(0.0), Value::as_f64)
        .ok_or(Denial::AuthorizationUnavailable)
}

pub(super) struct Lease<'a> {
    silent_until: Option<f64>,
    name: Option<&'a str>,
}

impl<'a> Lease<'a> {
    pub(super) fn read(view: &'a Value) -> Decision<Self> {
        if !view.is_object() {
            return Err(Denial::AuthorizationUnavailable);
        }
        let mut silent_until = None;
        if !view["lease"].is_null() {
            let mode = view["lease"]["mode"]
                .as_str()
                .filter(|mode| ["silent", "ring", "vibrate"].contains(mode))
                .ok_or(Denial::AuthorizationUnavailable)?;
            let until = view["lease"]["until"]
                .as_f64()
                .filter(|until| until.is_finite())
                .ok_or(Denial::AuthorizationUnavailable)?;
            silent_until = (mode == "silent").then_some(until);
        }
        let name = view["name"].as_str().filter(|name| {
            crate::hands_settings::truthy(&view["unique"]) && !python_trim_text(name).is_empty()
        });
        Ok(Self { silent_until, name })
    }

    pub(super) fn allows(&self, fresh: &Value) -> Decision {
        match fresh["phoneWake"].as_bool() {
            Some(false) => return Err(Denial::Silent),
            None => return Err(Denial::AuthorizationUnavailable),
            Some(true) => {}
        }
        self.allows_notification(fresh)
    }

    pub(super) fn allows_notification(&self, fresh: &Value) -> Decision {
        let Some(until) = self.silent_until else {
            return Ok(());
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Denial::AuthorizationUnavailable)?
            .as_secs_f64()
            * 1000.0;
        if until <= now {
            return Ok(());
        }
        let sender = &fresh["from"];
        let owner_voice = sender["kind"] == "user"
            && matches!(
                sender["mark"].as_str(),
                Some("owner_typed" | "owner_spoken")
            );
        let text = fresh["text"].as_str().unwrap_or_default();
        if owner_voice
            && (mentions(text, "everyone") || self.name.is_some_and(|name| mentions(text, name)))
        {
            Ok(())
        } else {
            Err(Denial::Silent)
        }
    }
}

fn mentions(text: &str, name: &str) -> bool {
    let text = text.to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    text.match_indices('@').any(|(start, _)| {
        let before = start
            .checked_sub(1)
            .and_then(|at| text.as_bytes().get(at))
            .copied();
        let after = &text[start + 1..];
        before.is_none_or(|ch| !word(ch) && ch != b'@')
            && after.starts_with(&name)
            && after
                .as_bytes()
                .get(name.len())
                .is_none_or(|&ch| !word(ch) && ch != b'-')
    })
}

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}
