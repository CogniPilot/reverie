//! Intent and result records around each write. The intent is written before the write and is
//! never overwritten: a second attempt refuses until someone has inspected the first, because a
//! write whose outcome is unknown must not be repeated blindly.
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct Records {
    dir: PathBuf,
}

impl Records {
    pub fn new(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self {
            dir: dir.to_path_buf(),
        })
    }

    /// Writes `INTENT.json`, refusing if one already exists.
    pub fn intent(&self, intent: &Value) -> Result<(), String> {
        let path = self.dir.join("INTENT.json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!(
                        "{} exists: inspect the earlier attempt before any retry",
                        path.display()
                    )
                } else {
                    format!("{}: {e}", path.display())
                }
            })?;
        let text = serde_json::to_string_pretty(intent).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("{}: {e}", path.display()))
    }

    /// Writes a named result record (overwriting, since results are read back, not trusted).
    pub fn result(&self, name: &str, value: &Value) -> Result<(), String> {
        let path = self.dir.join(name);
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_intent_refuses_until_the_first_is_inspected() {
        let dir = std::env::temp_dir().join(format!("publish-records-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let records = Records::new(&dir).unwrap();
        records.intent(&serde_json::json!({"head": "a"})).unwrap();
        let again = records
            .intent(&serde_json::json!({"head": "a"}))
            .unwrap_err();
        assert!(again.contains("inspect the earlier attempt"), "{again}");
        records
            .result("RESULT.json", &serde_json::json!({"rc": 0}))
            .unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
