//! Retirement closure: a removed Python module must not stay selected.
//! Every `[project.scripts]` console command and every Nix reference to a
//! Python source file or `-m`/quoted `reverie.*` module must name a module
//! that still exists, so deleting a script also removes its registrations.

use crate::support::workspace_root;
use std::fs;
use std::path::Path;

fn module_exists(root: &Path, module: &str) -> bool {
    let relative = module.replace('.', "/");
    let base = root.join("python").join(relative);
    base.with_extension("py").is_file() || base.join("__init__.py").is_file()
}

fn console_modules(pyproject: &str) -> Vec<String> {
    let mut in_scripts = false;
    let mut modules = Vec::new();
    for line in pyproject.lines().map(str::trim) {
        if line.starts_with('[') {
            in_scripts = line == "[project.scripts]";
            continue;
        }
        let target = line
            .split_once('=')
            .map(|(_, target)| target.trim().trim_matches('"'));
        if let Some(module) = target
            .filter(|_| in_scripts)
            .and_then(|target| target.split(':').next())
        {
            modules.push(module.to_owned());
        }
    }
    modules
}

/// Maximal `[A-Za-z0-9_./]` runs that start with `prefix`, with the byte
/// that follows each run (`None` at the end of the text).
fn tokens<'a>(text: &'a str, prefix: &str) -> Vec<(&'a str, Option<u8>)> {
    let word = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/');
    let mut found = Vec::new();
    let mut start = 0;
    while let Some(at) = text[start..].find(prefix) {
        let begin = start + at;
        let body = begin + prefix.len();
        let end = text[body..]
            .bytes()
            .position(|byte| !word(byte))
            .map_or(text.len(), |length| body + length);
        found.push((&text[begin..end], text.as_bytes().get(end).copied()));
        start = end.max(begin + 1);
    }
    found
}

fn nix_problems(root: &Path, name: &str, text: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let paths = tokens(text, "python/reverie/")
        .into_iter()
        .map(|(path, _)| path);
    for path in paths.filter(|path| path.ends_with(".py")) {
        if !root.join(path).is_file() {
            problems.push(format!("{name}: references missing {path}"));
        }
    }
    for marker in ["-m reverie.", "'reverie.", "\"reverie."] {
        let skip = marker.len() - "reverie.".len();
        let quote = marker.as_bytes()[0];
        // A quoted name is a module only when its own quote closes it (not a
        // label such as "reverie.worker.nix-store"); `-m` ends at a separator.
        let closed = |next: Option<u8>| match quote {
            b'-' => next.is_none_or(|byte| {
                byte.is_ascii_whitespace() || matches!(byte, b'\'' | b'"' | b';')
            }),
            _ => next == Some(quote),
        };
        for (token, _) in tokens(text, marker)
            .into_iter()
            .filter(|(_, next)| closed(*next))
        {
            let module = token[skip..].trim_end_matches('.');
            if !module_exists(root, module) {
                problems.push(format!("{name}: selects missing module {module}"));
            }
        }
    }
    problems
}

fn closure_problems(root: &Path) -> Vec<String> {
    let mut problems = Vec::new();
    let pyproject = fs::read_to_string(root.join("python/pyproject.toml")).unwrap_or_default();
    for module in console_modules(&pyproject) {
        if !module_exists(root, &module) {
            problems.push(format!(
                "python/pyproject.toml: console command selects missing module {module}"
            ));
        }
    }
    let mut nix = vec![root.join("flake.nix")];
    if let Ok(entries) = fs::read_dir(root.join("nix")) {
        nix.extend(entries.filter_map(Result::ok).map(|entry| entry.path()));
    }
    nix.sort();
    for path in nix
        .iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "nix"))
    {
        let name = path
            .strip_prefix(root)
            .unwrap_or(path)
            .display()
            .to_string();
        problems.extend(nix_problems(
            root,
            &name,
            &fs::read_to_string(path).unwrap_or_default(),
        ));
    }
    problems
}

#[test]
fn removed_python_modules_have_no_remaining_registrations() {
    let problems = closure_problems(&workspace_root());
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn closure_rules_reject_dangling_registrations() {
    let pyproject = "[project]\nname = \"x\"\n[project.scripts]\nreverie-a = \"reverie.a:main\"\n\n[tool.x]\nb = \"c:d\"\n";
    assert_eq!(console_modules(pyproject), ["reverie.a"]);
    let root = workspace_root();
    let problems = nix_problems(
        &root,
        "fixture.nix",
        "cp ${src}/python/reverie/absent_module.py $out/libexec/reverie/x.py; python3 -m reverie.absent_module; \
         if module not in ('reverie.worker','reverie.absent_two'): \"reverie.worker.nix-store\" = 1;",
    );
    assert_eq!(
        problems,
        [
            "fixture.nix: references missing python/reverie/absent_module.py",
            "fixture.nix: selects missing module reverie.absent_module",
            "fixture.nix: selects missing module reverie.absent_two",
        ]
    );
}
