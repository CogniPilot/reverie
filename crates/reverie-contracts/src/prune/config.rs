use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

/// Decoded data only. Path spelling is retained; no path has been opened,
/// canonicalized, or proven contained by decoding TOML.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    live_enabled: bool,
    b_mount: String,
    laptops_root: String,
    high_water_pct: f64,
    low_water_pct: f64,
    idle_days: f64,
    recent_write_hours: f64,
    max_delete_bytes: u64,
    max_delete_seconds: f64,
    registry_dir: String,
    checkout_roots: Vec<String>,
    checkout_max_depth: u64,
    log_dir: String,
    lock_path: String,
    laptop_home_root: String,
    lease_dir_template: String,
    host_lease_dirs: Vec<String>,
    lease_report_days: f64,
    // Accepted legacy data only. Never stat/open/import/select this path.
    lease_lib: String,
    laptops_cmd: Vec<String>,
    root_identities: BTreeMap<String, RootIdentity>,
    registry_manifest: String,
    test_mountinfo: String,
    test_trusted_uid: Option<u32>,
    test_unbound_ok: bool,
    test_mode: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RootIdentity {
    pub(crate) source: String,
    pub(crate) fstype: String,
    #[serde(default = "full_root")]
    pub(crate) mount_root: String,
}
fn full_root() -> String {
    "/".into()
}
impl Default for Config {
    fn default() -> Self {
        Self {
            live_enabled: false,
            b_mount: "/mnt/scratch".into(),
            laptops_root: "laptops/employees".into(),
            high_water_pct: 70.0,
            low_water_pct: 50.0,
            idle_days: 3.0,
            recent_write_hours: 6.0,
            max_delete_bytes: 200 << 30,
            max_delete_seconds: 1800.0,
            registry_dir: "/etc/reverie/prune-registry".into(),
            checkout_roots: Vec::new(),
            checkout_max_depth: 6,
            log_dir: "/var/log/reverie-prune".into(),
            lock_path: "/run/reverie-prune.lock".into(),
            laptop_home_root: String::new(),
            lease_dir_template: "{home}/.local/state/reverie/leases".into(),
            host_lease_dirs: vec!["/var/lib/reverie/leases".into()],
            lease_report_days: 3.0,
            lease_lib: "/usr/lib/reverie/lease.py".into(),
            laptops_cmd: Vec::new(),
            root_identities: BTreeMap::new(),
            registry_manifest: "approvals.json".into(),
            test_mountinfo: String::new(),
            test_trusted_uid: None,
            test_unbound_ok: false,
            test_mode: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigError {
    Toml,
    TestOnly,
    Watermarks,
    NonfiniteOrNegative,
    Path,
    Manifest,
    Identity,
    LiveDisabled,
    ProductionLiveUnavailable,
}
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "prune config: {self:?}")
    }
}
impl std::error::Error for ConfigError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    DryRun,
    TestRootLive,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pass {
    HighWater,
    Checkouts,
    Retired,
    All,
}
impl Pass {
    pub fn includes_checkouts(self) -> bool {
        matches!(self, Self::Checkouts | Self::All)
    }
}

impl Config {
    /// `test_root` is caller-supplied context, not a grant. The host still has
    /// to resolve every path under a private test root before it uses it.
    pub fn parse_toml(text: &str, test_root: bool) -> Result<Self, ConfigError> {
        let value: Self = toml::from_str(text).map_err(|_| ConfigError::Toml)?;
        value.validate(test_root)?;
        Ok(value)
    }
    fn validate(&self, test_root: bool) -> Result<(), ConfigError> {
        if !test_root
            && (self.test_mode
                || !self.test_mountinfo.is_empty()
                || self.test_trusted_uid.is_some()
                || self.test_unbound_ok)
        {
            return Err(ConfigError::TestOnly);
        }
        if !(0.0 <= self.low_water_pct
            && self.low_water_pct <= self.high_water_pct
            && self.high_water_pct <= 100.0)
        {
            return Err(ConfigError::Watermarks);
        }
        for value in [
            self.idle_days,
            self.recent_write_hours,
            self.max_delete_seconds,
            self.lease_report_days,
        ] {
            if !value.is_finite() || value < 0.0 {
                return Err(ConfigError::NonfiniteOrNegative);
            }
        }
        self.validate_paths()?;
        if self.root_identities.values().any(|id| {
            id.source.is_empty()
                || id.fstype.is_empty()
                || !id.mount_root.starts_with('/')
                || [&id.source, &id.fstype, &id.mount_root]
                    .iter()
                    .any(|s| s.contains('\0'))
        }) {
            return Err(ConfigError::Identity);
        }
        Ok(())
    }
    fn validate_paths(&self) -> Result<(), ConfigError> {
        let paths = [
            &self.b_mount,
            &self.laptops_root,
            &self.registry_dir,
            &self.log_dir,
            &self.lock_path,
            &self.laptop_home_root,
            &self.test_mountinfo,
            &self.lease_dir_template,
        ];
        if paths
            .into_iter()
            .chain(self.checkout_roots.iter())
            .chain(self.host_lease_dirs.iter())
            .chain(self.root_identities.keys())
            .any(|s| s.contains('\0'))
        {
            return Err(ConfigError::Path);
        }
        let name = self.registry_manifest.as_bytes();
        if name.is_empty()
            || name.len() > 100
            || !name[0].is_ascii_alphanumeric()
            || !name
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
        {
            return Err(ConfigError::Manifest);
        }
        Ok(())
    }
    /// This slice deliberately exposes no production-live mode, even when the
    /// legacy config enables live. No command or effect permit is constructed.
    pub fn mode(&self, live: bool, test_root: bool) -> Result<Mode, ConfigError> {
        self.validate(test_root)?;
        if !live {
            return Ok(Mode::DryRun);
        }
        if !self.live_enabled {
            return Err(ConfigError::LiveDisabled);
        }
        if !test_root {
            return Err(ConfigError::ProductionLiveUnavailable);
        }
        Ok(Mode::TestRootLive)
    }
    pub fn b_mount(&self) -> &str {
        &self.b_mount
    }
    pub fn checkout_roots(&self) -> &[String] {
        &self.checkout_roots
    }
    pub fn root_identity(&self, root: &str) -> Option<&RootIdentity> {
        self.root_identities.get(root)
    }
    pub(crate) fn valid_context(&self, test_root: bool) -> bool {
        self.validate(test_root).is_ok()
    }
    pub(crate) fn test_unbound_ok(&self) -> bool {
        self.test_unbound_ok
    }
    /// Raw configuration data for the future adapter, not checked paths.
    pub fn paths(&self) -> (&str, &str, &str, &str) {
        (
            &self.registry_dir,
            &self.log_dir,
            &self.lock_path,
            &self.laptop_home_root,
        )
    }
    pub fn watermarks(&self) -> (f64, f64) {
        (self.low_water_pct, self.high_water_pct)
    }
    pub fn max_delete_bytes(&self) -> u64 {
        self.max_delete_bytes
    }
}
