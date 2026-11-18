use super::*;
use reverie_core::memory::Mood;

pub fn decode_mood(raw: Option<&str>) -> Mood {
    raw.and_then(decode).unwrap_or_default()
}

fn decode(raw: &str) -> Option<Mood> {
    let Value(Node::Object(ref fields)) =
        crate::legacy_json::decode_python_str(raw.as_bytes()).ok()?
    else {
        return None;
    };
    let valence = legacy_float(fields.get(&text("valence"))?).ok()?;
    let arousal = legacy_float(fields.get(&text("arousal"))?).ok()?;
    let updated_at = match fields.get(&text("updated_at")) {
        Some(value) => legacy_float(value).ok()?,
        None => 0.0,
    };
    Some(Mood::new(valence, arousal, updated_at))
}

pub fn encode_mood(mood: Mood) -> String {
    let (valence, arousal, updated_at) = mood.values();
    let data = object(vec![
        ("valence", float(round_coordinate(valence))),
        ("arousal", float(round_coordinate(arousal))),
        ("updated_at", float(updated_at)),
    ]);
    String::from_utf8(data.encode()).expect("stored mood encodes as ASCII JSON")
}

fn round_coordinate(value: f64) -> f64 {
    if value.is_finite() {
        // Use decimal formatting to round the binary input to four places.
        format!("{value:.4}").parse().expect("finite rounded mood")
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_mood_values_use_python_float_coercion_and_keep_the_storage_shape() {
        let raw = r#"{"valence":"-0.502153","arousal":true,"updated_at":"1.5e6"}"#;
        assert_eq!(
            encode_mood(decode_mood(Some(raw))),
            r#"{"valence": -0.5022, "arousal": 1.0, "updated_at": 1500000.0}"#
        );
        assert_eq!(
            encode_mood(decode_mood(Some(
                r#"{"valence":0.00005,"arousal":-0.00001}"#
            ))),
            r#"{"valence": 0.0001, "arousal": -0.0, "updated_at": 0.0}"#
        );
        assert_eq!(
            decode_mood(Some(r#"{"valence":NaN,"arousal":false}"#)).describe(),
            "low and tired"
        );
        for invalid in [
            None,
            Some("garbage"),
            Some(r#"{"valence":1,"arousal":null}"#),
        ] {
            assert_eq!(decode_mood(invalid).describe(), "content and easy");
        }
    }
}
