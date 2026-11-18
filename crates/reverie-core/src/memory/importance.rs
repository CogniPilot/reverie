use crate::python_regex::word;

pub const RATING_SYSTEM: &str = "You are the configured agent, rating your own memories. Given one exchange between the owner and you, answer with a single integer from 1 to 10 for how important it is to remember. 1 is small talk or filler. 10 is a fact about the owner, their preferences, feelings or projects, a running joke, a promise, or something that changes how you see each other. Reply with the number only.";
pub const RATING_SUFFIX: &str = "\n\nImportance (1-10):";

/// Find the first matching ASCII rating at the legacy Unicode word boundaries.
pub fn importance_rating(reply: &[u32]) -> Option<u8> {
    const ZERO: u32 = b'0' as u32;
    const ONE: u32 = b'1' as u32;
    const NINE: u32 = b'9' as u32;
    reply
        .split(|&point| !word(point))
        .find_map(|token| match token {
            [digit @ ONE..=NINE] => Some((*digit - ZERO) as u8),
            [ONE, ZERO] => Some(10),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rating_accepts_only_standalone_scores_and_takes_the_first() {
        for (reply, expected) in [
            ("7", Some(7)),
            ("I would say 10 out of 10", Some(10)),
            ("Importance: 3.", Some(3)),
            ("none", None),
            ("", None),
            ("42", None),
            ("你好7 9é x1 4_ ١8 ＋6, 10", Some(6)),
        ] {
            assert_eq!(
                importance_rating(&reply.chars().map(u32::from).collect::<Vec<_>>()),
                expected,
                "{reply}"
            );
        }
        assert_eq!(importance_rating(&[0xd800, u32::from('8')]), Some(8));
    }
}
