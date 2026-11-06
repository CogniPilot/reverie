//! The memory bridge's existing screening policy. Empty owner rules use the
//! qualified fixed privacy grammar. Configured regex selection is explicitly
//! unavailable until its compatible adapter is qualified; it is never skipped.
use crate::{ObservationError, native};
use reverie_contracts::{
    memory_cli::{OutputPolicy, OutputPolicyError},
    storage_identity::MetadataText,
};
use reverie_core::{
    PythonText, PythonTextRef,
    privacy_floor::{protected_name_lines, targets_private_person},
};
use std::{
    fs::File,
    io::{self, Read},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
};
#[derive(Debug)]
pub enum ScreenError {
    Policy(OutputPolicyError),
    RegexCompatibilityRequired,
    Io(io::Error),
    Utf8(std::string::FromUtf8Error),
    Native(ObservationError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for ScreenError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Policy(_) => "memory output policy refused",
            Self::RegexCompatibilityRequired => {
                "memory output policy requires a compatible native adapter"
            }
            _ => "memory screening could not be completed",
        })
    }
}
impl std::error::Error for ScreenError {}
pub struct MemoryScreen {
    policy: OutputPolicy,
    names: PathBuf,
}
impl MemoryScreen {
    /// Capture installation settings; do not load an instance, open memory,
    /// select/probe a model, create state or import Office/Handsroom data.
    pub fn capture_current() -> Result<Self, ScreenError> {
        let home = match std::env::var_os("HOME") {
            Some(home) => native::python_text(Path::new(&home)),
            None => native::home_directory(None).map_err(ScreenError::Io)?,
        };
        let root = selected("REVERIE_ROOT").unwrap_or_else(|| {
            let mut points = home;
            if !points.ends_with(&[47]) && !points.is_empty() {
                points.push(47);
            }
            points.extend("reverie".chars().map(u32::from));
            points
        });
        let names = selected("REVERIE_PROTECTED_PEOPLE").unwrap_or_else(|| {
            let mut points = root;
            if !points.ends_with(&[47]) && !points.is_empty() {
                points.push(47);
            }
            points.extend(
                "companies/default/data/protected-people.txt"
                    .chars()
                    .map(u32::from),
            );
            points
        });
        let policy = selected("REVERIE_OUTPUT_POLICY")
            .map(|points| PythonText::try_new(points).expect("OS text"))
            .unwrap_or_else(|| PythonText::from_scalar_text("{}"));
        Self::from_parts(
            policy.as_text_ref(),
            native::python_path(&names).map_err(ScreenError::Io)?,
        )
    }
    fn from_parts(policy: PythonTextRef<'_>, names: PathBuf) -> Result<Self, ScreenError> {
        Ok(Self {
            policy: OutputPolicy::decode(policy).map_err(ScreenError::Policy)?,
            names,
        })
    }
    pub fn check(&self, text: &MetadataText) -> Result<&'static str, ScreenError> {
        if !self.policy.patterns().is_empty() {
            return Err(ScreenError::RegexCompatibilityRequired);
        }
        let names = read_names(&self.names)?;
        Ok(
            if targets_private_person(text.as_python_text_ref(), &names) {
                "targeting a real private person"
            } else {
                ""
            },
        )
    }
}
/// TextIOWrapper's UTF-8/surrogateescape input, followed by universal newlines.
/// This reuses the exact OS-byte owner; it does not decode JSON bytes/BOMs.
pub fn memory_stdin_text(raw: &[u8]) -> PythonText {
    let points = native::python_text(Path::new(std::ffi::OsStr::from_bytes(raw)));
    let mut text = Vec::new();
    let mut index = 0;
    while index < points.len() {
        if points[index] == 13 {
            text.push(10);
            if points.get(index + 1) == Some(&10) {
                index += 1;
            }
        } else {
            text.push(points[index]);
        }
        index += 1;
    }
    PythonText::try_new(text).expect("OS text codepoints")
}
fn selected(name: &str) -> Option<Vec<u32>> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(|value| native::python_text(Path::new(&value)))
}
fn read_names(path: &Path) -> Result<Vec<PythonText>, ScreenError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(Vec::new()),
    };
    let mut raw = Vec::new();
    let read = file
        .read_to_end(&mut raw)
        .map_err(ScreenError::Io)
        .and_then(|_| String::from_utf8(raw).map_err(ScreenError::Utf8));
    let closed = native::close(file).map_err(ScreenError::Native);
    match (read, closed) {
        (Ok(text), Ok(())) => Ok(protected_name_lines(PythonTextRef::from_scalar_text(&text))),
        (Err(ScreenError::Io(_)), Ok(())) => Ok(Vec::new()),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ScreenError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
#[cfg(test)]
mod tests;
