//! `cleanup/collector_state.py` as data: the dedicated state path rule, the
//! ancestry it walks and the command's output text. The filesystem effects
//! live in `reverie-observations`. Paths are Python `str` code points.
use crate::legacy_json::Text;
use crate::worker_config::python_json_string;

/// The custody marker of a prepared collector state directory.
pub const MARKER: &[u8] = b"{\"application\":\"reverie-collect\",\"version\":1}\n";
/// The marker's file name inside the state directory.
pub const MARKER_NAME: &str = ".reverie-collector-state.json";

pub const NOT_ADMINISTRATOR: &str =
    "Collector service state requires ordinary host administrator activation";
pub const NOT_DEDICATED: &str = "A dedicated canonical state directory is required";
pub const UNSAFE_ANCESTRY: &str =
    "Collector state ancestry must be root-owned real directories, not writable by others";
pub const NOT_PRIVATE: &str =
    "Collector state must be private; existing directories are never chmodded or chowned";
pub const INVALID_MARKER: &str = "Collector state marker is invalid";
pub const FOREIGN_STATE: &str =
    "Refusing to adopt existing collector state without its custody marker";

const SLASH: u32 = '/' as u32;
const GENERIC: [&str; 9] = [
    "/",
    "/var",
    "/var/lib",
    "/etc",
    "/home",
    "/run",
    "/usr",
    "/nix",
    "/nix/store",
];

/// `Path(value)`: the root (`//` only for exactly two leading slashes) and
/// the parts without empty or `.` components.
fn split(points: &[u32]) -> (&'static [u32], Vec<&[u32]>) {
    let leading = points.iter().take_while(|point| **point == SLASH).count();
    let root: &'static [u32] = match leading {
        0 => &[],
        2 => &[SLASH, SLASH],
        _ => &[SLASH],
    };
    let parts = points
        .split(|point| *point == SLASH)
        .filter(|part| !part.is_empty() && *part != [u32::from('.')])
        .collect();
    (root, parts)
}

fn join(root: &[u32], parts: &[&[u32]]) -> Vec<u32> {
    let mut text = root.to_vec();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            text.push(SLASH);
        }
        text.extend_from_slice(part);
    }
    if text.is_empty() {
        text.push(u32::from('.'));
    }
    text
}

/// `prepare`'s path rule: absolute, no `..` (so `normpath` is unchanged), no
/// control characters and not a shared system directory. Returns
/// `str(Path(value))`.
pub fn dedicated_state_path(points: &[u32]) -> Result<Vec<u32>, &'static str> {
    let (root, parts) = split(points);
    let path = join(root, &parts);
    let parent = parts.iter().any(|part| *part == [u32::from('.'); 2]);
    let control = path.iter().any(|point| *point < 32 || *point == 127);
    let generic = GENERIC
        .iter()
        .any(|name| name.chars().map(u32::from).eq(path.iter().copied()));
    if root.is_empty() || parent || control || generic {
        return Err(NOT_DEDICATED);
    }
    Ok(path)
}

/// `[*reversed(path.parents), path]` for a dedicated path.
pub fn ancestry(path: &[u32]) -> Vec<Vec<u32>> {
    let (root, parts) = split(path);
    (0..=parts.len())
        .map(|length| join(root, &parts[..length]))
        .collect()
}

/// `path / MARKER_NAME`.
pub fn marker_path(path: &[u32]) -> Vec<u32> {
    let mut marker = path.to_vec();
    if marker.last() != Some(&SLASH) {
        marker.push(SLASH);
    }
    marker.extend(MARKER_NAME.chars().map(u32::from));
    marker
}

/// `json.dumps({'status': 'COLLECTOR_STATE_READY', 'state': path}, sort_keys=True)`.
pub fn ready(path: &[u32]) -> String {
    let mut line = String::from("{\"state\": ");
    python_json_string(&Text(path.to_vec()), &mut line);
    line.push_str(", \"status\": \"COLLECTOR_STATE_READY\"}");
    line
}

/// `str(OSError(errno, description, filename))`.
pub fn os_error(errno: i32, description: &str, filename: Option<&[u32]>) -> String {
    match filename {
        Some(name) => format!("[Errno {errno}] {description}: {}", repr(name)),
        None => format!("[Errno {errno}] {description}"),
    }
}

