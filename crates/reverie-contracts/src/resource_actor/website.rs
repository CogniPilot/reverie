use super::*;
use reverie_core::ids::ContainerId;

#[derive(Clone, Eq, PartialEq)]
pub struct ProgramSelection {
    pub executable: PythonText,
    pub argv: Vec<PythonText>,
}
impl ProgramSelection {
    /// Expected raw process argv hash DATA. Native executable/incarnation,
    /// installed program custody and actual peer remain separate checks.
    pub fn argv_digest(&self) -> Result<JournalDigest> {
        use sha2::{Digest, Sha256};
        arguments(&self.argv)?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 4];
        for argument in &self.argv {
            for &point in argument.codepoints() {
                let scalar =
                    char::from_u32(point).ok_or(ResourceActorDataError("PROGRAM_ARGV_ENCODING"))?;
                hash.update(scalar.encode_utf8(&mut buffer).as_bytes());
            }
            hash.update([0]);
        }
        Ok(JournalDigest::parse(&format!("{:x}", hash.finalize())).expect("SHA256"))
    }
    fn decode(value: &Value) -> Result<Self> {
        closed(value, &["executable", "argv"])?;
        let executable = text(field(value, "executable")?)?;
        let argv = array(field(value, "argv")?)?
            .iter()
            .map(text)
            .collect::<Result<Vec<_>>>()?;
        arguments(&argv)?;
        Ok(Self { executable, argv })
    }
}
fn arguments(argv: &[PythonText]) -> Result<()> {
    need(
        (1..=32).contains(&argv.len())
            && argv.iter().all(|value| {
                !value.codepoints().is_empty()
                    && value.codepoints().len() <= 4096
                    && !value.codepoints().contains(&0)
            }),
        "FIXED_WEBSITE_PROGRAM",
    )
}
#[cfg(test)]
mod argv_tests {
    use super::*;
    #[test]
    fn selected_raw_argv_hash_matches_python_boundaries_utf8_and_encoding_refusals() {
        let corpus = legacy_json::decode_strict_bytes(include_bytes!(
            "../../tests/fixtures/resource_actor/program-argv-python.json"
        ))
        .unwrap();
        let cases = array(field(&corpus, "cases").unwrap()).unwrap();
        assert_eq!(cases.len(), 8);
        for case in cases {
            let argv = array(field(case, "argv").unwrap())
                .unwrap()
                .iter()
                .map(|value| text(value).unwrap())
                .collect();
            let program = ProgramSelection {
                executable: PythonText::from_scalar_text("/nix/store/data/bin/program"),
                argv,
            };
            let expected = field(case, "sha256").unwrap();
            match &expected.0 {
                Node::Null => assert!(program.argv_digest().is_err()),
                _ => assert_eq!(program.argv_digest().unwrap(), digest(expected).unwrap()),
            }
        }
    }
}
#[derive(Clone, Eq, PartialEq)]
pub struct CodeFile {
    pub path: PythonText,
    pub sha256: JournalDigest,
    pub bytes: u64,
}
pub struct WebsiteSelection {
    pub container: ContainerId,
    pub image: String,
    pub config_digest: JournalDigest,
    pub host_config_digest: JournalDigest,
    pub mounts_digest: JournalDigest,
    pub initial: Option<(UnsignedInteger, UnsignedInteger)>,
    pub uid: u32,
    pub gid: u32,
    pub bootstrap: ProgramSelection,
    pub node: ProgramSelection,
    pub code: Vec<CodeFile>,
}
fn identity(value: &Value) -> Result<u32> {
    unsigned(value)?
        .to_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ResourceActorDataError("ORDINARY_OWNER_WEBSITE_REQUIRED"))
}
fn initial(value: &Value) -> Result<Option<(UnsignedInteger, UnsignedInteger)>> {
    let pid = field(value, "initPid")?;
    let start = field(value, "initStart")?;
    if matches!((&pid.0, &start.0), (Node::Null, Node::Null)) {
        return Ok(None);
    }
    let (pid, start) = (unsigned(pid)?, unsigned(start)?);
    need(
        !pid.is_zero() && pid.as_str() != "1" && !start.is_zero(),
        "WEBSITE_INIT_SELECTION",
    )?;
    Ok(Some((pid, start)))
}
pub(super) fn files(value: &Value) -> Result<Vec<CodeFile>> {
    let values = object(value)?;
    need(
        (1..=4096).contains(&values.len()),
        "IMMUTABLE_CODE_MANIFEST_REQUIRED",
    )?;
    let mut total = 0_u64;
    values
        .iter()
        .map(|(name, value)| {
            closed(value, &["sha256", "bytes"])?;
            let path = PythonText::try_new(name.0.clone()).expect("JSON codepoints");
            let parsed = reverie_core::posix_path::PosixPath::try_new(path.codepoints())
                .map_err(|_| ResourceActorDataError("IMMUTABLE_CODE_PATH"))?;
            need(
                path.codepoints()
                    .starts_with(&"/nix/store/".bytes().map(u32::from).collect::<Vec<_>>())
                    && parsed.codepoints() == path.codepoints()
                    && !parsed.has_parent_component(),
                "IMMUTABLE_CODE_PATH",
            )?;
            let bytes = unsigned(field(value, "bytes")?)?
                .to_u64()
                .ok_or(ResourceActorDataError("IMMUTABLE_CODE_BINDING"))?;
            need(bytes <= 256 * 1024 * 1024, "IMMUTABLE_CODE_BINDING")?;
            total += bytes;
            need(total <= 512 * 1024 * 1024, "IMMUTABLE_CODE_TOTAL_BOUND")?;
            Ok(CodeFile {
                path,
                bytes,
                sha256: digest(field(value, "sha256")?)?,
            })
        })
        .collect()
}
impl WebsiteSelection {
    pub(super) fn decode(value: &Value) -> Result<Self> {
        closed(
            value,
            &[
                "containerId",
                "imageId",
                "configDigest",
                "hostConfigDigest",
                "mountsDigest",
                "initPid",
                "initStart",
                "uid",
                "gid",
                "bootstrap",
                "node",
                "codeFiles",
            ],
        )?;
        let container = ContainerId::parse(&scalar(field(value, "containerId")?)?)
            .map_err(|_| ResourceActorDataError("WEBSITE_FACT_DIGEST"))?;
        let image = scalar(field(value, "imageId")?)?;
        need(
            image.len() == 71
                && image.starts_with("sha256:")
                && image[7..]
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "WEBSITE_IMAGE_ID",
        )?;
        Ok(Self {
            container,
            image,
            config_digest: digest(field(value, "configDigest")?)?,
            host_config_digest: digest(field(value, "hostConfigDigest")?)?,
            mounts_digest: digest(field(value, "mountsDigest")?)?,
            initial: initial(value)?,
            uid: identity(field(value, "uid")?)?,
            gid: identity(field(value, "gid")?)?,
            bootstrap: ProgramSelection::decode(field(value, "bootstrap")?)?,
            node: ProgramSelection::decode(field(value, "node")?)?,
            code: files(field(value, "codeFiles")?)?,
        })
    }
}
