//! Existing memory retrieval and lexical embeddings. Data is not model authority.
mod embedding;
mod embedding_text;
mod float_text;
mod numeric;
use crate::python_text as text;
mod ranking;
pub use embedding::{
    Embedder, EmbeddingError, EmbeddingKind, HashedEmbedder, cosine, normalize, pack, tokenize,
    unpack,
};
pub use embedding_text::EmbeddingText;
pub use float_text::parse_embedding_float_text;
pub use numeric::{MemoryMathError, recency_score, score_memory};
pub use ranking::{MemoryRank, MemoryRankError, memory_rank_order};
pub use text::{
    collapse_whitespace, normalize_utterance, normalize_utterance_text, quoted_memory_text,
    trim_text,
};

pub const EPISODE: &str = "episode";
pub const REFLECTION: &str = "reflection";
pub const DREAM: &str = "dream";

pub fn episode_text(user: &str, assistant: &str) -> String {
    format!(
        "User: {}\nAssistant: {}",
        trim_text(user),
        trim_text(assistant)
    )
}
pub fn episode_text_codepoints(user: EmbeddingText<'_>, assistant: EmbeddingText<'_>) -> Vec<u32> {
    let mut result = "User: ".chars().map(u32::from).collect::<Vec<_>>();
    result.extend_from_slice(&user.trimmed().codepoints());
    result.extend("\nAssistant: ".chars().map(u32::from));
    result.extend_from_slice(&assistant.trimmed().codepoints());
    result
}
pub fn clamp_importance(value: f64) -> f64 {
    numeric::clamp(value, 1.0, 10.0)
}
pub fn truncate_text(text: &str, maximum: usize) -> String {
    text.chars().take(maximum).collect()
}
#[derive(Clone, Debug, PartialEq)]
pub struct Belief {
    pub id: i64,
    pub text: String,
    pub weight: f64,
    pub parent_id: Option<i64>,
    pub protected: bool,
    pub created_at: f64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectName(String);
impl ProjectName {
    pub fn parse(raw: &str) -> Option<Self> {
        if raw.is_empty()
            || raw.len() > 64
            || !raw.as_bytes()[0].is_ascii_lowercase() && !raw.as_bytes()[0].is_ascii_digit()
            || !raw
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
        {
            return None;
        }
        Some(Self(raw.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
