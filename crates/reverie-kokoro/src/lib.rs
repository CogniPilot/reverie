//! Shared native Kokoro engine for the loopback service and voice acceptance.
mod assets;
mod audio;
mod engine;
mod phonemes;
mod voices;

pub use engine::Engine;
pub use voices::Voice;

/// Errors from cache validation, phonemization, or native inference.
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
