use crate::{Error, Result, cli::Operation, frame::Connection, json};
use serde_json::Value;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

const LIMIT: usize = 32_768;
fn validate(raw: &[u8]) -> Result<Value> {
    let value = json::decode(raw)?;
    let fields = json::closed(&value, &["version", "configDigest", "identities"])?;
    json::need(fields["version"].as_u64() == Some(1))?;
    json::need(fields["configDigest"].as_str().is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }))?;
    let expected = [
        "config",
        "configRoot",
        "key",
        "keyRoot",
        "canonical",
        "canonicalRoot",
        "nonce",
        "nonceRoot",
        "authority",
        "authorityRoot",
        "canonicalLock",
        "nonceLock",
        "noncePending",
        "nonceParent",
    ];
    let identities = json::closed(&fields["identities"], &expected)?;
    for identity in identities.values() {
        if identity.is_null() {
            continue;
        }
        let parts = identity
            .as_array()
            .ok_or(Error("Invalid closed metadata"))?;
        json::need(
            parts.len() == 5
                && parts.iter().all(|part| {
                    part.as_str().is_some_and(|text| {
                        (1..=24).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
                    })
                }),
        )?;
    }
    Ok(value)
}
fn project() -> Result<Vec<u8>> {
    let mut connection = Connection::open(Some(Instant::now() + Duration::from_millis(1750)))?;
    let result = (|| {
        connection.send(b'G', br#"{"action":"goal-custody"}"#)?;
        let frame = connection.receive(LIMIT)?;
        if frame.kind != b'J' {
            return Err(Error("Private Goal custody unavailable"));
        }
        let value = validate(&frame.payload)?;
        let encoded = serde_json::to_vec(&value)?;
        json::need(encoded.len() <= LIMIT)?;
        connection.validate()?;
        Ok(encoded)
    })();
    connection.finish(result)
}
pub(crate) fn run(operation: Operation) -> Result<u8> {
    let Operation::Custody { stream } = operation else {
        return Err(Error("Invalid custody operation"));
    };
    if !stream {
        let raw = project()?;
        let mut output = std::io::stdout().lock();
        output.write_all(&raw)?;
        output.write_all(b"\n")?;
        output.flush()?;
        return Ok(0);
    }
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut operation = [0_u8; 1];
        match input.read(&mut operation) {
            Ok(0) => return Ok(0),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
        if operation[0] != b'G' {
            return Err(Error("Closed Goal helper operation refused"));
        }
        let raw = project()?;
        output.write_all(b"J")?;
        output.write_all(&(raw.len() as u32).to_be_bytes())?;
        output.write_all(&raw)?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::validate;
    use serde_json::{Value, json};
    fn valid() -> Value {
        let names = [
            "config",
            "configRoot",
            "key",
            "keyRoot",
            "canonical",
            "canonicalRoot",
            "nonce",
            "nonceRoot",
            "authority",
            "authorityRoot",
            "canonicalLock",
            "nonceLock",
            "noncePending",
            "nonceParent",
        ];
        let identities: serde_json::Map<_, _> = names
            .into_iter()
            .map(|name| {
                (
                    name.into(),
                    json!(["0", "000", "123456789012345678901234", "5", "6"]),
                )
            })
            .collect();
        json!({"version":1,"configDigest":"a".repeat(64),"identities":identities})
    }
    #[test]
    fn exact_fourteen_custody_identities_and_decimal_tuple_types() {
        let original = valid();
        assert!(validate(&serde_json::to_vec(&original).unwrap()).is_ok());
        for replacement in [
            json!(true),
            json!(1),
            json!(["1", "2"]),
            json!(["1", "2", "3", "4", 5]),
            json!(["1", "2", "3", "4", ""]),
            json!(["1", "2", "3", "4", "١"]),
            json!(["1", "2", "3", "4", "1".repeat(25)]),
        ] {
            let mut value = original.clone();
            value["identities"]["nonce"] = replacement;
            assert!(validate(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        let mut nullable = original.clone();
        nullable["identities"]["nonce"] = Value::Null;
        assert!(validate(&serde_json::to_vec(&nullable).unwrap()).is_ok());
        let mut extra = original.clone();
        extra["secret"] = "never".into();
        assert!(validate(&serde_json::to_vec(&extra).unwrap()).is_err());
        let mut absent = original.clone();
        absent["identities"]
            .as_object_mut()
            .unwrap()
            .remove("canonicalLock");
        assert!(validate(&serde_json::to_vec(&absent).unwrap()).is_err());
        let mut boolean = original;
        boolean["version"] = true.into();
        assert!(validate(&serde_json::to_vec(&boolean).unwrap()).is_err());
    }
}
