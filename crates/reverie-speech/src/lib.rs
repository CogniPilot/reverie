//! Native speech recognition for the Docker service and real-model acceptance.
mod media;
mod piper;
mod process;
mod service;
mod whisper;

pub use media::Format;
pub use service::{Configuration, serve};
pub use whisper::{Transcript, Whisper};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
