//! Exact website_service_auth.protected_startup DATA checks. This parses only
//! a guest config pathname; it never opens configuration or grants authority.
use super::*;
use reverie_core::posix_path::PosixPath;

pub(super) fn validate(value: &Value) -> Result<()> {
    let prefix = strings(field(value, "argvPrefix")?)?;
    let invocation = text(field(value, "nodeInvocation")?)?;
    let entry = text(field(value, "applicationEntry")?)?;
    let wrapper = PosixPath::try_new(entry.codepoints())
        .map_err(|_| ResourceActorDataError("SERVICE_AUTH_H_NODE_ARGV"))?
        .parent()
        .parent()
        .join(&PosixPath::from_scalar_text(
            "scripts/owner-terminal-start.mjs",
        ))
        .codepoints();
    need(
        prefix.len() >= 2
            && prefix[0] == invocation
            && prefix[1].codepoints() == wrapper
            && text(field(value, "nodeWrapper")?)?.codepoints() == wrapper,
        "SERVICE_AUTH_H_NODE_ARGV",
    )?;
    web_arguments(&prefix[2..])?;
    let python = field(value, "startupPython")?;
    let entry = text(field(python, "entry")?)?;
    let path = PosixPath::try_new(entry.codepoints())
        .map_err(|_| ResourceActorDataError("SERVICE_AUTH_H_BOOTSTRAP_ARGV"))?;
    let parts: Vec<_> = path.components().collect();
    need(
        path.codepoints() == entry.codepoints()
            && !path.has_parent_component()
            && path.is_relative_to(&PosixPath::from_scalar_text("/nix/store"))
            && parts.len() >= 2
            && parts[parts.len() - 2] == "libexec".chars().map(u32::from).collect::<Vec<_>>()
            && parts[parts.len() - 1] == "reverie".chars().map(u32::from).collect::<Vec<_>>(),
        "SERVICE_AUTH_H_BOOTSTRAP_ARGV",
    )?;
    let mut expected = vec![
        text(field(python, "invocation")?)?,
        PythonText::from_scalar_text("-I"),
        entry,
    ];
    expected.extend_from_slice(&prefix[2..]);
    need(
        strings(field(python, "argvPrefix")?)? == expected,
        "SERVICE_AUTH_H_BOOTSTRAP_ARGV",
    )
}
fn strings(value: &Value) -> Result<Vec<PythonText>> {
    array(value)?.iter().map(text).collect()
}
fn web_arguments(argv: &[PythonText]) -> Result<()> {
    let web = ["web", "--host", "0.0.0.0", "--port", "3000"];
    need(
        argv.len() >= web.len() && argv.iter().zip(web).all(|(a, b)| a.equals_ascii(b)),
        "SERVICE_AUTH_FIXED_WEB_ARGV",
    )?;
    let mut tail = &argv[web.len()..];
    if tail
        .last()
        .is_some_and(|v| v.equals_ascii("--resource-replacement"))
    {
        tail = &tail[..tail.len() - 1];
    }
    if tail.is_empty() {
        return Ok(());
    }
    need(
        tail.len() == 2 && tail[0].equals_ascii("--service-auth-config"),
        "SERVICE_AUTH_FIXED_WEB_ARGV",
    )?;
    guest_config(&tail[1])
}
fn guest_config(value: &PythonText) -> Result<()> {
    let scalar: Option<String> = value
        .codepoints()
        .iter()
        .copied()
        .map(char::from_u32)
        .collect();
    let scalar = scalar.ok_or(ResourceActorDataError("SERVICE_AUTH_GUEST_PATH"))?;
    let path = PosixPath::try_new(value.codepoints())
        .map_err(|_| ResourceActorDataError("SERVICE_AUTH_GUEST_PATH"))?;
    need(
        (2..=4096).contains(&scalar.len())
            && scalar.starts_with('/')
            && !scalar.starts_with("//")
            && !value.codepoints().iter().any(|&v| v < 32 || v == 127)
            && !path.has_parent_component()
            && path.codepoints() == value.codepoints(),
        "SERVICE_AUTH_GUEST_PATH",
    )
}
