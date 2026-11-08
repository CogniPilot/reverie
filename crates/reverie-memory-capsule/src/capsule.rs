use crate::{Arguments, Result, execution, files, refused};
use reverie_elf_bundle::{Libraries, Tools, immutable_input};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const PREFIX: &str = "/opt/reverie/memory";
// Equal-length compiled optional-loader paths become an immutable absent slot.
// Actual interpreter/DT_NEEDED/RPATH entries are changed by maintained patchelf.
const ABSENT: &[u8] = b"/opt/rvmem/";
const SYSTEM_PRELOAD: &[u8] = b"/etc/ld-nix.so.preload";
const ABSENT_PRELOAD: &[u8] = b"/opt/rvmem/preload.off";

pub(crate) fn build(args: Arguments) -> Result<()> {
    let tools = Tools::new(&args.patchelf, &args.readelf)?;
    let node = immutable_input(&args.node)?;
    let architecture = files::machine(&node)?.ok_or_else(|| refused("Node ELF required"))?;
    let console = args.console.canonicalize()?;
    if !console.starts_with("/nix/store") || !console.is_dir() {
        return Err(refused("immutable Console package directory required"));
    }
    fs::create_dir(&args.output)?;
    let target = args.output.join(PREFIX.trim_start_matches('/'));
    fs::create_dir_all(target.join("bin"))?;
    fs::create_dir(target.join("lib"))?;
    let notices = args.notices.canonicalize()?;
    if !notices.starts_with("/nix/store") {
        return Err(refused("immutable notice bundle required"));
    }
    files::tree(&notices, &target.join("notices"))?;
    let mut modules = files::tree(&console, &target.join("console"))?;
    let mut roots = vec![(node, target.join("bin/node"))];
    let roles = module_roots(&console, &target, &modules, architecture, &mut roots)?;
    let mut libraries = Libraries::new(&args.closure)?;
    for (source, _) in &roots {
        libraries.include(source, &tools)?;
    }
    let loader = tools
        .interpreter(&roots[0].0)?
        .ok_or_else(|| refused("dynamic Node interpreter required"))?;
    let loader_name = Path::new(&loader)
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| refused("loader basename required"))?;
    install_libraries(&libraries, &target, loader_name, &tools)?;
    for (source, destination) in &roots {
        files::copy(source, destination)?;
        relocate(destination, loader_name, &tools)?;
    }
    for (source, name) in [(&args.memory, "reverie-memory"), (&args.mcp, "reverie-mcp")] {
        let source = immutable_input(source)?;
        if files::machine(&source)? != Some(architecture)
            || tools.dynamic(&source)? && !tools.patch(&["--print-needed"], &source)?.is_empty()
            || tools.interpreter(&source)?.is_some()
        {
            return Err(refused("static same-architecture native entry required"));
        }
        files::copy(&source, &target.join("bin").join(name))?;
    }
    modules.extend(
        overlay(&args.modules, &target.join("console/dist"))?
            .into_iter()
            .map(|name| Path::new("dist").join(name)),
    );
    modules.sort();
    modules.dedup();
    let relocated = roots
        .iter()
        .map(|(_, path)| path.strip_prefix(&target).map(Path::to_owned))
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    write_module_inventory(&console, &target, &modules, &relocated, &roles)?;
    write_origin_inventory(&args, &target, &libraries, &roots)?;
    files::readonly(&args.output)
}

