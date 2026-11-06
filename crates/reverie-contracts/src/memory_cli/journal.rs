//! Existing public journal CLI argument data. It carries no session credential,
//! verified source, readable-turn permission or save receipt of its own.
use super::*;
const TAGS: [&str; 9] = [
    "decision",
    "promise",
    "correction",
    "preference",
    "identity",
    "relationship",
    "open-question",
    "lesson",
    "personal-reflection",
];
pub struct JournalSaveRequest {
    text: MetadataText,
    arguments: Vec<MetadataText>,
    missing: Vec<&'static str>,
}
impl JournalSaveRequest {
    pub(super) fn from_data(data: &OrderedValue) -> Result<Self> {
        let text = field_string(data, "text", "");
        let text = MetadataText::from_python_text(text.as_python_text_ref().trimmed().into_owned());
        if text.codepoints().is_empty() {
            return Err(MemoryRequestError::RememberText);
        }
        let Node::Object(fields) = &data.value.0 else {
            unreachable!("named request object")
        };
        let get = |name: &str| fields.get(&key(name));
        let present = |name: &str| truthy(get(name));
        let selected = |name: &str, default: &str| {
            if present(name) {
                field_string(data, name, default)
            } else {
                MetadataText::from_scalar_text(default)
            }
        };
        let mut missing = Vec::new();
        for name in ["room", "turn", "tag"] {
            if !get(name)
                .and_then(as_text)
                .is_some_and(|text| !text.as_python_text_ref().trimmed().is_empty())
            {
                missing.push(name);
            }
        }
        if !present("quote") && !present("source") {
            missing.push("quote or source");
        }
        if present("tag")
            && !get("tag")
                .and_then(as_text)
                .is_some_and(|text| TAGS.iter().any(|tag| text.as_python_text_ref() == *tag))
        {
            missing.push("a valid journal tag");
        }
        let mut arguments = vec![
            scalar("save"),
            scalar("--room"),
            selected("room", "<room-id>"),
            scalar("--turn"),
            selected("turn", "<message-id>"),
            scalar("--text"),
            text.clone(),
            scalar("--tag"),
            selected("tag", &format!("<{}>", TAGS.join("|"))),
        ];
        if present("quote") {
            arguments.extend([
                scalar("--source"),
                selected("turn", "<message-id>"),
                scalar("--quote"),
                field_string(data, "quote", ""),
            ]);
        }
        if present("source") {
            arguments.extend([scalar("--ref"), field_string(data, "source", "")]);
        }
        if !present("quote") && !present("source") {
            arguments.extend([
                scalar("--source"),
                selected("turn", "<message-id>"),
                scalar("--quote"),
                scalar("<exact words from that message>"),
            ]);
        }
        for (name, flag) in [("reason", "--reason"), ("project", "--project")] {
            if present(name) {
                arguments.extend([scalar(flag), field_string(data, name, "")]);
            }
        }
        Ok(Self {
            text,
            arguments,
            missing,
        })
    }
    pub fn text(&self) -> &MetadataText {
        &self.text
    }
    pub fn arguments(&self) -> &[MetadataText] {
        &self.arguments
    }
    pub fn missing(&self) -> &[&'static str] {
        &self.missing
    }
    pub fn copy_command(&self) -> MetadataText {
        let mut output = Vec::new();
        for argument in [scalar("reverie"), scalar("agent"), scalar("journal")]
            .iter()
            .chain(&self.arguments)
        {
            if !output.is_empty() {
                output.push(32);
            }
            quote(argument.codepoints(), &mut output);
        }
        MetadataText::from_text(Text(output))
    }
}
fn scalar(value: &str) -> MetadataText {
    MetadataText::from_scalar_text(value)
}
fn quote(value: &[u32], output: &mut Vec<u32>) {
    if !value.is_empty()
        && value.iter().all(|&point| {
            u8::try_from(point)
                .is_ok_and(|byte| byte.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&byte))
        })
    {
        output.extend_from_slice(value);
        return;
    }
    output.push(39);
    for &point in value {
        if point == 39 {
            output.extend("'\"'\"'".chars().map(u32::from));
        } else {
            output.push(point);
        }
    }
    output.push(39);
}
