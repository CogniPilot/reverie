//! Intent and result records around each write. The intent is written before the write and is
//! never overwritten: a second attempt refuses until someone has inspected the first, because a
//! write whose outcome is unknown must not be repeated blindly.
//!
//! The records directory is held (see `custody`), and every record is created new and no-follow,
//! so a symlink on its path or at a record's name is refused, and nothing is overwritten.
use crate::custody::Held;
use nix::errno::Errno;
use serde_json::Value;
use std::path::Path;

#[derive(Debug)]
pub struct Records {
    dir: Held,
}

impl Records {
    /// Holds `dir`, creating any missing part of it inside held parents.
    pub fn new(dir: &Path) -> Result<Self, String> {
        Ok(Self {
            dir: Held::open_or_create(dir)?,
        })
    }

    /// Writes `INTENT.json`, refusing if one already exists.
    pub fn intent(&self, intent: &Value) -> Result<(), String> {
        let text = serde_json::to_string_pretty(intent).map_err(|e| e.to_string())?;
        self.dir
            .write_new("INTENT.json", text.as_bytes())
            .map_err(|e| {
                if e.ends_with(Errno::EEXIST.desc()) {
                    format!(
                        "{}/INTENT.json exists: inspect the earlier attempt before any retry",
                        self.dir.path().display()
                    )
                } else {
                    e
                }
            })
    }

    /// Writes a named result record. One attempt writes each name once, so an existing record
    /// refuses like everything else here.
    pub fn result(&self, name: &str, value: &Value) -> Result<(), String> {
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        self.dir.write_new(name, text.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    #[test]
    fn a_record_never_writes_through_a_symlink_or_over_an_existing_file() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("publish-records-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("records")).unwrap();
        fs::write(root.join("canary"), "outside\n").unwrap();
        symlink(root.join("canary"), root.join("records/PUSH-RESULT.json")).unwrap();
        fs::write(root.join("records/PR-READBACK.json"), "kept\n").unwrap();
        let records = Records::new(&root.join("records")).unwrap();
        for name in ["PUSH-RESULT.json", "PR-READBACK.json"] {
            assert!(
                records
                    .result(name, &serde_json::json!({"ok": true}))
                    .is_err()
            );
        }
        assert_eq!(fs::read(root.join("canary")).unwrap(), b"outside\n");
        assert_eq!(
            fs::read(root.join("records/PR-READBACK.json")).unwrap(),
            b"kept\n"
        );
        symlink(root.join("records"), root.join("alias")).unwrap();
        let error = Records::new(&root.join("alias")).unwrap_err();
        assert!(error.contains("is a symlink"), "{error}");
        let error = Records::new(&root.join("alias/records/new")).unwrap_err();
        assert!(error.contains("is a symlink"), "{error}");
        assert!(!root.join("records/records").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
