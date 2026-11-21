//! Private HTTPS settings shared by the container and its updater.
pub struct Setting {
    pub key: &'static str,
    pub default: &'static str,
}

pub const ENABLED: Setting = Setting {
    key: "REVERIE_TAILSCALE",
    default: "0",
};
pub const HOSTNAME: Setting = Setting {
    key: "REVERIE_TAILSCALE_HOSTNAME",
    default: "reverie",
};
pub const WEB_PORT: Setting = Setting {
    key: "REVERIE_TAILSCALE_WEB_PORT",
    default: "3000",
};
