use regex_lite::Regex;
use std::{
    collections::BTreeSet,
    io::{self, Read},
    sync::LazyLock,
};

const CHUNK: u64 = 1024 * 1024;
const OVERLAP: usize = 16 * 1024;

#[derive(Clone, Copy)]
enum Constraint {
    WordPrefix,
    WholeWord,
    KeyWithDigit,
    Anywhere,
}

struct Detector {
    name: &'static str,
    pattern: Regex,
    constraint: Constraint,
}

static DETECTORS: LazyLock<Vec<Detector>> = LazyLock::new(|| {
    use Constraint::{Anywhere, KeyWithDigit, WholeWord, WordPrefix};
    [
        (
            "openai_or_anthropic_key",
            "sk-[A-Za-z0-9_-]{20,}",
            KeyWithDigit,
        ),
        (
            "stripe_key",
            "[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}",
            WordPrefix,
        ),
        (
            "github_token",
            "(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})",
            WordPrefix,
        ),
        ("slack_token", "xox[abprs]-[A-Za-z0-9-]{10,}", WordPrefix),
        ("aws_access_key", "AKIA[0-9A-Z]{16}", WholeWord),
        ("google_api_key", "AIza[0-9A-Za-z_-]{35}", WordPrefix),
        (
            "google_oauth_token",
            r"ya29\.[0-9A-Za-z_-]{20,}",
            WordPrefix,
        ),
        ("huggingface_token", "hf_[A-Za-z0-9]{30,}", WordPrefix),
        ("gitlab_token", "glpat-[A-Za-z0-9_-]{20,}", WordPrefix),
        ("npm_token", "npm_[A-Za-z0-9]{36}", WordPrefix),
        ("pypi_token", "pypi-[A-Za-z0-9_-]{50,}", WordPrefix),
        (
            "jwt",
            r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
            WordPrefix,
        ),
        (
            "private_key",
            "-----BEGIN [A-Z ]*PRIVATE KEY-----",
            Anywhere,
        ),
    ]
    .into_iter()
    .map(|(name, source, constraint)| {
        let pattern = match constraint {
            Anywhere => Regex::new(source),
            _ => Regex::new(&format!(r"\b{source}")),
        };
        Detector {
            name,
            pattern: pattern.expect("fixed credential pattern"),
            constraint,
        }
    })
    .collect()
});

fn word(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

impl Detector {
    fn accepts(&self, text: &str, candidate: regex_lite::Match<'_>) -> bool {
        if matches!(self.constraint, Constraint::Anywhere) {
            return true;
        }
        if text[..candidate.start()]
            .chars()
            .next_back()
            .is_some_and(word)
        {
            return false;
        }
        match self.constraint {
            Constraint::WholeWord => !text[candidate.end()..].chars().next().is_some_and(word),
            _ => true,
        }
    }

    fn matches(&self, text: &str) -> bool {
        let mut start = 0;
        while let Some(candidate) = self.pattern.find_at(text, start) {
            if matches!(self.constraint, Constraint::KeyWithDigit)
                && !candidate.as_str().bytes().any(|byte| byte.is_ascii_digit())
            {
                start = candidate.end();
                continue;
            }
            if self.accepts(text, candidate) {
                return true;
            }
            // A rejected prefix can overlap a later credential. Every pattern starts at ASCII.
            start = candidate.start() + 1;
        }
        false
    }
}

pub(crate) fn names(text: &str) -> impl Iterator<Item = &'static str> + '_ {
    DETECTORS
        .iter()
        .filter_map(|detector| detector.matches(text).then_some(detector.name))
}

pub(crate) fn file_names(mut reader: impl Read) -> io::Result<BTreeSet<&'static str>> {
    let mut found = BTreeSet::new();
    let mut bytes = Vec::new();
    let mut latin1 = String::new();
    while reader.by_ref().take(CHUNK).read_to_end(&mut bytes)? != 0 {
        let text = if bytes.is_ascii() {
            std::str::from_utf8(&bytes).expect("ASCII window")
        } else {
            latin1.clear();
            latin1.extend(bytes.iter().copied().map(char::from));
            &latin1
        };
        found.extend(names(text));
        if found.len() == DETECTORS.len() {
            break;
        }
        let retained = bytes.len().min(OVERLAP);
        let start = bytes.len() - retained;
        bytes.copy_within(start.., 0);
        bytes.truncate(retained);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::names;

    #[test]
    fn recognizes_the_fixed_shapes_with_the_original_case_and_boundaries() {
        let cases = [
            (
                "openai_or_anthropic_key",
                "sk-ant-api03-abcdefghijklmnopqrstuv".into(),
            ),
            ("stripe_key", "sk_live_abcdefghijklmnop1234".into()),
            (
                "github_token",
                "ghp_abcdefghijklmnopqrstuvwxyz0123456789".into(),
            ),
            ("slack_token", "xoxb-1234567890-abcdefghij".into()),
            ("aws_access_key", "AKIAABCDEFGHIJKLMNOP".into()),
            ("google_api_key", format!("AIza{}", "A".repeat(35))),
            ("google_oauth_token", format!("ya29.{}", "A".repeat(20))),
            ("huggingface_token", format!("hf_{}", "a".repeat(30))),
            ("gitlab_token", "glpat-abcdefghijklmnopqrst".into()),
            ("npm_token", format!("npm_{}", "a".repeat(36))),
            ("pypi_token", format!("pypi-{}", "_".repeat(50))),
            (
                "jwt",
                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmn".into(),
            ),
            ("private_key", "-----BEGIN OPENSSH PRIVATE KEY-----".into()),
        ];
        for (name, credential) in cases {
            assert_eq!(names(&credential).collect::<Vec<_>>(), [name]);
        }
        for ordinary in [
            "sk-learn-compatible-estimator-api",
            "task-sk-short",
            "éghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "AKIAABCDEFGHIJKLMNOPé",
        ] {
            assert!(names(ordinary).next().is_none());
        }
    }
}
