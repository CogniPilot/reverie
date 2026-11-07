/// The fixed temporary environment root policy, shared by create and child.
/// A project root uses the first12 SHA256 bytes of RAW cwd fsencode data.
pub struct TemporaryEnvironmentRoot(Option<[u8; 12]>);
impl TemporaryEnvironmentRoot {
    pub fn global() -> Self {
        Self(None)
    }
    pub fn project(prefix: [u8; 12]) -> Self {
        Self(Some(prefix))
    }
    pub fn entries(&self) -> Vec<(String, String)> {
        let root = match self.0 {
            None => "/tmp/reverie".to_owned(),
            Some(prefix) => format!(
                "/tmp/reverie/projects/{}",
                prefix
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ),
        };
        [
            ("TMPDIR", "/tmp".to_owned()),
            ("TMP", "/tmp".to_owned()),
            ("TEMP", "/tmp".to_owned()),
            ("XDG_CACHE_HOME", format!("{root}/cache")),
            ("PIP_CACHE_DIR", format!("{root}/cache/pip")),
            ("UV_CACHE_DIR", format!("{root}/cache/uv")),
            ("npm_config_cache", format!("{root}/cache/npm")),
            ("CCACHE_DIR", format!("{root}/cache/ccache")),
            ("GOCACHE", format!("{root}/cache/go-build")),
            ("GOMODCACHE", format!("{root}/cache/go-mod")),
            ("XDG_DOWNLOAD_DIR", format!("{root}/downloads")),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
    }
}
