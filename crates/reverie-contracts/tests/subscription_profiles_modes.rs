//! The modes observation carries exactly the providers the handler asked for.
use reverie_contracts::subscription_profiles_v1::{Modes, Provider, Refusal, decode_modes};

#[test]
fn accepts_exactly_the_requested_providers() {
    assert_eq!(
        decode_modes(br#"{"openai":["codex"]}"#, &[Provider::Openai]),
        Ok(Modes {
            anthropic: Vec::new(),
            openai: vec!["codex".to_owned()],
        })
    );
    assert_eq!(
        decode_modes(
            br#"{"anthropic":[],"openai":[]}"#,
            &[Provider::Anthropic, Provider::Openai]
        ),
        Ok(Modes::default())
    );
}

#[test]
fn refuses_anything_else_by_name() {
    for (raw, requested) in [
        (&br#"{}"#[..], &[Provider::Openai][..]),
        (br#"{"anthropic":[],"openai":[]}"#, &[Provider::Openai]),
        (br#"{"openai":[],"extra":[]}"#, &[Provider::Openai]),
        (br#"{"openai":[1]}"#, &[Provider::Openai]),
        (br#"{"openai":[],"openai":[]}"#, &[Provider::Openai]),
        (br#"["openai"]"#, &[Provider::Openai]),
    ] {
        assert_eq!(
            decode_modes(raw, requested),
            Err(Refusal::ObservationSchema),
            "{}",
            String::from_utf8_lossy(raw)
        );
    }
}
