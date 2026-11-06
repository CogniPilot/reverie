//! `GET /api/subscription-profiles` after TS authorized it: `readSubscriptionProfiles()` plus each
//! profile's modes, as the TS route answers. Read-only; it never opens credential contents.
use crate::node_path::{join, resolve};
use reverie_contracts::subscription_profiles_v1::{
    self as v1, JsString, MAX_FILE_BYTES, Platform, Profile, Provider, Refusal, Request, Response,
};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::PathBuf;

const FILE: &str = "subscription-profiles.json";
const ACCOUNT_DIRS: [(Provider, &str); 2] = [
    (Provider::Anthropic, ".claude-accounts"),
    (Provider::Openai, ".codex-accounts"),
];

/// Only Node `path.posix` semantics are implemented; a win32 front gets a refusal, never different paths.
pub fn get(request: &Request) -> Result<Response, Refusal> {
    if !cfg!(unix) || Platform::from_node(&request.platform) != Platform::Posix {
        return Err(Refusal::Platform);
    }
    let host = Host { cwd: &request.cwd };
    let profiles = match host.read(&join(&[&request.data_dir, FILE]))? {
        Contents::Found(raw) => match v1::parse_file(&raw, Platform::Posix) {
            Ok(profiles) => profiles,
            Err(v1::InvalidFile) => return Ok(v1::invalid_file()),
        },
        Contents::Missing => discover(request, &host),
        Contents::Failed => return Ok(v1::invalid_file()),
    };
    v1::profiles_response(&profiles, &request.modes_by_provider)
}

/// The ENOENT branch: default logins with a credential file, then sorted account folders.
fn discover(request: &Request, host: &Host<'_>) -> Vec<Profile> {
    let home = request.home.as_str();
    let env = &request.env;
    let data_dir = set_or(&env.xdg_data_home, || join(&[home, ".local/share"]));
    let defaults = [
        (
            Provider::Anthropic,
            "anthropic-default",
            "Default Claude",
            &env.claude_config_dir,
            ".claude",
        ),
        (
            Provider::Openai,
            "openai-default",
            "Default Codex",
            &env.codex_home,
            ".codex",
        ),
    ];
    let mut profiles = Vec::new();
    let mut seen = HashSet::new();
    for (provider, id, label, configured, fallback) in defaults {
        let config_dir = set_or(configured, || join(&[home, fallback]));
        if !host.has_credential(&config_dir, provider) {
            continue;
        }
        let real = host
            .realpath(&config_dir)
            .unwrap_or_else(|| resolve(&request.cwd, &config_dir));
        seen.insert(format!("{}:{real}", provider.as_str()));
        // Built-in defaults are returned without the schema parse, as in TS.
        profiles.push(profile(id, label, provider, &config_dir, &data_dir));
    }
    for (provider, directory) in ACCOUNT_DIRS {
        let base = join(&[home, directory]);
        for name in host.account_names(&base) {
            let config_dir = join(&[&base, &name]);
            if !host.has_credential(&config_dir, provider) {
                continue;
            }
            let Some(real) = host.realpath(&config_dir) else {
                continue;
            };
            // TS records the directory before its schema parse, so a refused account still claims it.
            if !seen.insert(format!("{}:{real}", provider.as_str())) {
                continue;
            }
            let id = account_id(provider, &name);
            let parsed =
                profile(&id, &name, provider, &config_dir, &data_dir).checked(Platform::Posix);
            profiles.extend(parsed);
        }
    }
    profiles
}

fn profile(id: &str, label: &str, provider: Provider, config_dir: &str, data_dir: &str) -> Profile {
    Profile {
        id: JsString::from(id),
        label: JsString::from(label),
        provider,
        config_dir: JsString::from(config_dir),
        open_code_data_dir: JsString::from(data_dir),
    }
}

/// `` `acct-${provider}-${name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-') `` for an ASCII name.
fn account_id(provider: Provider, name: &str) -> String {
    format!("acct-{}-{name}", provider.as_str())
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// `process.env.X || fallback`: an empty value counts as unset.
fn set_or(value: &Option<String>, fallback: impl FnOnce() -> String) -> String {
    value
        .as_deref()
        .filter(|value| !value.is_empty())
        .map_or_else(fallback, str::to_owned)
}

/// `^[A-Za-z0-9._-]{1,48}$`.
fn account_name(name: &str) -> bool {
    (1..=48).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

enum Contents {
    Found(Vec<u8>),
    Missing,
    Failed,
}

/// The TS process's view of the filesystem: a relative path is resolved by the kernel against TS's cwd.
struct Host<'a> {
    cwd: &'a str,
}
impl Host<'_> {
    fn path(&self, path: &str) -> Option<PathBuf> {
        match path {
            "" => None,
            absolute if absolute.starts_with('/') => Some(PathBuf::from(absolute)),
            relative => Some(PathBuf::from(format!("{}/{relative}", self.cwd))),
        }
    }
    /// `fs.readFile`: only ENOENT selects discovery; every other error is the invalid-file reply.
    fn read(&self, path: &str) -> Result<Contents, Refusal> {
        let Some(path) = self.path(path) else {
            return Ok(Contents::Missing);
        };
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Contents::Missing),
            Err(_) => return Ok(Contents::Failed),
        };
        let mut raw = Vec::new();
        let limit = u64::try_from(MAX_FILE_BYTES).map_or(u64::MAX, |bytes| bytes + 1);
        if file.take(limit).read_to_end(&mut raw).is_err() {
            return Ok(Contents::Failed);
        }
        if raw.len() > MAX_FILE_BYTES {
            return Err(Refusal::FileBound);
        }
        Ok(Contents::Found(raw))
    }
    /// `fs.stat(join(configDir, credential))` is a non-empty file. Symlinks are followed, as stat does.
    fn has_credential(&self, config_dir: &str, provider: Provider) -> bool {
        self.path(&join(&[config_dir, provider.credential_file()]))
            .and_then(|path| fs::metadata(path).ok())
            .is_some_and(|stat| stat.is_file() && stat.len() > 0)
    }
    /// `fs.realpath` as a UTF-8 string, which Node decodes with replacement characters.
    fn realpath(&self, path: &str) -> Option<String> {
        let real = fs::canonicalize(self.path(path)?).ok()?;
        Some(real.to_string_lossy().into_owned())
    }
    /// `fs.readdir(base).catch(() => [])`, sorted, keeping only valid account names. Sorting the ASCII
    /// survivors by byte equals the JS default sort, which compares UTF-16 code units.
    fn account_names(&self, base: &str) -> Vec<String> {
        let Some(entries) = self.path(base).and_then(|path| fs::read_dir(path).ok()) else {
            return Vec::new();
        };
        let Ok(entries) = entries.collect::<Result<Vec<_>, _>>() else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .into_iter()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| account_name(name))
            .collect();
        names.sort_unstable();
        names
    }
}