fn module_roots(
    console: &Path,
    target: &Path,
    modules: &[PathBuf],
    architecture: u16,
    roots: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<BTreeMap<PathBuf, execution::Role>> {
    let mut roles = BTreeMap::new();
    for relative in modules {
        let source = console.join(relative);
        if let Some(machine) = files::machine(&source)? {
            let role = execution::classify(relative, machine, architecture)?;
            if role == execution::Role::RequiredNodeAddon {
                roots.push((source, target.join("console").join(relative)));
            }
            roles.insert(relative.clone(), role);
        }
    }
    if !roles.contains_key(Path::new(execution::NODE_PTY)) {
        return Err(refused("required node-pty addon missing from Console"));
    }
    Ok(roles)
}

fn write_module_inventory(
    console: &Path,
    target: &Path,
    modules: &[std::path::PathBuf],
    relocated: &BTreeSet<std::path::PathBuf>,
    roles: &BTreeMap<PathBuf, execution::Role>,
) -> Result<()> {
    let mut inventory = Vec::new();
    for relative in modules {
        let path = Path::new("console").join(relative);
        let input_sha256 = console
            .join(relative)
            .is_file()
            .then(|| files::digest(&console.join(relative)))
            .transpose()?;
        let sha256 = files::digest(&target.join(&path))?;
        let changed = input_sha256.as_ref() != Some(&sha256);
        let role = roles.get(relative).copied();
        if role.is_some_and(|role| role != execution::Role::RequiredNodeAddon) && changed {
            return Err(refused("unselected native asset bytes changed"));
        }
        inventory.push(files::Entry {
            path: path.to_string_lossy().into_owned(),
            input_sha256,
            sha256,
            machine: files::machine(&target.join(&path))?,
            treatment: if let Some(role) = role {
                role.label()
            } else if relocated.contains(&path) {
                "relocated-linux-elf"
            } else if changed {
                "compiled-guest-module-composition"
            } else {
                "preserved-module-or-inert-platform-asset"
            }
            .to_owned(),
        });
    }
    fs::write(
        target.join("module-inventory.json"),
        serde_json::to_vec_pretty(&inventory)?,
    )?;
    Ok(())
}

fn write_origin_inventory(
    args: &Arguments,
    target: &Path,
    libraries: &Libraries,
    roots: &[(std::path::PathBuf, std::path::PathBuf)],
) -> Result<()> {
    let mut artifacts = Vec::new();
    for (source, destination) in roots {
        artifacts.push(serde_json::json!({
            "input": source, "inputSha256": files::digest(source)?,
            "output": destination.strip_prefix(target)?, "sha256": files::digest(destination)?,
        }));
    }
    for (name, source) in libraries.selected() {
        artifacts.push(serde_json::json!({
            "input": source, "inputSha256": files::digest(source)?,
            "output": format!("lib/{name}"), "sha256": files::digest(&target.join("lib").join(name))?,
        }));
    }
    for (source, name) in [(&args.memory, "reverie-memory"), (&args.mcp, "reverie-mcp")] {
        artifacts.push(serde_json::json!({
            "input": source, "inputSha256": files::digest(source)?,
            "output": format!("bin/{name}"), "sha256": files::digest(&target.join("bin").join(name))?,
        }));
    }
    let value = serde_json::json!({
        "schema": "reverie-memory-guest-capsule-build-v1",
        "purpose": "unselected-image-data-no-grant-or-attestation",
        "prefix": PREFIX,
        "absentFallback": std::str::from_utf8(ABSENT)?,
        "absentSystemPreload": std::str::from_utf8(ABSENT_PRELOAD)?,
        "executionPurpose": "memory/MCP/fixed journal; complete assets retained, not general Console/web/render/browser execution",
        "console": args.console, "node": args.node,
        "consoleIndexSha256": files::digest(&args.console.join("dist/index.js"))?,
        "closureInputSha256": files::digest(&args.closure)?,
        "compiledModuleInput": args.modules,
        "elfArtifacts": artifacts,
    });
    fs::write(
        target.join("build-inputs.json"),
        serde_json::to_vec_pretty(&value)?,
    )?;
    Ok(())
}

fn install_libraries(
    libraries: &Libraries,
    target: &Path,
    loader: &str,
    tools: &Tools,
) -> Result<()> {
    for (name, source) in libraries.selected() {
        let destination = target.join("lib").join(name);
        files::copy(source, &destination)?;
        if name == loader {
            if !tools.patch(&["--print-needed"], &destination)?.is_empty() {
                return Err(refused("dependency-free loader required"));
            }
            absent_fallback(&destination)?;
        } else {
            relocate(&destination, loader, tools)?;
        }
    }
    Ok(())
}

fn relocate(path: &Path, loader: &str, tools: &Tools) -> Result<()> {
    if tools.dynamic(path)? {
        let origin = tools
            .patch(&["--print-rpath"], path)?
            .split(':')
            .filter(|value| value.starts_with("$ORIGIN") || value.starts_with("${ORIGIN}"))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let rpath = std::iter::once(format!("{PREFIX}/lib"))
            .chain(origin)
            .collect::<Vec<_>>()
            .join(":");
        tools.patch(&["--set-rpath", &rpath, "--no-default-lib"], path)?;
        for needed in tools.patch(&["--print-needed"], path)?.lines() {
            if needed.contains('/') {
                let basename = Path::new(needed)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| refused("dependency basename required"))?;
                tools.patch(&["--replace-needed", needed, basename], path)?;
            }
        }
        if tools.interpreter(path)?.is_some() {
            tools.patch(
                &["--set-interpreter", &format!("{PREFIX}/lib/{loader}")],
                path,
            )?;
        }
    }
    absent_fallback(path)
}

fn absent_fallback(path: &Path) -> Result<()> {
    let mut bytes = fs::read(path)?;
    for (original, absent) in [
        (b"/nix/store/".as_slice(), ABSENT),
        (SYSTEM_PRELOAD, ABSENT_PRELOAD),
    ] {
        if original.len() != absent.len() {
            return Err(refused("optional-loader replacement must keep byte length"));
        }
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
    fs::write(path, bytes)?;
    Ok(())
}

fn overlay(source: &Path, target: &Path) -> Result<Vec<&'static str>> {
    let source = source.canonicalize()?;
    if !source.starts_with("/nix/store") {
        return Err(refused(
            "compiled guest modules must be immutable build inputs",
        ));
    }
    // These are separate TSC modules in the qualified Console, never bundle text.
    let names = vec![
        "installed-memory-bridge.js",
        "installed-memory-bridge.js.map",
        "installed-memory-bridge.d.ts",
        "installed-memory-bridge.d.ts.map",
        "installed-memory-origin.js",
        "installed-memory-guest-origin.js",
        "installed-memory-guest-origin.js.map",
        "installed-memory-guest-origin.d.ts",
        "installed-memory-guest-origin.d.ts.map",
    ];
    for name in &names {
        let input = immutable_input(&source.join(name))?;
        files::copy(&input, &target.join(name))?;
    }
    Ok(names)
}
