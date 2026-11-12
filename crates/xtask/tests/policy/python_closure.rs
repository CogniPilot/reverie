//! Retirement closure: a removed Python module must not stay selected.
//! Every `[project.scripts]` console command and every Nix reference to a
//! Python source file or `-m`/quoted `reverie.*` module value must name a
//! module that still exists. Quoted Nix attribute keys are not module values.

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

/// Maximal `[A-Za-z0-9_./]` runs that start with `prefix`, with the source
/// suffix that follows each run.
fn tokens<'a>(text: &'a str, prefix: &str) -> Vec<(&'a str, &'a str)> {
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
        found.push((&text[begin..end], &text[end..]));
        start = end.max(begin + 1);
    }
    found
}

/// A quoted attribute key is followed by a Nix assignment, allowing Nix
/// whitespace/comments. Equality expressions still contain module values.
fn attribute_assignment(mut suffix: &str) -> bool {
    loop {
        suffix = suffix.trim_start();
        if let Some(comment) = suffix.strip_prefix('#') {
            suffix = comment.split_once('\n').map_or("", |(_, rest)| rest);
        } else if let Some(comment) = suffix.strip_prefix("/*") {
            let Some((_, rest)) = comment.split_once("*/") else {
                return false;
            };
            suffix = rest;
        } else {
            return suffix.starts_with('=') && !suffix.starts_with("==");
        }
    }
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
        // Quoted module values close with their own quote; keys and partial
        // names such as "reverie.worker.nix-store" are not module selections.
        // Explicit `-m` execution remains checked independently of Nix keys.
        let selected = |suffix: &str| match quote {
            b'-' => suffix.bytes().next().is_none_or(|byte| {
                byte.is_ascii_whitespace() || matches!(byte, b'\'' | b'"' | b';')
            }),
            _ => {
                suffix.as_bytes().first() == Some(&quote)
                    && (quote != b'"' || !attribute_assignment(&suffix[1..]))
            }
        };
        for (token, _) in tokens(text, marker)
            .into_iter()
            .filter(|(_, suffix)| selected(suffix))
        {
            let module = token[skip..].trim_end_matches('.');
            if !module_exists(root, module) {
                problems.push(format!("{name}: selects missing module {module}"));
            }
        }
    }
    problems
}

#[test]
fn quoted_nix_attribute_keys_are_not_python_module_selections() {
    let problems = nix_problems(
        &workspace_root(),
        "fixture.nix",
        r#"Labels = {
          "reverie.purpose" = "reverie-worker-viewer-v1";
          "reverie.future.label" /* packaging metadata */
            # The key and its assignment can span lines.
            = "metadata";
        };"#,
    );
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn attribute_keys_do_not_hide_quoted_module_values_or_execution() {
    let problems = nix_problems(
        &workspace_root(),
        "fixture.nix",
        r#""reverie.label" = "reverie.absent_value";
           if module == "reverie.absent_comparison": pass
           if "reverie.absent_left" == module: pass
           if "reverie.absent_comment" # a comparison, not an attribute
               == module: pass
           if module in ('reverie.absent_allowlist',): pass
           'reverie.absent_single_quote' = invalid;
           python3 -m reverie.absent_execution;
           python3 -m reverie.absent_assignment = value;"#,
    );
    assert_eq!(
        problems,
        [
            "fixture.nix: selects missing module reverie.absent_execution",
            "fixture.nix: selects missing module reverie.absent_assignment",
            "fixture.nix: selects missing module reverie.absent_allowlist",
            "fixture.nix: selects missing module reverie.absent_single_quote",
            "fixture.nix: selects missing module reverie.absent_value",
            "fixture.nix: selects missing module reverie.absent_comparison",
            "fixture.nix: selects missing module reverie.absent_left",
            "fixture.nix: selects missing module reverie.absent_comment",
        ]
    );
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
