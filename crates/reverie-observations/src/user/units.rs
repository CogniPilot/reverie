//! The fixed USER units, their registration record and the recognition of
//! units installed by the previous Python command.
pub(crate) const UNIT: &str = "reverie-observations";

/// `quote(s)`: a systemd-quoted word with `\`, `"`, `%` and `$` escaped.
fn quote(word: &str) -> String {
    let escaped = word
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

/// The inverse of `quote` for one word; `None` if it is not a quoted word.
fn unquote(word: &str) -> Option<String> {
    let inner = word.strip_prefix('"')?.strip_suffix('"')?;
    let mut text = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => text.push(chars.next().filter(|next| matches!(next, '\\' | '"'))?),
            '%' | '$' => {
                if chars.next() != Some(c) {
                    return None;
                }
                text.push(c);
            }
            '"' => return None,
            c => text.push(c),
        }
    }
    Some(text)
}

/// The words of a command line `unit_text` wrote: `quote`d words separated
/// by single spaces. A quoted word may itself contain spaces.
fn words(line: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut rest = line;
    loop {
        let mut escaped = false;
        let (end, _) = rest.strip_prefix('"')?.char_indices().find(|&(_, c)| {
            let close = !escaped && c == '"';
            escaped = !escaped && c == '\\';
            close
        })?;
        // The opening quote, `end` bytes of body and the closing quote.
        let (word, tail) = rest.split_at(end + 2);
        words.push(unquote(word)?);
        if tail.is_empty() {
            return Some(words);
        }
        rest = tail.strip_prefix(' ')?;
    }
}

/// `unit_text(path, cfg)` for an `ExecStart` command line: (service, timer).
pub fn unit_text(exec: &[&str], state_directory: &str, interval: i64) -> (String, String) {
    let command = exec
        .iter()
        .map(|word| quote(word))
        .collect::<Vec<_>>()
        .join(" ");
    let service = [
        "[Unit]".to_owned(),
        "Description=Reverie user resource observations (no effect authority)".into(),
        "[Service]".into(),
        "Type=oneshot".into(),
        "UMask=0077".into(),
        format!("ExecStart={command}"),
        "TimeoutStartSec=90".into(),
        "TimeoutStopSec=5".into(),
        "MemoryMax=256M".into(),
        "MemorySwapMax=0".into(),
        "TasksMax=32".into(),
        "CPUQuota=50%".into(),
        "NoNewPrivileges=yes".into(),
        "Nice=19".into(),
        "MemoryAccounting=yes".into(),
        "TasksAccounting=yes".into(),
        "CPUAccounting=yes".into(),
        "KillMode=control-group".into(),
        "SendSIGKILL=yes".into(),
        "ProtectSystem=strict".into(),
        format!("ReadWritePaths={}", quote(state_directory)),
        String::new(),
    ]
    .join("\n");
    let timer = [
        "[Unit]".to_owned(),
        "Description=Reverie periodic user observations".into(),
        "[Timer]".into(),
        format!("OnBootSec={interval}"),
        format!("OnUnitActiveSec={interval}"),
        "AccuracySec=5s".into(),
        "Persistent=false".into(),
        format!("Unit={UNIT}.service"),
        "[Install]".into(),
        "WantedBy=timers.target".into(),
        String::new(),
    ]
    .join("\n");
    (service, timer)
}

/// `/nix/store/<name>/<rest>` with a single non-empty store name.
fn store_path(path: &str, rest: impl Fn(&str) -> bool) -> bool {
    path.strip_prefix("/nix/store/")
        .and_then(|tail| tail.split_once('/'))
        .is_some_and(|(name, tail)| !name.is_empty() && !name.contains("..") && rest(tail))
}

/// Whether `(service, timer)` are exactly the units the previous Python
/// command generated for this configuration: its template with a packaged
/// `bin/python3*` and `libexec/reverie/collector_user.py`, byte for byte.
pub(crate) fn previous_release(
    service: &str,
    timer: &str,
    config: &str,
    state_directory: &str,
    interval: i64,
) -> bool {
    let Some(line) = service
        .lines()
        .find_map(|line| line.strip_prefix("ExecStart="))
    else {
        return false;
    };
    let Some(words) = words(line) else {
        return false;
    };
    let [python, isolated, bytecode, entry, flag, path, action] = &words[..] else {
        return false;
    };
    let packaged_python = store_path(python, |rest| {
        rest.strip_prefix("bin/python3").is_some_and(|version| {
            version.is_empty()
                || version.strip_prefix('.').is_some_and(|minor| {
                    !minor.is_empty() && minor.bytes().all(|byte| byte.is_ascii_digit())
                })
        })
    });
    let packaged_entry = store_path(entry, |rest| rest == "libexec/reverie/collector_user.py");
    if !packaged_python
        || !packaged_entry
        || (isolated, bytecode, flag, path, action)
            != (
                &"-I".into(),
                &"-B".into(),
                &"--config".into(),
                &config.to_owned(),
                &"sample".into(),
            )
    {
        return false;
    }
    let exec = [
        python.as_str(),
        "-I",
        "-B",
        entry.as_str(),
        "--config",
        config,
        "sample",
    ];
    unit_text(&exec, state_directory, interval) == (service.to_owned(), timer.to_owned())
}

