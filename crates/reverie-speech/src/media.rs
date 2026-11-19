#[derive(Clone, Copy)]
pub enum Format {
    Wav,
    Webm,
    Mp4,
    Ogg,
    Mp3,
    Detect,
}

impl Format {
    pub fn from_content_type(value: &str) -> Option<Self> {
        let mime = value.split(';').next()?.trim().to_ascii_lowercase();
        match mime.as_str() {
            "audio/wav" | "audio/x-wav" | "audio/wave" => Some(Self::Wav),
            "audio/webm" | "video/webm" | "audio/x-matroska" => Some(Self::Webm),
            "audio/mp4" | "audio/x-m4a" | "video/mp4" | "audio/3gpp" => Some(Self::Mp4),
            "audio/ogg" | "application/ogg" | "audio/opus" => Some(Self::Ogg),
            "audio/mpeg" | "audio/mp3" => Some(Self::Mp3),
            "application/octet-stream" => Some(Self::Detect),
            kind if kind.starts_with("audio/") => Some(Self::Detect),
            _ => None,
        }
    }

    pub(super) fn demuxer(self) -> Option<&'static str> {
        match self {
            Self::Wav => Some("wav"),
            Self::Webm => Some("matroska"),
            Self::Mp4 => Some("mov"),
            Self::Ogg => Some("ogg"),
            Self::Mp3 => Some("mp3"),
            Self::Detect => None,
        }
    }
}

/// Duration of the bounded mono, 16 kHz PCM output of the decoder.
pub(super) fn decoded_milliseconds(wav: &[u8]) -> Option<u64> {
    if wav.get(..4)? != b"RIFF" || wav.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut tail = wav.get(12..)?;
    while tail.len() >= 8 {
        let length = u32::from_le_bytes(tail[4..8].try_into().ok()?) as usize;
        let start = 8_usize.checked_add(length)?;
        if tail.get(..4)? == b"data" {
            tail.get(8..start)?;
            return Some(length as u64 / 32);
        }
        tail = tail.get(start.checked_add(length % 2)?..)?;
    }
    None
}
