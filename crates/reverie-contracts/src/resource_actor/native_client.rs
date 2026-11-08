//! Exact immutable native-client v2 manifest DATA. Native file custody, digest,
//! executable bits and ELF checks are independent mandatory observations.
use super::*;
pub struct NativeResourceClientManifest {
    executable: PythonText,
    digest: JournalDigest,
}
impl NativeResourceClientManifest {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(
            !raw.is_empty() && raw.len() <= 8192,
            "RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED",
        )?;
        let value = legacy_json::decode_strict_bytes(raw)
            .map_err(|_| ResourceActorDataError("RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED"))?;
        closed(
            &value,
            &[
                "version",
                "purpose",
                "executable",
                "executableSHA256",
                "argvPrefix",
                "brokerWireVersion",
            ],
        )?;
        need(
            matches!(&field(&value, "version")?.0, Node::Number(Number::Integer(v)) if v == "2")
                && matches!(&field(&value, "brokerWireVersion")?.0, Node::Number(Number::Integer(v)) if v == "1")
                && matches!(&field(&value, "purpose")?.0, Node::String(v) if v.equals_ascii("resource-replacement-native-client-v2")),
            "RESOURCE_ACTOR_NATIVE_CLIENT_REQUIRED",
        )?;
        let executable = text(field(&value, "executable")?)?;
        let path = reverie_core::posix_path::PosixPath::try_new(executable.codepoints())
            .map_err(|_| ResourceActorDataError("RESOURCE_ACTOR_FIXED_PROGRAM"))?;
        need(
            executable
                .codepoints()
                .starts_with(&"/nix/store/".chars().map(u32::from).collect::<Vec<_>>())
                && path.codepoints() == executable.codepoints()
                && !path.has_parent_component()
                && !executable.codepoints().contains(&0)
                && executable.codepoints().len() <= 16384,
            "RESOURCE_ACTOR_FIXED_PROGRAM",
        )?;
        let argv = array(field(&value, "argvPrefix")?)?;
        need(
            argv.len() == 1 && text(&argv[0])? == executable,
            "RESOURCE_ACTOR_NATIVE_CLIENT_REQUIRED",
        )?;
        Ok(Self {
            executable,
            digest: digest(field(&value, "executableSHA256")?)?,
        })
    }
    pub fn executable(&self) -> &PythonText {
        &self.executable
    }
    pub fn executable_digest(&self) -> &JournalDigest {
        &self.digest
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn valid() -> serde_json::Value {
        json!({"version":2,"purpose":"resource-replacement-native-client-v2",
            "brokerWireVersion":1,"executable":"/nix/store/fixed-client/bin/client",
            "executableSHA256":"a".repeat(64),"argvPrefix":["/nix/store/fixed-client/bin/client"]})
    }
    #[test]
    fn native_v2_manifest_is_data_without_opening_or_launching_its_executable() {
        let value = valid();
        let manifest =
            NativeResourceClientManifest::decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            manifest
                .executable()
                .equals_ascii("/nix/store/fixed-client/bin/client")
        );
        assert_eq!(manifest.executable_digest().as_str(), "a".repeat(64));
    }
    #[test]
    fn native_manifest_refuses_old_interpreters_versions_extra_fields_and_argument_suffixes() {
        for (name, bad) in [
            ("version", json!(1)),
            ("version", json!(true)),
            ("version", json!(2.0)),
            ("brokerWireVersion", json!(2)),
            ("brokerWireVersion", json!(true)),
            ("purpose", json!("resource-replacement-client-v1")),
            ("callback", json!("native")),
            (
                "argvPrefix",
                json!(["/nix/store/fixed-client/bin/client", "--alternate"]),
            ),
        ] {
            let mut value = valid();
            value[name] = bad;
            assert!(
                NativeResourceClientManifest::decode(&serde_json::to_vec(&value).unwrap()).is_err()
            );
        }
        for bad in ["/usr/bin/python", "/nix/store/../client", "/nix/store/a\0b"] {
            let mut value = valid();
            value["executable"] = json!(bad);
            value["argvPrefix"] = json!([bad]);
            assert!(
                NativeResourceClientManifest::decode(&serde_json::to_vec(&value).unwrap()).is_err()
            );
        }
    }
}
