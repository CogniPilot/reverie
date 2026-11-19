//! Trim model padding and encode the existing mono PCM16 response.
use crate::Result;

pub(super) const RATE: u32 = 24_000;
pub(super) const MAX_SAMPLES: usize = RATE as usize * 180;
const WINDOW: usize = 2048;
const HOP: usize = 512;

pub(super) fn trim(samples: &[f32]) -> &[f32] {
    let powers: Vec<f32> = (0..=samples.len() / HOP)
        .map(|frame| {
            let midpoint = frame * HOP;
            let start = midpoint.saturating_sub(WINDOW / 2);
            let end = (midpoint + WINDOW / 2).min(samples.len());
            samples[start..end].iter().map(|s| s * s).sum::<f32>() / WINDOW as f32
        })
        .collect();
    let peak = powers.iter().copied().fold(0.0, f32::max).max(1e-10);
    let audible = |power: &f32| power.max(1e-10) > peak * 1e-6;
    let first = powers.iter().position(audible);
    let last = powers.iter().rposition(audible);
    match (first, last) {
        (Some(first), Some(last)) => &samples[first * HOP..((last + 1) * HOP).min(samples.len())],
        _ => &[],
    }
}

pub(super) fn wave(samples: &[f32]) -> Result<Vec<u8>> {
    if samples.len() > MAX_SAMPLES {
        return Err("Model output exceeds its bound".into());
    }
    let bytes = u32::try_from(samples.len() * 2)?;
    let mut output = Vec::with_capacity(bytes as usize + 44);
    output.extend(b"RIFF");
    output.extend((bytes + 36).to_le_bytes());
    output.extend(b"WAVEfmt ");
    output.extend(16_u32.to_le_bytes());
    output.extend(1_u16.to_le_bytes());
    output.extend(1_u16.to_le_bytes());
    output.extend(RATE.to_le_bytes());
    output.extend((RATE * 2).to_le_bytes());
    output.extend(2_u16.to_le_bytes());
    output.extend(16_u16.to_le_bytes());
    output.extend(b"data");
    output.extend(bytes.to_le_bytes());
    for sample in samples {
        let pcm = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        output.extend(pcm.to_le_bytes());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{trim, wave};

    #[test]
    fn pcm16_is_clipped_and_encoded_little_endian() {
        let data = wave(&[-2.0, 0.0, 1.0, 2.0]).unwrap();
        assert_eq!(&data[..12], b"RIFF,\0\0\0WAVE");
        assert_eq!(&data[44..], [1, 128, 0, 0, 255, 127, 255, 127]);
    }

    #[test]
    fn padding_is_trimmed_at_model_frame_boundaries() {
        let mut samples = vec![0.0; 8192];
        samples[4096..5120].fill(0.5);
        assert_eq!(trim(&samples), &samples[3584..6144]);
    }
}
