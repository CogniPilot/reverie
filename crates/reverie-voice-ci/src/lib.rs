//! Real-model voice acceptance and its isolated loopback fixture.
mod audio;
mod fixture_service;
mod recognize;
mod transcript;
mod verify;

use std::{error::Error, path::Path};

pub type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

const FIXTURE: &str = include_str!("../../../scripts/voice-ci/fixtures.json");

/// Validate the captured route clips and the negative control.
pub async fn validate(artifacts: &Path) -> Result<()> {
    verify::run(artifacts).await
}

/// Run the loopback speech fixture against preprovisioned, pinned assets.
pub async fn serve(artifacts: &Path) -> Result<()> {
    fixture_service::serve(artifacts).await
}

fn need(value: bool, message: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
