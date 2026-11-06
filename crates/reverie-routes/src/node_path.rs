//! Node `path.posix` string semantics, so built paths and printed paths equal the TS server's.

/// `path.join`: non-empty parts joined with `/`, then normalized.
pub(crate) fn join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .copied()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return ".".to_owned();
    }
    let absolute = joined.starts_with('/');
    let mut body = segments(&joined, !absolute);
    if body.is_empty() {
        return if absolute {
            "/".to_owned()
        } else if joined.ends_with('/') {
            "./".to_owned()
        } else {
            ".".to_owned()
        };
    }
    if joined.ends_with('/') {
        body.push('/');
    }
    if absolute { format!("/{body}") } else { body }
}

/// `path.resolve(path)` with `process.cwd()` equal to `cwd`.
pub(crate) fn resolve(cwd: &str, path: &str) -> String {
    let combined = match path {
        "" => cwd.to_owned(),
        absolute if absolute.starts_with('/') => absolute.to_owned(),
        relative => format!("{cwd}/{relative}"),
    };
    let absolute = combined.starts_with('/');
    let body = segments(&combined, !absolute);
    if absolute {
        format!("/{body}")
    } else if body.is_empty() {
        ".".to_owned()
    } else {
        body
    }
}

/// Node `normalizeString`: drops empty and `.` segments and folds `..` into its parent.
fn segments(path: &str, above_root: bool) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." if kept.last().is_some_and(|last| *last != "..") => {
                kept.pop();
            }
            ".." if !above_root => {}
            other => kept.push(other),
        }
    }
    kept.join("/")
}

#[cfg(test)]
mod tests {
    use super::{join, resolve};

    #[test]
    fn join_matches_node_posix() {
        for (parts, expected) in [
            (&["/home/a/", ".claude"][..], "/home/a/.claude"),
            (&["/x//y/", ".credentials.json"], "/x/y/.credentials.json"),
            (&["", ".claude"], ".claude"),
            (&["", ""], "."),
            (&["./rel/../rel/codex", "auth.json"], "rel/codex/auth.json"),
            (&["../a", "../../b"], "../../b"),
            (&["/", ".."], "/"),
            (&["a", "..", ".."], ".."),
            (&["a/", "b/"], "a/b/"),
            (&["a", ".."], "."),
            (&["a/", ".."], "."),
            (&["a", "./"], "a/"),
            (&["a/..", "/"], "./"),
            (&["/a/b", "../"], "/a/"),
            (&["..", "/"], "../"),
            (&["/a", "..."], "/a/..."),
        ] {
            assert_eq!(join(parts), expected, "{parts:?}");
        }
    }

    #[test]
    fn resolve_matches_node_posix() {
        for (cwd, path, expected) in [
            ("/w", "rel/claude", "/w/rel/claude"),
            ("/w", "/abs//x/", "/abs/x"),
            ("/w", "", "/w"),
            ("/w", "../../..", "/"),
            ("/", "a/./b/../c", "/a/c"),
        ] {
            assert_eq!(resolve(cwd, path), expected, "{cwd} {path}");
        }
    }
}
