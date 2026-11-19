//! Resolve the IANA keys stored in Reverie's existing configuration.
use jiff::tz::TimeZone;
use std::path::Path;

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('/')
        && !key.contains('\0')
        && key.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

/// Read an exact zone key from TZDIR, the system directories, or the bundled database.
pub fn load_zone(key: &str) -> Option<TimeZone> {
    if !valid_key(key) {
        return None;
    }
    let override_dir = std::env::var_os("TZDIR").filter(|path| !path.is_empty());
    for directory in override_dir.iter().map(Path::new).chain(
        [
            "/usr/share/zoneinfo",
            "/usr/lib/zoneinfo",
            "/usr/share/lib/zoneinfo",
            "/etc/zoneinfo",
        ]
        .into_iter()
        .map(Path::new),
    ) {
        let file = directory.join(key);
        if file.is_file() {
            return std::fs::read(&file)
                .ok()
                .and_then(|bytes| TimeZone::tzif(key, &bytes).ok());
        }
    }
    let zone = jiff::tz::db().get(key).ok()?;
    (zone.iana_name() == Some(key)).then_some(zone)
}
