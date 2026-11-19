use super::Result;
use nix::fcntl::{Flock, FlockArg};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

const RULES: &str = include_str!("../../opencode-assets/rules.md");
const PLUGIN: &str = include_str!("../../opencode-assets/plugins/reverie.mjs");
const INTERACTION: &str = include_str!("../../opencode-assets/plugins/interaction.mjs");
const INTERACTION_PLUGIN: &str =
    include_str!("../../opencode-assets/plugins/interaction-plugin.mjs");
const SKILLS: [(&str, &str); 4] = [
    (
        "reverie",
        include_str!("../../opencode-assets/skills/reverie/SKILL.md"),
    ),
    (
        "reverie-context",
        include_str!("../../opencode-assets/skills/reverie-context/SKILL.md"),
    ),
    (
        "reverie-memory",
        include_str!("../../opencode-assets/skills/reverie-memory/SKILL.md"),
    ),
    (
        "reverie-runtime",
        include_str!("../../opencode-assets/skills/reverie-runtime/SKILL.md"),
    ),
];
const BEGIN: &str = "<!-- reverie:begin -->";
const END: &str = "<!-- reverie:end -->";
const MARKER: &str = ".reverie-instance";
const CONFIGURATION: &str = "opencode.json";
const INTERACTION_POLICY: &str = ".opencode/interaction-policy.json";
const MAX_TEXT: u64 = 4 * 1024 * 1024;
const NO_FOLLOW: i32 = nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK;

pub(super) struct Workspace {
    root: PathBuf,
    _lock: Flock<File>,
}

impl Workspace {
    pub(super) fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        check_workspace(&root)?;
        ensure_directory(&root, Path::new(".opencode"))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(NO_FOLLOW)
            .open(root.join(".opencode/install.lock"))?;
        if !lock.metadata()?.is_file() {
            return Err("invalid OpenCode installation lock".into());
        }
        let _lock = Flock::lock(lock, FlockArg::LockExclusiveNonblock)
            .map_err(|(_, error)| io::Error::from(error))?;
        check_workspace(&root)?;
        Ok(Self { root, _lock })
    }

    pub(super) fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn install(
        &self,
        configuration: Value,
        marker: Value,
        role: &str,
        instance: Option<&str>,
    ) -> Result<()> {
        let managed = file_metadata(&self.root.join(MARKER))?.is_some();
        let mut outputs = self.files(role, instance)?;
        outputs.push((MARKER.to_owned(), json_text(&marker)?));
        outputs.push((CONFIGURATION.to_owned(), json_text(&configuration)?));
        for (relative, _) in &outputs {
            let path = Path::new(relative);
            ensure_directory(&self.root, path.parent().expect("relative file"))?;
            file_metadata(&self.root.join(path))?;
        }
        let obsolete = self.root.join(".opencode/plugins/reverie.mjs");
        let remove_obsolete = managed && file_metadata(&obsolete)?.is_some();
        for (relative, text) in outputs {
            replace(&self.root.join(relative), &text)?;
        }
        if remove_obsolete {
            fs::remove_file(obsolete)?;
        }
        Ok(())
    }

    fn files(&self, role: &str, instance: Option<&str>) -> Result<Vec<(String, String)>> {
        let mut output = vec![
            (".opencode/plugins/reverie.js".into(), PLUGIN.into()),
            (".opencode/lib/interaction.mjs".into(), INTERACTION.into()),
            (
                ".opencode/plugins/zz-interaction.js".into(),
                INTERACTION_PLUGIN
                    .replace("from './interaction.mjs'", "from '../lib/interaction.mjs'"),
            ),
            ("REVERIE_RULES.md".into(), RULES.into()),
            (
                ".opencode/package.json".into(),
                json_text(&json!({
                    "private":true, "type":"module", "dependencies":{"@opencode-ai/plugin":"1.15.10"},
                }))?,
            ),
        ];
        if let Some(policy) = self.interaction_policy(role)? {
            output.push((INTERACTION_POLICY.into(), policy));
        }
        for (name, text) in SKILLS {
            for tool in [".agents", ".claude", ".opencode"] {
                output.push((format!("{tool}/skills/{name}/SKILL.md"), text.into()));
            }
        }
        if let Some(path) = instance {
            let instructions = instructions(path);
            for file in ["AGENTS.md", "CLAUDE.md"] {
                let previous = read_text(&self.root.join(file))?.unwrap_or_default();
                output.push((file.into(), update_instructions(previous, &instructions)));
            }
        }
        Ok(output)
    }

    fn interaction_policy(&self, role: &str) -> Result<Option<String>> {
        let path = self.root.join(INTERACTION_POLICY);
        let mut previous = match read_text(&path)? {
            Some(text) => serde_json::from_str::<Value>(&text)?,
            None => {
                return Ok(Some(json_text(&json!({
                    "enabled":true, "role":role, "max_continuations":3, "coding_window_ms":600000,
                    "cooldown_ms":10000, "coding_agent":"coding",
                }))?));
            }
        };
        if let Some(policy) = previous.as_object_mut()
            && !policy.contains_key("coding_agent")
        {
            policy.insert("coding_agent".into(), json!("coding"));
            return Ok(Some(json_text(&previous)?));
        }
        Ok(None)
    }
}

