use super::*;

fn wave(rate: u32, frames: u32, value: i16) -> Vec<u8> {
    let length = frames * 2;
    let mut out = Vec::new();
    out.extend(b"RIFF");
    out.extend((length + 36).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16_u32.to_le_bytes());
    out.extend(1_u16.to_le_bytes());
    out.extend(1_u16.to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * 2).to_le_bytes());
    out.extend(2_u16.to_le_bytes());
    out.extend(16_u16.to_le_bytes());
    out.extend(b"data");
    out.extend(length.to_le_bytes());
    for _ in 0..frames {
        out.extend(value.to_le_bytes());
    }
    out
}

#[test]
fn sample_count_and_pcm_values_determine_duration_and_rms() {
    let bytes = wave(8000, 160_000, 2000);
    let info = Wav::inspect(&bytes).unwrap();
    assert_eq!(info.report()["sampleRate"], 8000);
    assert_eq!(info.report()["frames"], 160_000);
    assert_eq!(info.duration(), 20.0);
    assert_eq!(info.rms(), 2000.0 / 32768.0);
    duration(info.duration(), &json!({"min":18,"max":40})).unwrap();
    assert!(duration(10.0, &json!({"min":18,"max":40})).is_err());
    assert!(duration(f64::NAN, &json!({"min":18,"max":40})).is_err());
}

#[test]
fn malformed_empty_silent_truncated_and_wrong_formats_refuse() {
    let valid = wave(8000, 8000, 2000);
    let mut malformed = valid.clone();
    malformed[4..8].copy_from_slice(&1_u32.to_le_bytes());
    let mut stereo = valid.clone();
    stereo[22..24].copy_from_slice(&2_u16.to_le_bytes());
    let mut compressed = valid.clone();
    compressed[20..22].copy_from_slice(&3_u16.to_le_bytes());
    let mut wrong_rate = valid.clone();
    wrong_rate[24..28].copy_from_slice(&1000_u32.to_le_bytes());
    let mut wrong_width = valid.clone();
    wrong_width[34..36].copy_from_slice(&24_u16.to_le_bytes());
    for bytes in [
        vec![],
        b"RIFFfake".to_vec(),
        wave(8000, 0, 1),
        wave(8000, 8000, 0),
        valid[..valid.len() - 100].to_vec(),
        malformed,
        stereo,
        compressed,
        wrong_rate,
        wrong_width,
    ] {
        assert!(Wav::inspect(&bytes).is_err());
    }
    assert!(Wav::inspect(&wave(8000, 100, 3)).is_err());
    assert!(Wav::inspect(&wave(8000, 100, 4)).is_ok());
}

#[test]
fn ancillary_chunks_are_skipped_and_the_ten_second_control_is_valid_pcm() {
    let valid = wave(8000, 160_000, 2000);
    let mut with_junk = valid[..36].to_vec();
    with_junk.extend(b"JUNK");
    with_junk.extend(3_u32.to_le_bytes());
    with_junk.extend(b"abc\0");
    with_junk.extend(&valid[36..]);
    let length = u32::try_from(with_junk.len() - 8).unwrap();
    with_junk[4..8].copy_from_slice(&length.to_le_bytes());
    let source = Wav::inspect(&with_junk).unwrap();
    let clipped = source.first_ten_seconds().unwrap();
    assert_eq!(clipped.len(), 160_044);
    assert_eq!(Wav::inspect(&clipped).unwrap().duration(), 10.0);
    assert_eq!(&clipped[44..], &valid[44..160_044]);
}
