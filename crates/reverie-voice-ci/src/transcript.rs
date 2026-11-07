use crate::{Result, need};
use serde_json::{Value, json};

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| !ch.is_ascii_lowercase() && !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

pub(crate) fn check(expected: &str, actual: &str, maximum: f64, ending: &str) -> Result<Value> {
    let reference = words(expected);
    let hypothesis = words(actual);
    need(
        !reference.is_empty() && !hypothesis.is_empty(),
        "Expected and recognized speech must both be non-empty",
    )?;
    let mut previous: Vec<usize> = (0..=hypothesis.len()).collect();
    for (i, target) in reference.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, token) in hypothesis.iter().enumerate() {
            row.push(
                (row[j] + 1)
                    .min(previous[j + 1] + 1)
                    .min(previous[j] + usize::from(target != token)),
            );
        }
        previous = row;
    }
    let wer = previous[hypothesis.len()] as f64 / reference.len() as f64;
    need(wer <= maximum, "Transcript WER exceeds fixture maximum")?;
    let final_words = words(ending);
    need(
        hypothesis.ends_with(&final_words),
        "Transcript is missing the required reply ending",
    )?;
    Ok(json!({"wordErrorRate":wer,"expectedWords":reference.len(),
        "recognizedWords":hypothesis.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn punctuation_case_and_ascii_tokenization_preserve_the_reference() {
        assert_eq!(words("İ K ’ hello_12"), vec!["i", "k", "hello", "12"]);
        assert_eq!(
            check(
                "Before we leave, turn off the lights.",
                "Before we leave turn off the lights!",
                0.18,
                ""
            )
            .unwrap()["wordErrorRate"],
            0.0
        );
        assert!(check("Expected words", "", 0.18, "").is_err());
        assert!(check("Before we leave", "Different content", 0.18, "").is_err());
    }
    #[test]
    fn the_tail_is_required_even_with_small_edit_distance() {
        let prefix =
            "The complete recording has many words so losing one word is otherwise acceptable ";
        assert!(
            check(
                &(prefix.to_owned() + "silver meadow lantern"),
                &(prefix.to_owned() + "silver meadow"),
                0.18,
                "silver meadow lantern"
            )
            .is_err()
        );
        assert_eq!(
            check("one two three four", "one two four", 0.25, "").unwrap()["wordErrorRate"],
            0.25
        );
    }
}
