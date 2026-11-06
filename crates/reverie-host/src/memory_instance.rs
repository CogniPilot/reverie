//! Owner-selected memory instance loading in the calling service's namespace.
//! The resulting labels/paths are configuration data, never a memory grant.
use crate::native;
use reverie_contracts::memory_instance::{InstanceCodecError, InstanceHeader, MemoryInstance};
use reverie_core::posix_path::PosixPath;
use std::{
    fmt, fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub enum InstanceLoadError {
    Io(io::Error),
    Codec(InstanceCodecError),
    Native(crate::ObservationError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    SeparateStateRequired,
    ContextBinding,
}
impl fmt::Display for InstanceLoadError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(output),
            Self::Codec(error) => error.fmt(output),
            Self::Native(error) => error.fmt(output),
            Self::Finalization { primary, secondary } => {
                write!(output, "{primary}; finalizer: {secondary}")
            }
            Self::SeparateStateRequired => {
                output.write_str("instance data_dir must be a separate state directory")
            }
            Self::ContextBinding => output.write_str("installed memory instance binding changed"),
        }
    }
}
impl std::error::Error for InstanceLoadError {}
impl From<io::Error> for InstanceLoadError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<InstanceCodecError> for InstanceLoadError {
    fn from(error: InstanceCodecError) -> Self {
        Self::Codec(error)
    }
}
pub struct LoadedMemoryInstance {
    configuration: MemoryInstance,
    path: PosixPath,
    data_directory: PosixPath,
}
impl LoadedMemoryInstance {
    /// Resolve config strictly, decode UTF8 universal newlines, then resolve
    /// data_dir optionally before the remaining schema checks. No mkdir/read
    /// of personal fallback data, DB opening, profile writing or import occurs.
    pub fn load(path: &Path) -> Result<Self, InstanceLoadError> {
        Self::load_in(path, None)
    }
    pub(crate) fn load_captured(path: &Path, home: &[u32]) -> Result<Self, InstanceLoadError> {
        Self::load_in(path, Some(home))
    }
    fn load_in(path: &Path, home: Option<&[u32]>) -> Result<Self, InstanceLoadError> {
        let path = expanded_with(&native::python_text(path), home)?;
        let path = absolute(path)?;
        let path = native::resolve_strict_text(&path.codepoints())?;
        let raw = read_text(&native::python_path(&path.codepoints())?)?;
        Self::parse_at(&raw, path, home)
    }
    fn parse_at(
        raw: &str,
        path: PosixPath,
        home: Option<&[u32]>,
    ) -> Result<Self, InstanceLoadError> {
        let raw = raw.replace("\r\n", "\n").replace('\r', "\n");
        let header = InstanceHeader::decode_json(&raw)?;
        let state = expanded_with(header.data_dir().codepoints(), home)?;
        let state = if state.is_absolute() {
            state
        } else {
            path.parent().join(&state)
        };
        let data_directory = native::resolve_optional_text(&state.codepoints())?;
        if path.parent() == data_directory || path.parent().is_relative_to(&data_directory) {
            return Err(InstanceLoadError::SeparateStateRequired);
        }
        let configuration = header.finish()?;
        Ok(Self {
            configuration,
            path,
            data_directory,
        })
    }
    pub fn configuration(&self) -> &MemoryInstance {
        &self.configuration
    }
    pub fn configuration_path(&self) -> &PosixPath {
        &self.path
    }
    pub fn data_directory(&self) -> &PosixPath {
        &self.data_directory
    }
    pub fn native_data_directory(&self) -> io::Result<PathBuf> {
        native::python_path(&self.data_directory.codepoints())
    }
}
fn read_text(path: &Path) -> Result<String, InstanceLoadError> {
    let mut file = fs::File::open(path)?;
    let mut text = String::new();
    let result = file
        .read_to_string(&mut text)
        .map(|_| text)
        .map_err(InstanceLoadError::Io);
    let closed = native::close(file).map_err(InstanceLoadError::Native);
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(InstanceLoadError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
fn absolute(path: PosixPath) -> io::Result<PosixPath> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(
        PosixPath::try_new(&native::python_text(&std::env::current_dir()?))
            .expect("filesystem codepoints")
            .join(&path),
    )
}
#[cfg(test)]
fn expanded(raw: &[u32]) -> io::Result<PosixPath> {
    expanded_with(raw, None)
}
fn expanded_with(raw: &[u32], home: Option<&[u32]>) -> io::Result<PosixPath> {
    let path = PosixPath::try_new(raw).expect("checked Python codepoints");
    let points = path.codepoints();
    if points.first() != Some(&126) {
        return Ok(path);
    }
    let end = points
        .iter()
        .position(|&cp| cp == 47)
        .unwrap_or(points.len());
    let user = &points[1..end];
    let home = if user.is_empty() {
        match home {
            Some(home) => home.to_vec(),
            None => match std::env::var_os("HOME") {
                Some(home) => native::python_text(Path::new(&home)),
                None => native::home_directory(None)?,
            },
        }
    } else {
        native::home_directory(Some(user))?
    };
    let home = PosixPath::try_new(&home).expect("filesystem home codepoints");
    Ok(if end == points.len() {
        home
    } else {
        home.join(&PosixPath::try_new(&points[end + 1..]).expect("checked suffix"))
    })
}
#[cfg(test)]
mod tests;
