use super::*;
pub(super) fn toolkit(value: &Value) -> Result<Vec<CodeFile>> {
    closed(value, &["version", "static", "manifest", "files"])?;
    need(
        matches!(&field(value,"version")?.0,Node::Number(Number::Integer(v)) if v=="1")
            && matches!(field(value, "static")?.0, Node::Bool(true)),
        "WORKER_IMAGE_TOOLKIT",
    )?;
    code(field(value, "manifest")?)?;
    let files = field(value, "files")?;
    closed(
        files,
        &[
            "/opt/reverie/human/bin/bash",
            "/opt/reverie/human/bin/reverie-human-shell",
        ],
    )?;
    // Toolkit guest files are direct static image files; their immutable host
    // manifest is observed, while the full image DiffIDs bind their contents.
    for value in object(files)?.values() {
        closed(value, &["sha256", "bytes"])?;
        digest(field(value, "sha256")?)?;
        need(
            unsigned(field(value, "bytes")?)?
                .to_u64()
                .is_some_and(|v| v > 0 && v <= 16 * 1024 * 1024),
            "WORKER_IMAGE_TOOLKIT",
        )?;
    }
    Ok(vec![code(field(value, "manifest")?)?])
}
pub(super) fn validate(factory: &Value, image: &Value) -> Result<()> {
    closed(
        factory,
        &[
            "name",
            "system",
            "uid",
            "gid",
            "subuidStart",
            "subgidStart",
            "subidCount",
            "browser",
        ],
    )?;
    let system = scalar(field(factory, "system")?)?;
    need(
        scalar(field(factory, "name")?)? == "lib.workerDockerImage"
            && ["x86_64-linux", "aarch64-linux"].contains(&system.as_str()),
        "WORKER_IMAGE_FACTORY",
    )?;
    let uid = integer(factory, "uid")?;
    let gid = integer(factory, "gid")?;
    let subuid = integer(factory, "subuidStart")?;
    let subgid = integer(factory, "subgidStart")?;
    let count = integer(factory, "subidCount")?;
    need(
        uid < 2147483648 && gid < 2147483648 && count >= 65536,
        "WORKER_IMAGE_IDENTITY",
    )?;
    for (id, start) in [(uid, subuid), (gid, subgid)] {
        let end = start
            .checked_add(count)
            .filter(|end| *end < u32::MAX)
            .ok_or(ResourceActorDataError("WORKER_IMAGE_IDMAP"))?;
        need(!(start..end).contains(&id), "WORKER_IMAGE_IDMAP")?;
    }
    let browser = match field(factory, "browser")?.0 {
        Node::Bool(value) => value,
        _ => return Err(ResourceActorDataError("WORKER_IMAGE_BROWSER")),
    };
    let config = field(image, "Config")?;
    let labels = field(config, "Labels")?;
    need(
        scalar(field(config, "User")?)? == format!("{uid}:{gid}")
            && scalar(field(config, "WorkingDir")?)? == "/reverie_workspace",
        "WORKER_IMAGE_FACTORY_PROGRAM",
    )?;
    exact_args(field(config, "Entrypoint")?, "/bin/sleep")?;
    exact_args(field(config, "Cmd")?, "infinity")?;
    for (key, expected) in [
        ("org.reverie.worker.uid", uid.to_string()),
        ("org.reverie.worker.gid", gid.to_string()),
        ("org.reverie.worker.rootless-docker", "1".into()),
        (
            "org.reverie.worker.rootless-docker.mount-layout",
            "1".into(),
        ),
        ("org.reverie.worker.subuid-start", subuid.to_string()),
        ("org.reverie.worker.subgid-start", subgid.to_string()),
        ("org.reverie.worker.subid-count", count.to_string()),
        ("reverie.worker.nix-store", "1".into()),
    ] {
        need(
            scalar(field(labels, key)?)? == expected,
            "WORKER_IMAGE_FACTORY_LABELS",
        )?;
    }
    let browser_label = object(labels)?.get(&key("org.reverie.worker.browser"));
    need(
        if browser {
            browser_label.is_some_and(|v| scalar(v).ok().as_deref() == Some("1"))
        } else {
            browser_label.is_none()
        },
        "WORKER_IMAGE_BROWSER",
    )?;
    need(
        scalar(field(image, "Os")?)? == "linux"
            && scalar(field(image, "Architecture")?)?
                == if system == "x86_64-linux" {
                    "amd64"
                } else {
                    "arm64"
                },
        "WORKER_IMAGE_PLATFORM",
    )?;
    Ok(())
}
fn integer(value: &Value, name: &str) -> Result<u32> {
    unsigned(field(value, name)?)?
        .to_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0 && *v < u32::MAX)
        .ok_or(ResourceActorDataError("WORKER_IMAGE_FACTORY_INTEGER"))
}
fn exact_args(value: &Value, expected: &str) -> Result<()> {
    let args = array(value)?;
    need(
        args.len() == 1 && scalar(&args[0])? == expected,
        "WORKER_IMAGE_FACTORY_PROGRAM",
    )
}
