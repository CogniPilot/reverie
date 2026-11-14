use crate::{Arguments, Result, manifest, refused};
use reverie_elf_bundle::{
    ImageLayout, Libraries, Tools, copy, executable_machine, immutable_input, machine, readonly,
    require_static_elf64, tree,
};
use std::{fs, path::Path};

const LAYOUT: ImageLayout = ImageLayout::WorkerClient;
pub(crate) const PREFIX: &str = LAYOUT.prefix();
const MAX_SCRIPT_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) fn build(args: Arguments) -> Result<()> {
    // A pre-existing path is never an output scratch directory.
    if fs::symlink_metadata(&args.output).is_ok() {
        return Err(refused("a new capsule output path is required"));
    }
    let tools = Tools::new(&args.patchelf, &args.readelf)?;
    let node = immutable_input(&args.node)?;
    let architecture = executable_machine(&node)?;
    let native_entry = immutable_input(&args.entry)?;
    if executable_machine(&native_entry)? != architecture {
        return Err(refused(
            "same-architecture executable static entry required",
        ));
    }
    require_static_elf64(&fs::read(&native_entry)?, architecture)?;
    let bundle = immutable_input(&args.bundle)?;
    let hooks = immutable_input(&args.hooks)?;
    let legal = immutable_input(&args.legal)?;
    let closure = immutable_input(&args.closure)?;
    for file in [&bundle, &hooks, &legal] {
        if fs::metadata(file)?.len() > MAX_SCRIPT_BYTES {
            return Err(refused("bounded script/config build input required"));
        }
    }
    let script = fs::read_to_string(&bundle)?;
    if script.starts_with("#!") {
        return Err(refused("plain bundled JavaScript required"));
    }
    let hooks_data: serde_json::Value = serde_json::from_slice(&fs::read(&hooks)?)?;
    if !hooks_data.is_object() {
        return Err(refused("hook settings object required"));
    }
    let notices = args.notices.canonicalize()?;
    if !notices.starts_with("/nix/store") || !notices.is_dir() {
        return Err(refused("immutable notice directory required"));
    }
    let mut libraries = Libraries::new(&closure)?;
    libraries.include(&node, &tools)?;
    for library in libraries.selected().values() {
        if machine(library)? != Some(architecture) {
            return Err(refused("same-architecture client closure required"));
        }
    }
    let loader = tools
        .interpreter(&node)?
        .ok_or_else(|| refused("dynamic Node interpreter required"))?;
    let loader_name = Path::new(&loader)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| refused("loader basename required"))?;
    fs::create_dir(&args.output)?;
    let target = args.output.join(PREFIX.trim_start_matches('/'));
    fs::create_dir_all(target.join("bin"))?;
    fs::create_dir(target.join("lib"))?;
    LAYOUT.install_libraries(&libraries, &target, loader_name, &tools)?;
    let installed_node = target.join("bin/node");
    copy(&node, &installed_node)?;
    LAYOUT.relocate(&installed_node, loader_name, &tools)?;
    let entry = target.join("bin/reverie.mjs");
    fs::write(&entry, script)?;
    copy(&native_entry, &target.join("bin/reverie"))?;
    copy(&hooks, &target.join("claude-hooks.json"))?;
    copy(&legal, &target.join("bin/agent.mjs.LEGAL.txt"))?;
    tree(&notices, &target.join("notices"))?;
    manifest::write(&target)?;
    readonly(&args.output)
}
