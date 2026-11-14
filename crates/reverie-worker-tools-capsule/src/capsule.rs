use crate::{Arguments, Result, manifest, refused};
use reverie_elf_bundle::{
    ImageLayout, Libraries, Tools, copy, executable_machine, immutable_input, machine, readonly,
    tree,
};
use std::{fs, path::Path};

const LAYOUT: ImageLayout = ImageLayout::WorkerTools;
pub(crate) const PREFIX: &str = LAYOUT.prefix();

fn directory(path: &Path) -> Result<std::path::PathBuf> {
    let real = path.canonicalize()?;
    if !path.is_absolute() || !real.starts_with("/nix/store") || !real.is_dir() {
        return Err(refused("immutable build input directory required"));
    }
    Ok(real)
}
pub(crate) fn build(args: Arguments) -> Result<()> {
    if fs::symlink_metadata(&args.output).is_ok() {
        return Err(refused("a new capsule output path is required"));
    }
    let tmux = immutable_input(&args.tmux)?;
    let closure = immutable_input(&args.closure)?;
    let terminfo = directory(&args.terminfo)?;
    let notices = directory(&args.notices)?;
    let architecture = executable_machine(&tmux)?;
    let tools = Tools::new(&args.patchelf, &args.readelf)?;
    let mut libraries = Libraries::new(&closure)?;
    libraries.include(&tmux, &tools)?;
    for library in libraries.selected().values() {
        if machine(library)? != Some(architecture) {
            return Err(refused("same-architecture worker tool closure required"));
        }
    }
    let loader = tools
        .interpreter(&tmux)?
        .ok_or_else(|| refused("dynamic tmux interpreter required"))?;
    let loader_name = Path::new(&loader)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| refused("loader basename required"))?;
    fs::create_dir(&args.output)?;
    let target = args.output.join(PREFIX.trim_start_matches('/'));
    fs::create_dir_all(target.join("bin"))?;
    fs::create_dir(target.join("lib"))?;
    fs::create_dir(target.join("share"))?;
    LAYOUT.install_libraries(&libraries, &target, loader_name, &tools)?;
    let installed = target.join("bin/tmux");
    copy(&tmux, &installed)?;
    LAYOUT.relocate(&installed, loader_name, &tools)?;
    tree(&terminfo, &target.join("share/terminfo"))?;
    tree(&notices, &target.join("notices"))?;
    manifest::write(&target)?;
    readonly(&args.output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "worker-tools-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn args(root: &Path, output: PathBuf) -> Arguments {
        Arguments {
            tmux: root.join("mutable-tmux"),
            closure: root.join("closure"),
            terminfo: root.join("terminfo"),
            notices: root.join("notices"),
            patchelf: root.join("patchelf"),
            readelf: root.join("readelf"),
            output,
        }
    }
    #[test]
    fn existing_output_is_not_overwritten_or_reinterpreted() {
        let root = Scratch::new();
        let output = root.0.join("output");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("sentinel"), b"owned previous output").unwrap();
        assert!(
            build(args(&root.0, output.clone()))
                .unwrap_err()
                .to_string()
                .contains("new capsule")
        );
        assert_eq!(
            fs::read(output.join("sentinel")).unwrap(),
            b"owned previous output"
        );
    }
    #[test]
    fn mutable_tmux_is_refused_before_any_output_is_created() {
        let root = Scratch::new();
        fs::write(root.0.join("mutable-tmux"), b"not an immutable ELF").unwrap();
        let output = root.0.join("output");
        assert!(
            build(args(&root.0, output.clone()))
                .unwrap_err()
                .to_string()
                .contains("fixed Nix")
        );
        assert!(!output.exists());
    }
}
