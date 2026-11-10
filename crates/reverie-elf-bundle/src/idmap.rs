//! Build-only, fixed two-helper closure. No helper is executed, no UID/GID map
//! is written and no setid mode or file capability is granted by this producer.
use crate::{
    ImageLayout, Libraries, Result, Tools, copy, executable_machine, immutable_input, machine,
    readonly, refused,
};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
const HELPERS: [&str; 2] = ["newuidmap", "newgidmap"];
const LAYOUT: ImageLayout = ImageLayout::Idmap;
const README: &str =
    "Image-only immutable ID helper closure. No writable Nix loader/library fallback.\n";

struct Roots {
    files: [PathBuf; 2],
    identity: (u16, u8),
    loader: String,
}
impl Roots {
    fn capture(shadow: &Path, tools: &Tools) -> Result<Self> {
        let files = HELPERS.map(|name| immutable_input(&shadow.join("bin").join(name)));
        let [uid, gid] = files;
        let files = [uid?, gid?];
        let expected = identity(&files[0])?;
        let mut loaders = BTreeSet::new();
        for file in &files {
            if executable_machine(file)? != expected.0
                || identity(file)? != expected
                || fs::metadata(file)?.mode() & 0o6000 != 0
            {
                return Err(refused(
                    "same-architecture non-setid ID-map helper required",
                ));
            }
            let interpreter = tools
                .interpreter(file)?
                .ok_or_else(|| refused("dynamic ID-map helper required"))?;
            immutable_input(Path::new(&interpreter))?;
            loaders.insert(basename(Path::new(&interpreter))?.to_owned());
        }
        if loaders.len() != 1 {
            return Err(refused("one architecture interpreter required"));
        }
        Ok(Self {
            files,
            identity: expected,
            loader: loaders.into_iter().next().expect("one checked loader"),
        })
    }
}
/// Assemble only the fixed ID-map helpers from declared Nix build inputs.
/// Output contents are image DATA, not installation or privilege authority.
pub fn build_idmap(shadow: &Path, output: &Path, closure: &Path, tools: &Tools) -> Result<()> {
    let roots = Roots::capture(shadow, tools)?;
    let mut libraries = Libraries::new(&immutable_input(closure)?)?;
    for file in &roots.files {
        libraries.include(file, tools)?;
    }
    for file in libraries.selected().values() {
        if identity(file)? != roots.identity {
            return Err(refused(
                "ID-map library or loader ELF architecture/class differs",
            ));
        }
    }
    if !libraries.selected().contains_key(&roots.loader) {
        return Err(refused("ID-map loader missing from closure"));
    }
    fs::create_dir(output)?;
    let target = output.join(LAYOUT.prefix().trim_start_matches('/'));
    fs::create_dir_all(target.join("bin"))?;
    fs::create_dir(target.join("lib"))?;
    LAYOUT.install_libraries(&libraries, &target, &roots.loader, tools)?;
    for (index, name) in HELPERS.iter().enumerate() {
        let destination = target.join("bin").join(name);
        copy(&roots.files[index], &destination)?;
        LAYOUT.relocate(&destination, &roots.loader, tools)?;
    }
    verify_outputs(&target, &roots, &libraries, tools)?;
    fs::write(target.join("README"), README)?;
    readonly(output)
}
fn verify_outputs(
    target: &Path,
    roots: &Roots,
    libraries: &Libraries,
    tools: &Tools,
) -> Result<()> {
    for (directory, names) in [
        (
            "bin",
            HELPERS.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>(),
        ),
        (
            "lib",
            libraries.selected().keys().cloned().collect::<Vec<_>>(),
        ),
    ] {
        for name in names {
            let path = target.join(directory).join(&name);
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || identity(&path)? != roots.identity
            {
                return Err(refused("regular same-architecture ID-map output required"));
            }
            let is_loader = directory == "lib" && name == roots.loader;
            verify_linkage(&path, is_loader, &roots.loader, libraries, tools)?;
            if fs::read(&path)?
                .windows(b"/nix/store/".len())
                .any(|v| v == b"/nix/store/")
            {
                return Err(refused("original Nix fallback retained in ID-map output"));
            }
            fs::set_permissions(path, fs::Permissions::from_mode(0o555))?;
        }
    }
    Ok(())
}
fn verify_linkage(
    path: &Path,
    is_loader: bool,
    loader: &str,
    libraries: &Libraries,
    tools: &Tools,
) -> Result<()> {
    let needed = tools.patch(&["--print-needed"], path)?;
    if is_loader && !needed.is_empty() {
        return Err(refused("dependency-free ID-map loader required"));
    }
    for dependency in needed.lines() {
        if dependency.contains('/') || !libraries.selected().contains_key(dependency) {
            return Err(refused("unclosed ID-map ELF dependency"));
        }
    }
    if let Some(interpreter) = tools.interpreter(path)?
        && interpreter != format!("{}/lib/{loader}", LAYOUT.prefix())
    {
        return Err(refused("ID-map interpreter escapes fixed image prefix"));
    }
    if !is_loader && tools.patch(&["--print-rpath"], path)? != format!("{}/lib", LAYOUT.prefix()) {
        return Err(refused("ID-map search path escapes fixed image prefix"));
    }
    Ok(())
}
fn identity(path: &Path) -> Result<(u16, u8)> {
    let machine = machine(path)?.ok_or_else(|| refused("ID-map ELF input required"))?;
    let mut prefix = [0; 6];
    fs::File::open(path)?.read_exact(&mut prefix)?;
    if !matches!(prefix[4], 1 | 2) {
        return Err(refused("ID-map ELF class required"));
    }
    Ok((machine, prefix[4]))
}
fn basename(path: &Path) -> Result<&str> {
    path.file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| refused("UTF-8 ID-map loader basename required"))
}
