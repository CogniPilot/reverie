use super::{EmbeddingText, numeric::python_sum};
use blake2::{Blake2b, Digest, digest::consts::U8};
use std::{collections::BTreeMap, fmt};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EmbeddingKind {
    Document,
    Query,
}
#[derive(Debug)]
pub enum EmbeddingError {
    Dimensions,
    InvalidBlob,
    Allocation,
    InvalidNumber,
    InvalidText,
    Backend(String),
}
impl fmt::Display for EmbeddingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for EmbeddingError {}
pub trait Embedder: Send + Sync {
    fn name(&self) -> EmbeddingText<'_>;
    fn dimensions(&self) -> usize;
    fn embed_text(
        &self,
        text: EmbeddingText<'_>,
        kind: EmbeddingKind,
    ) -> Result<Vec<f64>, EmbeddingError>;
    fn embed(&self, text: &str, kind: EmbeddingKind) -> Result<Vec<f64>, EmbeddingError> {
        self.embed_text(EmbeddingText::from_scalar_text(text), kind)
    }
}
const STOPWORDS: &str = "a an the and or but if then so of to in on at by for with from as is are was were be been being am i me my you your he she it its we they them this that these those do does did have has had not no yes just like about what which who whom how when where why there here very can could would should will shall may might must oh ok okay hey hi hello well too also ever even really";
pub fn tokenize(source: &str) -> Vec<String> {
    tokenize_embedding_text(EmbeddingText::from_scalar_text(source))
}
fn tokenize_embedding_text(source: EmbeddingText<'_>) -> Vec<String> {
    crate::python_text::lower_codepoints(&source.codepoints())
        .split(|&cp| !matches!(cp,97..=122|48..=57|39))
        .filter(|word| word.len() > 1)
        .map(|word| {
            word.iter()
                .map(|&cp| char::from_u32(cp).expect("ASCII regex member"))
                .collect::<String>()
        })
        .filter(|word| !STOPWORDS.split(' ').any(|stop| stop == word))
        .collect()
}
#[derive(Clone, Debug)]
pub struct HashedEmbedder {
    dimensions: usize,
    name: String,
}
impl HashedEmbedder {
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn new(dimensions: usize) -> Self {
        Self {
            dimensions,
            name: format!("hashed-v1-{dimensions}"),
        }
    }
}
impl Default for HashedEmbedder {
    fn default() -> Self {
        Self::new(1024)
    }
}
impl Embedder for HashedEmbedder {
    fn name(&self) -> EmbeddingText<'_> {
        EmbeddingText::from_scalar_text(&self.name)
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }
    fn embed_text(
        &self,
        source: EmbeddingText<'_>,
        _kind: EmbeddingKind,
    ) -> Result<Vec<f64>, EmbeddingError> {
        let mut vector = Vec::new();
        vector
            .try_reserve_exact(self.dimensions)
            .map_err(|_| EmbeddingError::Allocation)?;
        vector.resize(self.dimensions, 0.0);
        let words = tokenize_embedding_text(source);
        let mut features = words.clone();
        features.extend(
            words
                .windows(2)
                .map(|pair| format!("{}_{}", pair[0], pair[1])),
        );
        // Python counts in first-feature insertion order; sorting these changes
        // colliding bucket summation and float32 persistence.
        let mut positions = BTreeMap::<String, usize>::new();
        let mut counts = Vec::<(String, u64)>::new();
        for feature in features {
            if let Some(&index) = positions.get(&feature) {
                counts[index].1 += 1;
            } else {
                positions.insert(feature.clone(), counts.len());
                counts.push((feature, 1));
            }
        }
        for (feature, count) in counts {
            if self.dimensions == 0 {
                return Err(EmbeddingError::Dimensions);
            }
            let hash: [u8; 8] = Blake2b::<U8>::digest(feature.as_bytes()).into();
            let number = u64::from_le_bytes(hash);
            let index = (u128::from(number) % self.dimensions as u128) as usize;
            let sign = if number >> 63 == 1 { 1.0 } else { -1.0 };
            vector[index] += sign * (1.0 + (count as f64).ln());
        }
        Ok(normalize(&vector))
    }
}
pub fn normalize(vector: &[f64]) -> Vec<f64> {
    let norm = python_sum(vector.iter().map(|x| x * x)).sqrt();
    if norm == 0.0 {
        vector.to_vec()
    } else {
        vector.iter().map(|x| x / norm).collect()
    }
}
pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        0.0
    } else {
        python_sum(a.iter().zip(b).map(|(a, b)| a * b))
    }
}
pub fn pack(vector: &[f64]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|&value| (value as f32).to_ne_bytes())
        .collect()
}
pub fn unpack(blob: &[u8]) -> Result<Vec<f64>, EmbeddingError> {
    if !blob.len().is_multiple_of(4) {
        return Err(EmbeddingError::InvalidBlob);
    }
    Ok(blob
        .chunks_exact(4)
        .map(|part| f64::from(f32::from_ne_bytes(part.try_into().expect("four bytes"))))
        .collect())
}
