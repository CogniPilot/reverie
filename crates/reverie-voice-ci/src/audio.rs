use crate::{Result, need};
use serde_json::{Value, json};

pub(crate) struct Wav<'a> {
    rate: u32,
    pcm: &'a [u8],
}

impl<'a> Wav<'a> {
    pub(crate) fn inspect(data: &'a [u8]) -> Result<Self> {
        need(
            data.len() >= 44 && &data[..4] == b"RIFF" && &data[8..12] == b"WAVE",
            "Expected a non-empty RIFF/WAVE response",
        )?;
        need(
            u64::from(integer(data, 4)?) + 8 == data.len() as u64,
            "RIFF length does not match captured bytes",
        )?;
        let mut position = 12;
        let mut rate = None;
        while position + 8 <= data.len() {
            let size = integer(data, position + 4)? as usize;
            let start = position + 8;
            let stop = start.checked_add(size).ok_or("WAV chunk overflow")?;
            need(stop <= data.len(), "WAV samples are empty or truncated")?;
            let body = &data[start..stop];
            match &data[position..position + 4] {
                b"fmt " => rate = Some(format(body)?),
                b"data" => {
                    let rate = rate.ok_or("WAV data precedes format")?;
                    // wave.getnframes() floors partial frames and readframes()
                    // returns exactly those complete PCM16 frames.
                    let pcm = &body[..body.len() / 2 * 2];
                    need(!pcm.is_empty(), "WAV samples are empty or truncated")?;
                    let wav = Self { rate, pcm };
                    need(
                        wav.rms() >= 0.0001,
                        "WAV contains no measurable speech signal",
                    )?;
                    return Ok(wav);
                }
                _ => {}
            }
            position = stop.checked_add(size % 2).ok_or("WAV chunk overflow")?;
        }
        Err("WAV format or data chunk missing".into())
    }

    pub(crate) fn duration(&self) -> f64 {
        self.frames() as f64 / f64::from(self.rate)
    }

    fn frames(&self) -> usize {
        self.pcm.len() / 2
    }

    fn rms(&self) -> f64 {
        let sum: u64 = self
            .pcm
            .chunks_exact(2)
            .map(|sample| {
                let value = u64::from(i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs());
                value * value
            })
            .sum();
        // RIFF's u32 length bounds this sum below u64::MAX. Accumulate
        // integrally, as Python does, before its floating-point division.
        (sum as f64 / self.frames() as f64).sqrt() / 32768.0
    }

    pub(crate) fn report(&self) -> Value {
        json!({"sampleRate":self.rate,"frames":self.frames(),
            "durationSeconds":self.duration(),"rms":self.rms()})
    }

    pub(crate) fn first_ten_seconds(&self) -> Result<Vec<u8>> {
        let length = self.pcm.len().min(self.rate as usize * 10 * 2);
        let size = u32::try_from(length)?;
        let riff_size = size.checked_add(36).ok_or("WAV size overflow")?;
        let mut out = Vec::with_capacity(length + 44);
        out.extend(b"RIFF");
        out.extend(riff_size.to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16_u32.to_le_bytes());
        out.extend(1_u16.to_le_bytes());
        out.extend(1_u16.to_le_bytes());
        out.extend(self.rate.to_le_bytes());
        out.extend((self.rate * 2).to_le_bytes());
        out.extend(2_u16.to_le_bytes());
        out.extend(16_u16.to_le_bytes());
        out.extend(b"data");
        out.extend(size.to_le_bytes());
        out.extend(&self.pcm[..length]);
        Ok(out)
    }
}

fn format(data: &[u8]) -> Result<u32> {
    need(data.len() >= 16, "WAV format is truncated")?;
    let tag = short(data, 0)?;
    let channels = short(data, 2)?;
    let bits = short(data, 14)?;
    let rate = integer(data, 4)?;
    let pcm = tag == 1
        || (tag == 0xfffe
            && data.len() >= 40
            && &data[24..40]
                == b"\x01\x00\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71");
    need(
        pcm && bits.div_ceil(8) == 2 && channels == 1 && (8000..=96000).contains(&rate),
        "Expected mono PCM16 speech at a supported sample rate",
    )?;
    Ok(rate)
}

fn short(bytes: &[u8], at: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .ok_or("Truncated WAV field")?
            .try_into()?,
    ))
}

fn integer(bytes: &[u8], at: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or("Truncated WAV field")?
            .try_into()?,
    ))
}

pub(crate) fn duration(seconds: f64, bounds: &Value) -> Result<()> {
    let minimum = bounds["min"].as_f64().ok_or("Missing duration minimum")?;
    let maximum = bounds["max"].as_f64().ok_or("Missing duration maximum")?;
    need(
        seconds.is_finite() && minimum <= seconds && seconds <= maximum,
        "Audio duration outside fixture bounds",
    )
}

#[cfg(test)]
mod tests;
