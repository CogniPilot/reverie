//! The image verifier's aware Python ISO timestamp comparison, including its
//! microsecond truncation and fractional UTC offsets. Calendar/ISO-week date
//! validity is owned by chrono; no clock, timezone database or runtime Python.
use chrono::{Datelike, NaiveDate, Weekday};
const DAY: i128 = 86_400_000_000;

pub(super) fn instant(input: &[u32]) -> Option<i128> {
    // Match the existing verifier's replace('Z', '+00:00') before parsing.
    let points: Vec<_> = input
        .iter()
        .flat_map(|&point| {
            if point == 90 {
                "+00:00".chars().map(u32::from).collect()
            } else {
                vec![point]
            }
        })
        .collect();
    let end = separator(&points)?;
    let date = date(points.get(..end)?)?;
    let time = points.get(end + 1..)?;
    let zone = time.iter().position(|point| [43, 45].contains(point))?;
    let clock = components(&time[..zone])?;
    let offset = components(&time[zone + 1..])?;
    let local = date.and_hms_micro_opt(clock[0], clock[1], clock[2], clock[3])?;
    let sign = if time[zone] == 45 { -1 } else { 1 };
    let offset = micros(offset);
    if offset >= DAY {
        return None;
    }
    Some(i128::from(local.and_utc().timestamp_micros()) - sign * offset)
}
fn micros(parts: [u32; 4]) -> i128 {
    ((i128::from(parts[0]) * 60 + i128::from(parts[1])) * 60 + i128::from(parts[2])) * 1_000_000
        + i128::from(parts[3])
}
fn digit(point: u32) -> bool {
    (48..=57).contains(&point)
}
fn number(points: &[u32]) -> Option<u32> {
    if points.is_empty() {
        return None;
    }
    points
        .iter()
        .try_fold(0_u32, |n, &point| digit(point).then(|| n * 10 + point - 48))
}
fn separator(raw: &[u32]) -> Option<usize> {
    if raw.len() < 7 {
        return None;
    }
    if raw.len() == 7 {
        return Some(7);
    }
    if raw[4] == 45 {
        if raw[5] != 87 {
            return Some(10);
        }
        if raw.get(8) == Some(&45) {
            if raw.len() == 9 {
                return None;
            }
            return Some(if raw.get(10).is_some_and(|&point| digit(point)) {
                8
            } else {
                10
            });
        }
        return Some(8);
    }
    if raw[4] != 87 {
        return Some(8);
    }
    let mut index = 7;
    while raw.get(index).is_some_and(|&point| digit(point)) {
        index += 1;
    }
    Some(if index < 9 {
        index
    } else if index % 2 == 0 {
        7
    } else {
        8
    })
}
fn date(raw: &[u32]) -> Option<NaiveDate> {
    if ![7, 8, 10].contains(&raw.len()) {
        return None;
    }
    let year = i32::try_from(number(raw.get(..4)?)?).ok()?;
    if !(1..=9999).contains(&year) {
        return None;
    }
    let separated = raw.get(4) == Some(&45);
    let mut pos = 4 + usize::from(separated);
    let date = if raw.get(pos) == Some(&87) {
        pos += 1;
        let week = number(raw.get(pos..pos + 2)?)?;
        pos += 2;
        let day = if raw.len() == pos {
            1
        } else {
            if (raw.get(pos) == Some(&45)) != separated {
                return None;
            }
            pos += usize::from(separated);
            number(raw.get(pos..pos + 1)?)?
        };
        let weekday = [
            Weekday::Mon,
            Weekday::Tue,
            Weekday::Wed,
            Weekday::Thu,
            Weekday::Fri,
            Weekday::Sat,
            Weekday::Sun,
        ]
        .get(usize::try_from(day.checked_sub(1)?).ok()?)?;
        NaiveDate::from_isoywd_opt(year, week, *weekday)?
    } else {
        let month = number(raw.get(pos..pos + 2)?)?;
        pos += 2;
        if (raw.get(pos) == Some(&45)) != separated {
            return None;
        }
        pos += usize::from(separated);
        let day = number(raw.get(pos..pos + 2)?)?;
        if pos + 2 != raw.len() {
            return None;
        }
        NaiveDate::from_ymd_opt(year, month, day)?
    };
    (1..=9999).contains(&date.year()).then_some(date)
}
fn components(raw: &[u32]) -> Option<[u32; 4]> {
    let mut output = [0; 4];
    let mut pos = 0;
    let mut separated = false;
    for (index, value) in output.iter_mut().take(3).enumerate() {
        *value = number(raw.get(pos..pos + 2)?)?;
        pos += 2;
        if index == 0 {
            separated = raw.get(pos) == Some(&58);
        }
        if pos == raw.len() || raw.get(pos).is_some_and(|point| [44, 46].contains(point)) {
            break;
        }
        if index == 2 {
            return None;
        }
        if separated {
            if raw.get(pos) != Some(&58) {
                return None;
            }
            pos += 1;
        }
    }
    if pos < raw.len() {
        let fraction = raw.get(pos + 1..)?;
        if !raw.get(pos).is_some_and(|point| [44, 46].contains(point))
            || fraction.is_empty()
            || !fraction.iter().all(|&point| digit(point))
        {
            return None;
        }
        let taken = fraction.len().min(6);
        output[3] = number(&fraction[..taken])? * 10_u32.pow(u32::try_from(6 - taken).ok()?);
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_actor::{array, field, scalar, text};
    #[test]
    fn aware_image_creation_matches_actual_python_isoformat_vectors() {
        // JSON's surrogate separator must remain codepoints, never UTF-8-repaired.
        let raw = include_bytes!("../../tests/fixtures/resource_actor/image-created-python.json");
        let corpus = crate::legacy_json::decode_strict_bytes(raw).unwrap();
        assert_eq!(
            scalar(field(&corpus, "python").unwrap()).unwrap(),
            "3.13.15"
        );
        let cases = array(field(&corpus, "cases").unwrap()).unwrap();
        assert_eq!(cases.len(), 52);
        for case in cases {
            let raw = text(field(case, "raw").unwrap()).unwrap();
            let value = field(case, "microseconds").unwrap();
            let expected = if matches!(value.0, crate::legacy_json::Node::Null) {
                None
            } else {
                Some(scalar(value).unwrap().parse::<i128>().unwrap())
            };
            assert_eq!(
                instant(raw.codepoints()),
                expected,
                "{:?}",
                raw.codepoints()
            );
        }
        let mut surrogate: Vec<_> = "2026-11-07T23:45:12+00:00".chars().map(u32::from).collect();
        surrogate[10] = 0xd800;
        assert!(instant(&surrogate).is_some());
    }
}
