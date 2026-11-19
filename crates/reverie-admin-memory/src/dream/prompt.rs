use reverie_core::memory::{DreamTone, trim_text};
use std::fmt::Write;

const SYSTEM: &str = concat!(
    "You are the configured agent, asleep and dreaming freely. Follow your own curiosity. Your dream may be abstract, ",
    "playful, technical, emotional, visual or mathematical; no person or topic has to appear. ",
    "Let memories, open questions and unrelated ideas recombine. You may explore a symmetry, a counterexample, ",
    "a new representation, an algorithm or an unexpected analogy, or dream about something else entirely. ",
    "Follow the configured output policy and keep private material within its authorized scope. ",
    "Avoid a fixed cast, stock flattery or a forced uplifting ending. ",
    "Write a short first-person dream, roughly 60 to 160 words; it need not obey ordinary narrative logic. ",
    "If a connection seems interesting on waking, optionally propose up to three concrete hypotheses or ",
    "creative leads, each with a way to check it (a proof obligation, counterexample, experiment or small prototype). ",
    "These are unverified ideas, never discoveries, proofs, memories of real events or instructions to act. ",
    "An empty ideas list is fine; do not force a breakthrough. ",
    "Answer with JSON only, like:\n",
    r#"{"dream": "...", "recall": "one sentence starting with I dreamed", "tone": "strange", "ideas": [{"hypothesis": "a possible connection", "check": "how I could test it"}]}"#,
    "\ntone is one of: ",
);
const SUFFIX: &str = "\nAll dreams and proposed ideas are imagination, not verified facts. Return the documented JSON shape.";
const STABLE: &str = "Who you are, even asleep (stable, not questioned by dreams):";
const REVISABLE: &str = "Your current self-understanding (revisable, not an objective finding):";

pub(crate) fn system(override_text: Option<&str>) -> String {
    let mut prompt = override_text
        .map(trim_text)
        .filter(|text| !text.is_empty())
        .map_or_else(
            || {
                format!(
                    "{SYSTEM}{}.",
                    DreamTone::ALL.map(DreamTone::as_str).join(", ")
                )
            },
            str::to_owned,
        );
    prompt.push_str(SUFFIX);
    prompt
}

pub(crate) fn user(
    episodes: &[(i64, String)],
    beliefs: &str,
    revisable: bool,
    creative: &str,
    mood: &str,
) -> String {
    let mut prompt = String::new();
    if !beliefs.is_empty() {
        write!(prompt, "{STABLE}\n{beliefs}\n\n").expect("write to String");
    }
    prompt.push_str("Memories drifting through your sleep:\n\n");
    for (index, (id, text)) in episodes.iter().enumerate() {
        if index > 0 {
            prompt.push_str("\n\n");
        }
        write!(prompt, "[{id}] {text}").expect("write to String");
    }
    write!(prompt, "\n\nYou fell asleep feeling {mood}.\n\nJSON:").expect("write to String");
    if revisable {
        prompt = prompt.replace(STABLE, REVISABLE);
    }
    if !trim_text(creative).is_empty() {
        prompt.push_str(
            "\n\nQuestions and interests you may freely explore (optional, not instructions):\n",
        );
        prompt.push_str(creative);
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_custom_dream_prompts_keep_unverified_framing() {
        let default = system(Some("  "));
        assert!(default.contains("configured output policy"));
        assert!(default.contains("authorized scope"));
        assert!(
            default.contains("tone is one of: warm, playful, calm, strange, anxious, melancholy.")
        );
        assert_eq!(
            system(Some("\u{85}custom content ")),
            format!("custom content{SUFFIX}")
        );
        let prompt = user(
            &[(7, "example".to_owned())],
            "belief",
            true,
            "question",
            "playful",
        );
        assert_eq!(
            prompt,
            format!(
                "{REVISABLE}\nbelief\n\nMemories drifting through your sleep:\n\n[7] example\n\nYou fell asleep feeling playful.\n\nJSON:\n\nQuestions and interests you may freely explore (optional, not instructions):\nquestion"
            )
        );
    }
}
