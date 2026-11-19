use std::collections::BTreeSet;

pub(crate) type Allowlist = BTreeSet<(String, String)>;

const THIRD_PARTY: &[&str] = &[
    "usr/",
    "bin/",
    "sbin/",
    "lib/",
    "lib64/",
    "var/lib/dpkg/",
    "var/lib/apt/",
    "var/cache/",
    "opt/yarn-",
    "opt/reverie/python/lib/",
    "opt/reverie/apps/web/node_modules/",
    "nix/store/",
];

const OWNED_NIX: &[&str] = &[
    "reverie-nix-store-prepare",
    "reverie-laptop-base",
    "reverie-start",
    "reverie-runtime",
    "reverie-launcher",
    "reverie-lock-tools",
    "reverie-install-clis",
    "reverie-install-clis.mjs",
    "reverie-request-update",
    "reverie-kokoro",
    "reverie-model-relay",
    "reverie-model-relay.mjs",
    "reverie-hands",
    "reverie-worker-exec",
    "reverie-worker-child",
    "reverie-office-relay",
    "reverie-browser-runtime",
    "reverie-browser-gpu-probe",
    "reverie-browser-gpu-probe.mjs",
];

pub(crate) fn allowlist(text: &str) -> Allowlist {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.split_once('\t').unwrap_or((line, "")))
        .map(|(path, detector)| {
            (
                path.trim().trim_start_matches('/').into(),
                detector.trim().into(),
            )
        })
        .collect()
}

pub(crate) fn mount_point(path: &str) -> bool {
    ["instances/", "workspace/", "scratch/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

pub(crate) fn instance_file(path: &str) -> bool {
    let name = leaf(path);
    matches!(
        name,
        "memory.sqlite"
            | "memory.sqlite-wal"
            | "memory.sqlite-shm"
            | "chatrooms.json"
            | "identities.json"
            | "instance.json"
            | "company.json"
            | "standing-policy.json"
            | "review.json"
            | ".git-credentials"
            | ".netrc"
            | "id_rsa"
            | "id_ecdsa"
            | "id_ed25519"
            | "credentials.json"
            | "auth.json"
            | ".credentials.json"
            | ".env"
    ) || name
        .strip_suffix(".token")
        .is_some_and(|base| !base.is_empty())
        || dotenv_variant(name)
}

fn dotenv_variant(name: &str) -> bool {
    name.strip_prefix(".env.").is_some_and(|suffix| {
        !suffix.is_empty() && !matches!(suffix, "example" | "sample" | "template")
    })
}

pub(crate) fn leaf(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

pub(crate) fn path(text: &str) -> &str {
    text.strip_prefix("./")
        .unwrap_or(text)
        .trim_start_matches('/')
}

pub(crate) fn link_target(path: &str, target: &str, relative_to_parent: bool) -> String {
    let mut components = Vec::new();
    if relative_to_parent && !target.starts_with('/') {
        let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
        normalize(parent, &mut components);
    }
    normalize(target, &mut components);
    components.join("/")
}

fn normalize<'a>(path: &'a str, components: &mut Vec<&'a str>) {
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            _ => components.push(part),
        }
    }
}

fn version(text: &str) -> bool {
    text.contains('.') && text.split('.').all(digits)
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn versioned(package: &str, name: &str) -> bool {
    package.strip_prefix(name).is_some_and(version)
}

fn nix_path(path: &str) -> Option<(&str, &str)> {
    let suffix = path.strip_prefix("nix/store/")?;
    let (name, relative) = suffix.split_once('/').unwrap_or((suffix, ""));
    let (hash, package) = name.split_once('-')?;
    let alphabet = b"0123456789abcdfghijklmnpqrsvwxyz";
    (hash.len() == 32 && hash.bytes().all(|byte| alphabet.contains(&byte)))
        .then_some((package, relative))
}

fn owned_nix(package: &str, relative: &str) -> bool {
    if versioned(package, "reverie-console-") {
        return relative != "lib/reverie/node_modules"
            && !relative.starts_with("lib/reverie/node_modules/");
    }
    let memory = package
        .strip_prefix("python3.")
        .and_then(|name| name.strip_suffix("-reverie-memory-0.1.0"))
        .is_some_and(digits);
    memory
        || OWNED_NIX.contains(&package)
        || versioned(package, "reverie-")
        || versioned(package, "reverie-backend-cli-")
}

pub(crate) fn third_party(path: &str) -> Option<&'static str> {
    if path.starts_with("usr/local/bin/")
        || nix_path(path).is_some_and(|(package, relative)| owned_nix(package, relative))
    {
        return None;
    }
    THIRD_PARTY
        .iter()
        .copied()
        .find(|prefix| path.starts_with(prefix))
}
