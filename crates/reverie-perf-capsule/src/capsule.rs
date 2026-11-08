use crate::{Arguments, Result, refused};
use reverie_elf_bundle::{
    ImageLayout, Libraries, Tools, copy, digest, immutable_input, machine, readonly, tree,
};
use std::{fs, path::Path};

const LAYOUT: ImageLayout = ImageLayout::Perf;

pub(crate) fn build(args: Arguments) -> Result<()> {
    let tools = Tools::new(&args.patchelf, &args.readelf)?;
    let perf = immutable_input(&args.perf)?;
    let checker = immutable_input(&args.checker)?;
    let closure = immutable_input(&args.closure)?;
    let architecture = machine(&perf)?.ok_or_else(|| refused("actual perf ELF required"))?;
    if machine(&checker)? != Some(architecture)
        || tools.interpreter(&checker)?.is_some()
        || tools.dynamic(&checker)? && !tools.patch(&["--print-needed"], &checker)?.is_empty()
    {
        return Err(refused("static same-architecture Rust checker required"));
    }
    let interpreter = tools
        .interpreter(&perf)?
        .ok_or_else(|| refused("dynamic perf ELF interpreter required"))?;
    let loader = Path::new(&interpreter)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| refused("loader basename required"))?;
    let notices = args.notices.canonicalize()?;
    if !notices.starts_with("/nix/store") || !notices.is_dir() {
        return Err(refused("immutable upstream notice directory required"));
    }
    let mut libraries = Libraries::new(&closure)?;
    libraries.include(&perf, &tools)?;
    for source in libraries.selected().values() {
        if machine(source)? != Some(architecture) {
            return Err(refused("all perf dependencies must share its architecture"));
        }
    }
    fs::create_dir(&args.output)?;
    let target = args.output.join(LAYOUT.prefix().trim_start_matches('/'));
    fs::create_dir_all(target.join("bin"))?;
    fs::create_dir(target.join("lib"))?;
    let notice_files = tree(&notices, &target.join("notices"))?;
    LAYOUT.install_libraries(&libraries, &target, loader, &tools)?;
    copy(&perf, &target.join("bin/perf"))?;
    LAYOUT.relocate(&target.join("bin/perf"), loader, &tools)?;
    copy(&checker, &target.join("bin/reverie-perf-check"))?;
    let mut artifacts = vec![
        artifact(&perf, &target, Path::new("bin/perf"))?,
        artifact(&checker, &target, Path::new("bin/reverie-perf-check"))?,
    ];
    for (name, source) in libraries.selected() {
        artifacts.push(artifact(source, &target, &Path::new("lib").join(name))?);
    }
    for name in notice_files {
        artifacts.push(artifact(
            &notices.join(&name),
            &target,
            &Path::new("notices").join(name),
        )?);
    }
    let inventory = serde_json::json!({
        "schema": "reverie-perf-guest-capsule-build-v1",
        "purpose": "unselected-image-data-no-grant-or-attestation",
        "prefix": LAYOUT.prefix(),
        "absentFallback": LAYOUT.absent_fallback(),
        "absentSystemPreload": LAYOUT.absent_preload(),
        "closureInputSha256": digest(&closure)?,
        "artifacts": artifacts,
    });
    fs::write(
        target.join("build-inputs.json"),
        serde_json::to_vec_pretty(&inventory)?,
    )?;
    readonly(&args.output)
}

#[derive(serde::Serialize)]
struct Artifact {
    input: std::path::PathBuf,
    input_sha256: String,
    output: std::path::PathBuf,
    sha256: String,
}
fn artifact(input: &Path, root: &Path, relative: &Path) -> Result<Artifact> {
    Ok(Artifact {
        input: input.to_owned(),
        input_sha256: digest(input)?,
        output: relative.to_owned(),
        sha256: digest(&root.join(relative))?,
    })
}