fn check_workspace(root: &Path) -> Result<()> {
    if root.parent().is_none() || exists(&root.join(".git"))? {
        return Err("install into a dedicated runtime workspace, separate from the shareable source checkout".into());
    }
    if file_metadata(&root.join(CONFIGURATION))?.is_some()
        && file_metadata(&root.join(MARKER))?.is_none()
    {
        return Err("workspace already has an unmanaged opencode.json".into());
    }
    Ok(())
}

fn exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn ensure_directory(root: &Path, relative: &Path) -> Result<()> {
    let mut path = root.to_owned();
    for part in relative {
        path.push(part);
        if !exists(&path)? {
            fs::create_dir(&path)?;
        }
        if !fs::symlink_metadata(&path)?.is_dir() {
            return Err("OpenCode installation requires real workspace directories".into());
        }
    }
    Ok(())
}

fn file_metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_file() => Ok(Some(info)),
        Ok(_) => Err("OpenCode installation requires regular workspace files".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_text(path: &Path) -> Result<Option<String>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(NO_FOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !file.metadata()?.is_file() {
        return Err("OpenCode installation requires regular workspace files".into());
    }
    let mut text = String::new();
    if file.take(MAX_TEXT + 1).read_to_string(&mut text)? as u64 > MAX_TEXT {
        return Err("OpenCode installation input exceeds the file limit".into());
    }
    Ok(Some(text))
}

fn replace(path: &Path, text: &str) -> Result<()> {
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce)
        .map_err(|_| io::Error::other("installation randomness unavailable"))?;
    let temporary = path.with_file_name(format!(
        ".reverie-install-{:032x}",
        u128::from_be_bytes(nonce)
    ));
    let mode = file_metadata(path)?.map_or(0o600, |info| info.permissions().mode() & 0o777);
    let mut staged = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(NO_FOLLOW)
        .open(&temporary)?;
    let result = (|| {
        staged.set_permissions(fs::Permissions::from_mode(mode))?;
        staged.write_all(text.as_bytes())?;
        staged.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn json_text(value: &Value) -> Result<String> {
    Ok(serde_json::to_string_pretty(value)? + "\n")
}

pub(crate) fn rules() -> &'static str {
    RULES
}

fn instructions(path: &str) -> String {
    let path = shell_quote(path);
    format!(
        concat!(
            "{}\n",
            "This workspace runs one configured persistent agent. The OpenCode plugin automatically loads identity and ",
            "bounded context; do not run this command again there. In other harnesses, before taking work load identity, ",
            "current values, lifecycle mode, durable plan and context with:\n\n```bash\n",
            "reverie-context --instance {} --channel work\n```\n\n",
            "Read the reverie-memory skill for explicit scoped long-term lookup, and reverie-runtime for ",
            "model changes. Use reverie-context for task-specific context. ",
            "Select the actual model context/output limits when available. Shared-channel ",
            "context is the default. Load private context only in an actual private conversation. ",
            "Preserve the same instance across provider changes. Weight training is disabled.\n",
            "{}\n",
        ),
        BEGIN, path, END
    )
}

fn shell_quote(path: &str) -> String {
    if path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&b))
    {
        path.into()
    } else {
        format!("'{}'", path.replace('\'', "'\"'\"'"))
    }
}

fn update_instructions(mut previous: String, instructions: &str) -> String {
    if let Some(begin) = previous.find(BEGIN)
        && let Some(end) = previous[begin..].find(END)
    {
        previous.replace_range(begin..begin + end + END.len(), "");
    }
    format!("{}\n\n{instructions}", previous.trim_end())
}
