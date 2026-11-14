//! Closed image layouts share the existing loader/dependency relocation rules.
use crate::{Libraries, Result, Tools, copy, refused};
use std::{fs, path::Path};

#[derive(Clone, Copy)]
pub enum ImageLayout {
    Memory,
    Perf,
    Idmap,
    WorkerClient,
    WorkerTools,
}
impl ImageLayout {
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Memory => "/opt/reverie/memory",
            Self::Perf => "/opt/reverie/perf",
            Self::Idmap => "/opt/reverie-idmap",
            Self::WorkerClient => "/opt/reverie-worker-client",
            Self::WorkerTools => "/opt/reverie-worker-tools",
        }
    }
    pub const fn absent_fallback(self) -> &'static str {
        match self {
            Self::Memory => "/opt/rvmem/",
            Self::Perf => "/opt/rvprf/",
            Self::Idmap => "/opt/idmap/",
            Self::WorkerClient => "/opt/rvwrk/",
            Self::WorkerTools => "/opt/rvtls/",
        }
    }
    pub const fn absent_preload(self) -> &'static str {
        match self {
            Self::Memory => "/opt/rvmem/preload.off",
            Self::Perf => "/opt/rvprf/preload.off",
            // Preserve the existing ID-map builder's system-preload behavior.
            Self::Idmap => "/etc/ld-nix.so.preload",
            Self::WorkerClient => "/opt/rvwrk/preload.off",
            Self::WorkerTools => "/opt/rvtls/preload.off",
        }
    }
    pub fn install_libraries(
        self,
        libraries: &Libraries,
        target: &Path,
        loader: &str,
        tools: &Tools,
    ) -> Result<()> {
        for (name, source) in libraries.selected() {
            let destination = target.join("lib").join(name);
            copy(source, &destination)?;
            self.install_library(&destination, name == loader, loader, tools)?;
        }
        Ok(())
    }
    fn install_library(
        self,
        destination: &Path,
        is_loader: bool,
        loader: &str,
        tools: &Tools,
    ) -> Result<()> {
        if !is_loader {
            return self.relocate(destination, loader, tools);
        }
        if !tools.patch(&["--print-needed"], destination)?.is_empty() {
            return Err(refused("dependency-free loader required"));
        }
        self.freeze_fallback(destination)
    }
    pub fn relocate(self, path: &Path, loader: &str, tools: &Tools) -> Result<()> {
        if tools.dynamic(path)? {
            let origin = tools
                .patch(&["--print-rpath"], path)?
                .split(':')
                .filter(|value| {
                    !matches!(self, Self::Idmap)
                        && (value.starts_with("$ORIGIN") || value.starts_with("${ORIGIN}"))
                })
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let rpath = std::iter::once(format!("{}/lib", self.prefix()))
                .chain(origin)
                .collect::<Vec<_>>()
                .join(":");
            tools.patch(&["--set-rpath", &rpath, "--no-default-lib"], path)?;
            replace_needed(path, tools)?;
            if tools.interpreter(path)?.is_some() {
                tools.patch(
                    &[
                        "--set-interpreter",
                        &format!("{}/lib/{loader}", self.prefix()),
                    ],
                    path,
                )?;
            }
        }
        self.freeze_fallback(path)
    }
    fn freeze_fallback(self, path: &Path) -> Result<()> {
        let mut bytes = fs::read(path)?;
        for (original, absent) in [
            (b"/nix/store/".as_slice(), self.absent_fallback().as_bytes()),
            (
                b"/etc/ld-nix.so.preload".as_slice(),
                self.absent_preload().as_bytes(),
            ),
        ] {
            if original.len() != absent.len() {
                return Err(refused("optional-loader replacement must keep byte length"));
            }
            replace_bytes(&mut bytes, original, absent);
        }
        fs::write(path, bytes)?;
        Ok(())
    }
}
fn replace_needed(path: &Path, tools: &Tools) -> Result<()> {
    for needed in tools.patch(&["--print-needed"], path)?.lines() {
        if needed.contains('/') {
            let basename = Path::new(needed)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or_else(|| refused("dependency basename required"))?;
            tools.patch(&["--replace-needed", needed, basename], path)?;
        }
    }
    Ok(())
}
fn replace_bytes(bytes: &mut [u8], original: &[u8], absent: &[u8]) {
    let mut cursor = 0;
    while cursor + original.len() <= bytes.len() {
        if bytes[cursor..].starts_with(original) {
            bytes[cursor..cursor + original.len()].copy_from_slice(absent);
            cursor += original.len();
        } else {
            cursor += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_tools_layout_is_fixed_and_loader_replacements_keep_lengths() {
        let layout = ImageLayout::WorkerTools;
        assert_eq!(layout.prefix(), "/opt/reverie-worker-tools");
        assert_eq!(layout.absent_fallback().len(), b"/nix/store/".len());
        assert_eq!(
            layout.absent_preload().len(),
            b"/etc/ld-nix.so.preload".len()
        );
        assert_ne!(layout.prefix(), ImageLayout::WorkerClient.prefix());
    }
}