/// The registration record for the units' sha256 hex digests:
/// `json.dumps(record, sort_keys=True) + "\n"`.
pub fn registration(config: &str, service: &str, timer: &str) -> String {
    use reverie_contracts::collector::{Out, dump};
    let digest = Out::text;
    let record = Out::map([
        ("version", Out::int(1)),
        ("purpose", Out::text("reverie-user-observations-units")),
        ("config", Out::text(config)),
        (
            "units",
            Out::map([("service", digest(service)), ("timer", digest(timer))]),
        ),
    ]);
    // sort_keys with the default ", " and ": " separators.
    let compact = dump(&record).unwrap_or_default();
    spaced(&compact) + "\n"
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Default `json.dumps` separators for a compact dump without spaces in
/// strings other than escaped ones: `,` → `, ` and `:` → `: ` outside strings.
fn spaced(compact: &str) -> String {
    let mut text = String::new();
    let mut in_string = false;
    let mut escaped = false;
    for c in compact.chars() {
        text.push(c);
        if in_string {
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
        } else {
            match c {
                '"' => in_string = true,
                ',' | ':' => text.push(' '),
                _ => {}
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "/home/owner/reverie/resource-history/config.json";
    const STATE: &str = "/home/owner/reverie/resource-history/history";
    const PYTHON: &str = "/nix/store/aaaa-python3-3.13.15/bin/python3";
    const ENTRY: &str =
        "/nix/store/bbbb-reverie-cleanup-observations/libexec/reverie/collector_user.py";

    #[test]
    fn quote_round_trips_systemd_specials() {
        for word in ["/plain", "/with space", "/a\"b\\c%d$e"] {
            assert_eq!(unquote(&quote(word)).as_deref(), Some(word));
        }
        assert_eq!(quote("50%$"), "\"50%%$$\"");
        let line = ["/with space", "/a\"b\\c%d$e", "\\", "plain"]
            .map(quote)
            .join(" ");
        assert_eq!(
            words(&line).unwrap(),
            ["/with space", "/a\"b\\c%d$e", "\\", "plain"]
        );
        for bad in ["", "\"a\"  \"b\"", "\"a\"\"b\"", "\"a\" ", "a", "\"a\\\""] {
            assert_eq!(words(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn previous_release_units_are_recognized_only_byte_for_byte() {
        let (service, timer) = unit_text(
            &[PYTHON, "-I", "-B", ENTRY, "--config", CONFIG, "sample"],
            STATE,
            300,
        );
        assert!(previous_release(&service, &timer, CONFIG, STATE, 300));
        for config in [
            "/home/o/with space/config.json",
            "/home/o/\"q\" 50%$\\/c.json",
        ] {
            let (service, timer) = unit_text(
                &[PYTHON, "-I", "-B", ENTRY, "--config", config, "sample"],
                "/home/o/with space/history",
                300,
            );
            assert!(
                previous_release(&service, &timer, config, "/home/o/with space/history", 300),
                "{config}"
            );
        }
        assert!(
            !previous_release(&service, &timer, CONFIG, STATE, 600),
            "timer interval"
        );
        assert!(!previous_release(
            &format!("{service}# edited\n"),
            &timer,
            CONFIG,
            STATE,
            300
        ));
        let other = service.replace("collector_user.py", "other.py");
        assert!(!previous_release(&other, &timer, CONFIG, STATE, 300));
        let unpackaged = service.replace("/nix/store/aaaa-python3-3.13.15", "/usr");
        assert!(!previous_release(&unpackaged, &timer, CONFIG, STATE, 300));
        let (native, native_timer) = unit_text(
            &[
                "/nix/store/cccc/bin/reverie-observations",
                "--config",
                CONFIG,
                "sample",
            ],
            STATE,
            300,
        );
        assert!(!previous_release(
            &native,
            &native_timer,
            CONFIG,
            STATE,
            300
        ));
    }

    #[test]
    fn registration_matches_json_dumps_sort_keys() {
        let record = registration("/c, d: \"e\"", "s", "t");
        assert_eq!(
            record,
            "{\"config\": \"/c, d: \\\"e\\\"\", \"purpose\": \"reverie-user-observations-units\", \"units\": {\"service\": \"s\", \"timer\": \"t\"}, \"version\": 1}\n"
        );
    }
}
