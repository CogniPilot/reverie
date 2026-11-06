//! The response bound applies to the complete body, closing bytes included.
use reverie_contracts::subscription_profiles_v1::{
    JsString, MAX_RESPONSE_BYTES, Modes, Profile, Provider, Refusal, profiles_response,
};

fn profile(config_dir_len: usize) -> Profile {
    Profile {
        id: JsString::from("p"),
        label: JsString::from("L"),
        provider: Provider::Anthropic,
        config_dir: JsString::from(format!("/{}", "a".repeat(config_dir_len)).as_str()),
        open_code_data_dir: JsString::from("/o"),
    }
}

#[test]
fn response_bound_counts_the_closing_bytes() {
    let modes = Modes {
        anthropic: vec!["claude".to_owned()],
        openai: Vec::new(),
    };
    let empty = profiles_response(&[], &modes).expect("empty list");
    assert_eq!(empty.body, br#"{"success":true,"data":{"profiles":[]}}"#);
    let base = profiles_response(&[profile(0)], &modes)
        .expect("small reply")
        .body
        .len();
    let room = MAX_RESPONSE_BYTES - base;
    for (extra, length) in [
        (room - 1, MAX_RESPONSE_BYTES - 1),
        (room, MAX_RESPONSE_BYTES),
    ] {
        let reply = profiles_response(&[profile(extra)], &modes).expect("reply within the bound");
        assert_eq!(reply.body.len(), length);
    }
    assert_eq!(
        profiles_response(&[profile(room + 1)], &modes),
        Err(Refusal::ResponseBound)
    );
}
