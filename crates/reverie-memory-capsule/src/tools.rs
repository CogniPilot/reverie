use crate::{Result, refused};
use std::{path::Path, process::Command};

pub(crate) struct Tools {
    pub(crate) patchelf: std::path::PathBuf,
    pub(crate) readelf: std::path::PathBuf,
}
impl Tools {
    pub(crate) fn new(patchelf: &Path, readelf: &Path) -> Result<Self> {
        Ok(Self {
            patchelf: immutable_input(patchelf)?,
            readelf: immutable_input(readelf)?,
        })
    }
    pub(crate) fn patch(&self, args: &[&str], file: &Path) -> Result<String> {
        let output = Command::new(&self.patchelf).args(args).arg(file).output()?;
        if !output.status.success() {
            return Err(refused(&format!(
                "patchelf refused {}: {}",
                file.display(),
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(String::from_utf8(output.stdout)?.trim().to_owned())
    }
    pub(crate) fn dynamic(&self, file: &Path) -> Result<bool> {
        let output = Command::new(&self.readelf)
            .args(["--program-headers", "--wide"])
            .arg(file)
            .output()?;
        if !output.status.success() {
            return Err(refused("readelf refused an ELF input"));
        }
        Ok(String::from_utf8(output.stdout)?
            .lines()
            .any(|line| line.trim_start().starts_with("DYNAMIC ")))
    }
    pub(crate) fn interpreter(&self, file: &Path) -> Result<Option<String>> {
        let output = Command::new(&self.readelf)
            .args(["--program-headers", "--wide"])
            .arg(file)
            .output()?;
        if !output.status.success() {
            return Err(refused("readelf refused interpreter inspection"));
        }
        let text = String::from_utf8(output.stdout)?;
        Ok(text.lines().find_map(|line| {
            line.split_once("[Requesting program interpreter: ")
                .and_then(|(_, value)| value.strip_suffix(']'))
                .map(str::to_owned)
        }))
    }
}

pub(crate) fn immutable_input(path: &Path) -> Result<std::path::PathBuf> {
    let real = path.canonicalize()?;
    if !path.is_absolute() || !real.starts_with("/nix/store") || !real.is_file() {
        return Err(refused("a fixed Nix build input file is required"));
    }
    Ok(real)
}
