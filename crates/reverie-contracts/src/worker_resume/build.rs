//! Fixed resume-program manifest DATA. Native custody, complete tree/link
//! observation, code hashing and selected H graph verification are separate.
use super::*;
use crate::{
    legacy_json::Number,
    resource_actor::{ArtifactReference, CodeFile},
};
use reverie_core::{PythonText, posix_path::PosixPath};
use std::collections::BTreeSet;

pub const PROGRAM_PURPOSE: &str = "host-worker-resume-program-v1";
pub const MAX_PROGRAM_ENTRIES: usize = 65536;
pub const MAX_PROGRAM_FILE_BYTES: u64 = 256 << 20;
pub const MAX_PROGRAM_BYTES: u64 = 2 << 30;
pub const MAX_PROGRAM_MANIFEST_BYTES: usize = 16 << 20;

pub struct ResumeProgramBuild {
    console: PythonText,
    invocation: PythonText,
    executable: PythonText,
    files: BTreeMap<Text, Value>,
    links: BTreeMap<Text, Value>,
    directories: BTreeSet<Text>,
    owner: Option<ArtifactReference>,
    content_bytes: u64,
    encoded_size: usize,
}
impl ResumeProgramBuild {
    pub fn new(
        console: PythonText,
        invocation: PythonText,
        node: CodeFile,
        mode: u32,
    ) -> Result<Self> {
        path(&console)?;
        path(&invocation)?;
        path(&node.path)?;
        let mut output = Self {
            console,
            invocation,
            executable: node.path.clone(),
            files: BTreeMap::new(),
            links: BTreeMap::new(),
            directories: BTreeSet::new(),
            owner: None,
            content_bytes: node.bytes,
            encoded_size: 0,
        };
        output
            .files
            .insert(text_key(&node.path), file_value(&node, mode)?);
        need(node.bytes <= MAX_PROGRAM_BYTES, "RESUME_PROGRAM_TOTAL")?;
        output.encoded_size = crate::worker_config::compact_data(&output.value()).len();
        output.check(0, 0, output.encoded_size)?;
        Ok(output)
    }
    pub fn directory(&mut self, name: PythonText) -> Result<()> {
        self.console_path(&name)?;
        let key = text_key(&name);
        need(
            !self.directories.contains(&key)
                && !self.files.contains_key(&key)
                && !self.links.contains_key(&key),
            "RESUME_PROGRAM_DUPLICATE_ENTRY",
        )?;
        let cost = encoded(&Value(Node::String(key.clone()))).len()
            + usize::from(!self.directories.is_empty());
        let size = self.next_size(cost)?;
        self.check(1, 0, size)?;
        self.directories.insert(key);
        self.encoded_size = size;
        Ok(())
    }
    pub fn file(&mut self, pin: CodeFile, mode: u32) -> Result<()> {
        self.console_path(&pin.path)?;
        let key = text_key(&pin.path);
        need(
            !self.directories.contains(&key) && !self.links.contains_key(&key),
            "RESUME_PROGRAM_DUPLICATE_ENTRY",
        )?;
        let value = file_value(&pin, mode)?;
        let previous = self.files.get(&key);
        if pin.path == self.executable {
            need(
                previous.is_some_and(|old| old.python_eq(&value)),
                "RESUME_PROGRAM_NODE_CHANGED",
            )?;
        } else {
            need(previous.is_none(), "RESUME_PROGRAM_DUPLICATE_ENTRY")?;
        }
        let size = if let Some(old) = previous {
            self.encoded_size
                .checked_sub(encoded(old).len())
                .and_then(|v| v.checked_add(encoded(&value).len()))
                .ok_or(ResumeDataError("RESUME_MANIFEST_GRAPH_BOUND"))?
        } else {
            self.next_size(entry_cost(&key, &value) + usize::from(!self.files.is_empty()))?
        };
        self.check(usize::from(previous.is_none()), pin.bytes, size)?;
        self.content_bytes += pin.bytes;
        self.files.insert(key, value);
        self.encoded_size = size;
        Ok(())
    }
    pub fn link(&mut self, name: PythonText, target: PythonText) -> Result<()> {
        self.console_path(&name)?;
        let key = text_key(&name);
        need(
            !self.directories.contains(&key)
                && !self.files.contains_key(&key)
                && !self.links.contains_key(&key),
            "RESUME_PROGRAM_DUPLICATE_ENTRY",
        )?;
        let value = string(&target);
        let size =
            self.next_size(entry_cost(&key, &value) + usize::from(!self.links.is_empty()))?;
        self.check(1, 0, size)?;
        self.links.insert(key, value);
        self.encoded_size = size;
        Ok(())
    }
    /// Only the optional immutable reference is added to the resume document.
    /// External H code belongs to its separately verified startup graph.
    pub fn owner_terminal_program(&mut self, reference: ArtifactReference) -> Result<()> {
        need(
            self.owner.is_none() && (1..=4096).contains(&reference.path.codepoints().len()),
            "RESUME_H_PROGRAM_PAIR",
        )?;
        let size = self.next_size(
            entry_cost(&key("ownerTerminalProgram"), &reference_value(&reference)) + 1,
        )?;
        self.check(0, 0, size)?;
        self.owner = Some(reference);
        self.encoded_size = size;
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        for name in [
            "lib/reverie/dist/index.js",
            "lib/reverie/dist/host-worker-resume.js",
            "lib/reverie/scripts/owner-terminal-start.mjs",
        ] {
            let expected = joined(&self.console, name);
            need(
                self.files.contains_key(&text_key(&expected)),
                "RESUME_MATCHING_CONSOLE_REQUIRED",
            )?;
        }
        let mut raw = encoded(&self.value());
        need(
            raw.len() == self.encoded_size && raw.len() < MAX_PROGRAM_MANIFEST_BYTES,
            "RESUME_MANIFEST_GRAPH_BOUND",
        )?;
        raw.push(b'\n');
        Ok(raw)
    }
    fn console_path(&self, value: &PythonText) -> Result<()> {
        let selected = path(value)?;
        need(
            selected.is_relative_to(&path(&self.console)?),
            "RESUME_CONSOLE_ENTRY_PATH",
        )
    }
    fn next_size(&self, cost: usize) -> Result<usize> {
        self.encoded_size
            .checked_add(cost)
            .ok_or(ResumeDataError("RESUME_MANIFEST_GRAPH_BOUND"))
    }
    fn check(&self, count: usize, bytes: u64, size: usize) -> Result<()> {
        need(
            self.files.len() + self.links.len() + self.directories.len() + count
                <= MAX_PROGRAM_ENTRIES,
            "RESUME_PROGRAM_COUNT",
        )?;
        need(
            self.content_bytes
                .checked_add(bytes)
                .is_some_and(|n| n <= MAX_PROGRAM_BYTES),
            "RESUME_PROGRAM_TOTAL",
        )?;
        need(
            size < MAX_PROGRAM_MANIFEST_BYTES,
            "RESUME_MANIFEST_GRAPH_BOUND",
        )
    }
    fn value(&self) -> Value {
        let mut fields = BTreeMap::from([
            (key("version"), integer(1)),
            (key("purpose"), ascii(PROGRAM_PURPOSE)),
            (key("console"), string(&self.console)),
            (key("nodeInvocation"), string(&self.invocation)),
            (key("nodeExecutable"), string(&self.executable)),
            (key("programs"), programs(&self.console, &self.invocation)),
            (key("files"), clone_object(&self.files)),
            (key("links"), clone_object(&self.links)),
            (
                key("directories"),
                Value(Node::Array(
                    self.directories
                        .iter()
                        .map(|v| Value(Node::String(v.clone())))
                        .collect(),
                )),
            ),
        ]);
        if let Some(reference) = &self.owner {
            fields.insert(key("ownerTerminalProgram"), reference_value(reference));
        }
        Value(Node::Object(fields))
    }
}
fn path(value: &PythonText) -> Result<PosixPath> {
    let path = PosixPath::try_new(value.codepoints())
        .map_err(|_| ResumeDataError("RESUME_PROGRAM_PATH"))?;
    need(
        path.codepoints() == value.codepoints()
            && !path.has_parent_component()
            && !value.codepoints().contains(&0)
            && path.is_relative_to(&PosixPath::from_scalar_text("/nix/store")),
        "RESUME_PROGRAM_PATH",
    )?;
    Ok(path)
}
fn file_value(pin: &CodeFile, mode: u32) -> Result<Value> {
    need(
        pin.bytes <= MAX_PROGRAM_FILE_BYTES && mode <= 0o7777 && mode & 0o222 == 0,
        "RESUME_READONLY_PROGRAM",
    )?;
    Ok(Value(Node::Object(BTreeMap::from([
        (key("sha256"), ascii(pin.sha256.as_str())),
        (key("bytes"), integer(pin.bytes)),
        (key("mode"), integer(u64::from(mode))),
    ]))))
}
fn programs(console: &PythonText, node: &PythonText) -> Value {
    let mut output = Vec::new();
    for entry in [
        "lib/reverie/dist/index.js",
        "lib/reverie/scripts/owner-terminal-start.mjs",
    ] {
        for replacement in [false, true] {
            let mut argv = vec![string(node), string(&joined(console, entry))];
            argv.extend(["web", "--host", "0.0.0.0", "--port", "3000"].map(ascii));
            if replacement {
                argv.push(ascii("--resource-replacement"));
            }
            output.push(Value(Node::Array(argv)));
        }
    }
    Value(Node::Array(output))
}
fn joined(root: &PythonText, suffix: &str) -> PythonText {
    let mut p = root.codepoints().to_vec();
    p.push(47);
    p.extend(suffix.chars().map(u32::from));
    PythonText::try_new(p).expect("joined codepoints")
}
fn text_key(value: &PythonText) -> Text {
    Text(value.codepoints().to_vec())
}
fn string(value: &PythonText) -> Value {
    Value(Node::String(text_key(value)))
}
fn ascii(value: &str) -> Value {
    string(&PythonText::from_scalar_text(value))
}
fn integer(value: u64) -> Value {
    Value(Node::Number(Number::Integer(value.to_string())))
}
fn encoded(value: &Value) -> Vec<u8> {
    crate::worker_config::compact_data(value)
}
fn entry_cost(key: &Text, value: &Value) -> usize {
    encoded(&Value(Node::String(key.clone()))).len() + 1 + encoded(value).len()
}
fn clone_object(fields: &BTreeMap<Text, Value>) -> Value {
    Value(Node::Object(
        fields
            .iter()
            .map(|(k, v)| (k.clone(), v.deep_clone()))
            .collect(),
    ))
}
fn reference_value(reference: &ArtifactReference) -> Value {
    Value(Node::Object(BTreeMap::from([
        (key("path"), string(&reference.path)),
        (key("sha256"), ascii(reference.sha256.as_str())),
    ])))
}
