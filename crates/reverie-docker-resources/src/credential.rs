//! Verify the deployed issuer's existing, scope-bound credential without
//! exposing the key, reconstructing a wire token, or changing registration.
use crate::error::{Error, Result, need};
use base64::{Engine, prelude::BASE64_URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

const MAX_REQUEST_BYTES: usize = 2048;
const MAX_SAFE_GENERATION: u64 = 9_007_199_254_740_991;
const INVALID: &str = "BOXED_WORKER_CREDENTIAL_INPUT";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Issuer<'a> {
    version: u8,
    purpose: &'a str,
    instance_id: &'a str,
    key: &'a str,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Binding<'a> {
    employee_id: &'a str,
    session_id: &'a str,
    session_generation: u64,
    owner: Option<String>,
    container_id: &'a str,
    credential_id: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request<'a> {
    version: u8,
    purpose: &'a str,
    #[serde(borrow)]
    issuer: Issuer<'a>,
    #[serde(borrow)]
    binding: Binding<'a>,
    observed_token_digest: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    version: u8,
    purpose: &'static str,
    binding: &'a Binding<'a>,
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                lower_hex(byte)
            }
        })
}

fn hex32(text: &str) -> Result<[u8; 32]> {
    need(text.len() == 64 && text.bytes().all(lower_hex), INVALID)?;
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * index..2 * index + 2], 16)
            .map_err(|_| Error::Refused(INVALID))?;
    }
    Ok(bytes)
}

impl Request<'_> {
    fn validate(&self) -> Result<()> {
        let binding = &self.binding;
        need(
            self.version == 1
                && self.purpose == "reverie-boxed-worker-credential-check-v1"
                && self.issuer.version == 1
                && self.issuer.purpose == "reverie-docker-worker-key-v1"
                && [
                    self.issuer.instance_id,
                    binding.employee_id,
                    binding.session_id,
                    binding.credential_id,
                ]
                .into_iter()
                .all(uuid)
                && (1..=MAX_SAFE_GENERATION).contains(&binding.session_generation)
                && binding.container_id.len() == 64
                && binding.container_id.bytes().all(lower_hex)
                && binding.owner.as_ref().is_none_or(|owner| {
                    !owner.is_empty()
                        && owner.encode_utf16().count() <= 100
                        && !owner
                            .chars()
                            .any(|character| matches!(character, '\0'..='\u{1f}' | '\u{7f}'))
                }),
            INVALID,
        )
    }

    fn verify(&self) -> Result<Receipt<'_>> {
        self.validate()?;
        let key = Zeroizing::new(hex32(self.issuer.key)?);
        let observed = hex32(self.observed_token_digest)?;
        let binding = &self.binding;
        // Keep the exact field order, JSON null owner and base64url encoding
        // of the deployed v1 issuer for compatibility with retained sessions.
        let tuple = (
            1u8,
            "docker-worker-identity",
            self.issuer.instance_id,
            binding.employee_id,
            binding.session_id,
            binding.session_generation,
            binding.owner.as_deref(),
            binding.container_id,
            binding.credential_id,
        );
        let body = serde_json::to_vec(&tuple).map_err(|_| Error::Refused(INVALID))?;
        let encoded = BASE64_URL_SAFE_NO_PAD.encode(body);
        let mut mac =
            Hmac::<Sha256>::new_from_slice(key.as_ref()).map_err(|_| Error::Refused(INVALID))?;
        mac.update(b"reverie-docker-worker-identity-v1\n");
        mac.update(encoded.as_bytes());
        let signature = Zeroizing::new(format!("{:x}", mac.finalize().into_bytes()));
        let expected = Sha256::new()
            .chain_update(encoded.as_bytes())
            .chain_update(b".")
            .chain_update(signature.as_bytes())
            .finalize();
        need(
            bool::from(observed.as_slice().ct_eq(expected.as_ref())),
            "BOXED_WORKER_CREDENTIAL_MISMATCH",
        )?;
        Ok(Receipt {
            version: 1,
            purpose: "reverie-boxed-worker-credential-verified-v1",
            binding,
        })
    }
}

pub(crate) fn verify(input: impl Read) -> Result<String> {
    let mut bytes = Zeroizing::new(Vec::new());
    input
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    need(bytes.len() <= MAX_REQUEST_BYTES, INVALID)?;
    let request: Request<'_> =
        serde_json::from_slice(&bytes).map_err(|_| Error::Refused(INVALID))?;
    let receipt = request.verify()?;
    serde_json::to_string(&receipt).map_err(|_| Error::Refused(INVALID))
}

#[cfg(test)]
mod tests;
