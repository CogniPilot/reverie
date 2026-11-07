//! Native laptop development environment cache and argv0 launcher.
//! This is an owner-selected local development tool, not a host deployment API.
mod cache;
mod launcher;
use clap::{Parser, Subcommand};
use reverie_contracts::{autoenv::AutoenvApproval, autoenv_environment::AutoenvEnvironment};
use reverie_core::{PythonText, PythonTextRef, posix_text};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Command,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Parser)]
#[command(
    name = "reverie-autoenv",
    version,
    about = "Cache an owner-approved Nix development environment for laptop tool launchers",
    long_about = "Cache an owner-approved Nix development environment for laptop tool launchers.\n\nApproval lines contain a canonical repository glob, flake attribute and comma-separated tool names. The first matching line wins. Both the builder and native launcher use Python-compatible fnmatch patterns. Only exported variables are cached; home, temporary-directory and identity variables are preserved from the caller.",
    after_help = "Examples:\n  reverie-autoenv key ~/git/project\n  reverie-autoenv build ~/git/project\n  reverie-autoenv build ~/git/project --from-json dev-env.json\n\nConfiguration:\n  REVERIE_AUTOENV_CONFIG overrides $XDG_CONFIG_HOME/reverie/autoenv/approved\n  REVERIE_AUTOENV_CACHE overrides $XDG_CACHE_HOME/reverie/autoenv\n  XDG defaults are $HOME/.config and $HOME/.cache.\n\nThe build runs nix print-dev-env --json --offline with an explicit argument list. It never evaluates a shell hook. Set REVERIE_NO_AUTOENV=1 for a launcher passthrough without the jobs policy."
)]
struct Cli {
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Print the existing attr + flake.nix + flake.lock cache key without building.
    Key { repository: PathBuf },
    /// Build and atomically publish the cache for an approved repository.
    Build {
        repository: PathBuf,
        /// Read Nix print-dev-env JSON from this file instead of invoking Nix.
        #[arg(long)]
        from_json: Option<PathBuf>,
    },
}
struct Settings {
    config: PathBuf,
    cache: PathBuf,
}
fn nonempty(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}
fn settings() -> io::Result<Settings> {
    fn selected(
        override_name: &str,
        xdg: &str,
        fallback: &str,
        suffix: &str,
    ) -> io::Result<PathBuf> {
        if let Some(value) = nonempty(override_name) {
            return Ok(value.into());
        }
        let base = nonempty(xdg)
            .map(PathBuf::from)
            .or_else(|| nonempty("HOME").map(|home| PathBuf::from(home).join(fallback)))
            .ok_or_else(|| {
                io::Error::other("autoenv requires HOME or explicit XDG/autoenv paths")
            })?;
        Ok(base.join(suffix))
    }
    Ok(Settings {
        config: selected(
            "REVERIE_AUTOENV_CONFIG",
            "XDG_CONFIG_HOME",
            ".config",
            "reverie/autoenv/approved",
        )?,
        cache: selected(
            "REVERIE_AUTOENV_CACHE",
            "XDG_CACHE_HOME",
            ".cache",
            "reverie/autoenv",
        )?,
    })
}
fn path_text(path: &Path) -> PythonText {
    PythonText::try_new(posix_text::decode(path.as_os_str().as_bytes()))
        .expect("filesystem codepoints")
}
fn approved(repository: &Path, config: &Path) -> Result<Option<AutoenvApproval>> {
    let raw = fs::read_to_string(config)?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let repository = path_text(repository);
    for line in raw.split('\n') {
        if let Some(rule) = AutoenvApproval::from_line(
            PythonTextRef::from_scalar_text(line),
            repository.as_text_ref(),
        )? {
            return Ok(Some(rule));
        }
    }
    Ok(None)
}
fn attribute(rule: &AutoenvApproval) -> Result<String> {
    Ok(rule
        .attribute()
        .scalar_text()
        .ok_or("autoenv attribute must encode as UTF-8")?
        .into_owned())
}
fn key(repository: &Path, attribute: &str) -> io::Result<String> {
    let mut hash = Sha256::new();
    hash.update(attribute.as_bytes());
    hash.update(b"\n");
    for name in ["flake.nix", "flake.lock"] {
        match fs::read(repository.join(name)) {
            Ok(raw) => hash.update(raw),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(format!("{:x}", hash.finalize())[..32].to_owned())
}
fn nix_environment(repository: &Path, attribute: &str) -> Result<Vec<u8>> {
    let mut reference = repository.as_os_str().to_owned();
    reference.push("#");
    reference.push(attribute);
    let output = Command::new("nix")
        .args(["print-dev-env", "--json", "--offline"])
        .arg(reference)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "nix print-dev-env failed: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(output.stdout)
}
/// Public CLI entry point. Clap validates help/subcommands before any I/O.
pub fn command() -> Result<()> {
    let cli = Cli::parse();
    let (repository, source) = match &cli.command {
        Action::Key { repository } => (repository, None),
        Action::Build {
            repository,
            from_json,
        } => (repository, from_json.as_deref()),
    };
    let repository = fs::canonicalize(repository)?;
    let settings = settings()?;
    let rule = approved(&repository, &settings.config)?.ok_or_else(|| {
        format!(
            "repository is not approved in {}",
            settings.config.display()
        )
    })?;
    let attribute = attribute(&rule)?;
    let key = key(&repository, &attribute)?;
    if matches!(cli.command, Action::Key { .. }) {
        println!("{key}");
        return Ok(());
    }
    let raw = match source {
        Some(path) => fs::read(path)?,
        None => nix_environment(&repository, &attribute)?,
    };
    let environment = AutoenvEnvironment::from_nix_text(&raw)?;
    let manifest = environment.manifest(
        path_text(&repository).as_text_ref(),
        rule.attribute(),
        rule.commands(),
        &key,
    );
    cache::publish(&settings.cache, &key, &environment.cache_bytes(), &manifest)?;
    println!(
        "cached {} {} -> {} ({} vars)",
        repository.display(),
        attribute,
        key,
        environment.assignments().count()
    );
    Ok(())
}
/// Invoke through a tool-name symlink. Replaces this process with that tool;
/// any returned error means no child command was executed.
pub fn launch() -> io::Result<()> {
    launcher::launch()
}