/// Python `repr(str)`. Characters outside ASCII are kept as printable except
/// C1 controls, U+00A0, U+00AD and surrogates (the undecodable path bytes);
/// other non-printable code points beyond Latin-1 are not distinguished.
pub(crate) fn repr(points: &[u32]) -> String {
    let quote = if points.contains(&u32::from('\'')) && !points.contains(&u32::from('"')) {
        '"'
    } else {
        '\''
    };
    let mut text = String::from(quote);
    for &point in points {
        match char::from_u32(point) {
            Some('\\') => text.push_str("\\\\"),
            Some('\t') => text.push_str("\\t"),
            Some('\n') => text.push_str("\\n"),
            Some('\r') => text.push_str("\\r"),
            Some(c) if c == quote => {
                text.push('\\');
                text.push(c);
            }
            Some(c @ ' '..='~') => text.push(c),
            Some(c)
                if (c as u32) < 0x20 || (0x7f..=0xa0).contains(&(c as u32)) || c == '\u{ad}' =>
            {
                text.push_str(&format!("\\x{:02x}", c as u32));
            }
            Some(c) => text.push(c),
            None => text.push_str(&format!("\\u{point:04x}")),
        }
    }
    text.push(quote);
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(text: &str) -> Vec<u32> {
        text.chars().map(u32::from).collect()
    }

    fn text(points: &[u32]) -> String {
        points
            .iter()
            .filter_map(|point| char::from_u32(*point))
            .collect()
    }

    #[test]
    fn dedicated_paths_normalize_like_pathlib_and_refuse_generic_or_parent_paths() {
        for (given, expected) in [
            ("/var/lib/reverie-collect", "/var/lib/reverie-collect"),
            ("/var//lib/./x/", "/var/lib/x"),
            ("///srv/x", "/srv/x"),
            ("//srv/x", "//srv/x"),
            ("//", "//"),
        ] {
            assert_eq!(
                dedicated_state_path(&points(given)).map(|p| text(&p)),
                Ok(expected.into())
            );
        }
        for refused in [
            "",
            "relative",
            "./x",
            "/",
            "///",
            "/var/lib",
            "/var/lib/",
            "/nix//store",
            "/etc",
            "/var/a/../b",
            "/..",
            "/x\u{1f}y",
            "/x\u{7f}",
        ] {
            assert_eq!(
                dedicated_state_path(&points(refused)),
                Err(NOT_DEDICATED),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn ancestry_lists_root_first_then_each_parent_then_the_path() {
        let chain = ancestry(&points("/var/lib/x"));
        let chain = chain.iter().map(|p| text(p)).collect::<Vec<_>>();
        assert_eq!(chain, ["/", "/var", "/var/lib", "/var/lib/x"]);
        let chain = ancestry(&points("//srv/x"));
        let chain = chain.iter().map(|p| text(p)).collect::<Vec<_>>();
        assert_eq!(chain, ["//", "//srv", "//srv/x"]);
        assert_eq!(
            text(&marker_path(&points("//"))),
            "//.reverie-collector-state.json"
        );
    }

    #[test]
    fn output_text_matches_json_dumps_and_oserror_str() {
        assert_eq!(
            ready(&points("/var/lib/r\u{e9}\u{1f600}")),
            "{\"state\": \"/var/lib/r\\u00e9\\ud83d\\ude00\", \"status\": \"COLLECTOR_STATE_READY\"}"
        );
        assert_eq!(
            ready(&[u32::from('/'), 0xdcff]),
            "{\"state\": \"/\\udcff\", \"status\": \"COLLECTOR_STATE_READY\"}"
        );
        assert_eq!(
            os_error(13, "Permission denied", Some(&points("/srv/it's"))),
            "[Errno 13] Permission denied: \"/srv/it's\""
        );
        assert_eq!(
            os_error(
                2,
                "No such file or directory",
                Some(&[u32::from('/'), 0x85, 0xdc80, 0xe9])
            ),
            "[Errno 2] No such file or directory: '/\\x85\\udc80\u{e9}'"
        );
        assert_eq!(
            os_error(5, "Input/output error", None),
            "[Errno 5] Input/output error"
        );
    }
}
