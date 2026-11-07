//! Closed build-time guest purpose, distinct from normal host Nix bindings.
//! Filesystem checks establish installation DATA, never caller authorization.
use std::{ffi::OsStr, path::Path};

pub(crate) const PREFIX: &str = "/opt/reverie/memory";

pub(crate) fn guest() -> bool {
    option_env!("REVERIE_MEMORY_GUEST_CAPSULE") == Some("v1")
}

pub(crate) fn guest_path(path: &Path) -> bool {
    guest()
        && [
            "bin/node",
            "bin/reverie-memory",
            "console/dist/index.js",
            "console/dist/installed-mcp-entry.js",
        ]
        .iter()
        .any(|name| path == Path::new(PREFIX).join(name))
}

pub(crate) fn code_loading_environment(key: &OsStr) -> bool {
    key.to_str().is_some_and(|key| {
        key.starts_with("LD_")
            || key.starts_with("DYLD_")
            || matches!(
                key,
                "NODE_OPTIONS" | "NODE_PATH" | "NODE_REPL_EXTERNAL_MODULE"
            )
            || guest()
                && matches!(
                    key,
                    "NODE_ICU_DATA"
                        | "NODE_COMPILE_CACHE"
                        | "ICU_DATA"
                        | "GCONV_PATH"
                        | "LOCPATH"
                        | "NLSPATH"
                        | "GLIBC_TUNABLES"
                        | "OPENSSL_CONF"
                        | "OPENSSL_MODULES"
                        | "OPENSSL_ENGINES"
                )
    })
}
