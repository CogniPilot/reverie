use serde::{Deserialize, Serialize};
use std::{io, num::NonZeroU64};

const MAX_CONTEXT_BYTES: usize = 65_536;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Stage {
    Startup,
    ModelRequest,
}

impl Stage {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::ModelRequest => "model-request",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub(super) struct Digest(pub(super) String);

impl TryFrom<String> for Digest {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            Ok(Self(value))
        } else {
            Err("invalid managed context digest")
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pending {
    pub(super) digest: Digest,
    pub(super) stage: Stage,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SectionStatus {
    Configured,
    Missing,
    Captured,
}

#[derive(Deserialize)]
pub(super) struct Section {
    pub(super) id: String,
    pub(super) status: SectionStatus,
    pub(super) text: String,
}

impl Section {
    fn valid(&self) -> bool {
        let mut bytes = self.id.bytes();
        self.id.len() <= 64
            && self.text.len() <= MAX_CONTEXT_BYTES
            && bytes.next().is_some_and(|value| value.is_ascii_lowercase())
            && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Issued {
    pub(super) employee_id: String,
    session_id: String,
    pub(super) session_generation: NonZeroU64,
    pub(super) generated_at: u64,
    pub(super) digest: Digest,
    pub(super) context: String,
    pub(super) sections: Vec<Section>,
    pub(super) runtime_binding: Option<Digest>,
}

impl Issued {
    pub(super) fn validate(&self, session_id: &str) -> io::Result<()> {
        if self.session_id != session_id
            || !(1..=100).contains(&self.employee_id.len())
            || !self.employee_id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
            })
            || self.context.len() > MAX_CONTEXT_BYTES
            || self.sections.len() > 64
            || !self.sections.iter().all(Section::valid)
        {
            return Err(crate::refused());
        }
        Ok(())
    }
}
