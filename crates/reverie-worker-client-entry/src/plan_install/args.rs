use super::input::{decimal, valid_digest, valid_uuid};
use super::{Failure, Result, need};
use std::ffi::OsString;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Home {
    pub(super) dev: u64,
    pub(super) ino: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Install {
        payload: String,
        attempt: String,
    },
    Status {
        operation: String,
        container: String,
        initial: bool,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Arguments {
    pub(super) capsule: String,
    pub(super) projection: String,
    pub(super) home: Home,
    pub(super) action: Action,
}
fn text(value: &OsString) -> Result<&str> {
    value
        .to_str()
        .ok_or_else(|| Failure::refused("argument-encoding"))
}
pub(super) fn arguments(raw: &[OsString]) -> Option<Result<Arguments>> {
    if raw.first().is_none_or(|v| v != "worker-client")
        || raw
            .get(1)
            .is_none_or(|v| v != "plan-install" && v != "plan-status")
    {
        return None;
    }
    Some(parse(raw))
}
fn parse(raw: &[OsString]) -> Result<Arguments> {
    let values = raw.iter().map(text).collect::<Result<Vec<_>>>()?;
    let (capsule, projection, dev, ino, action) = match values.as_slice() {
        [
            "worker-client",
            "plan-install",
            "--expected-digest",
            capsule,
            "--projection-digest",
            projection,
            "--payload-digest",
            payload,
            "--attempt",
            attempt,
            "--home-dev",
            dev,
            "--home-ino",
            ino,
        ] => {
            need(
                valid_digest(payload) && valid_uuid(attempt),
                "install-arguments",
            )?;
            (
                *capsule,
                *projection,
                *dev,
                *ino,
                Action::Install {
                    payload: (*payload).into(),
                    attempt: (*attempt).into(),
                },
            )
        }
        [
            "worker-client",
            "plan-status",
            "--expected-digest",
            capsule,
            "--projection-digest",
            projection,
            "--operation",
            operation,
            "--container-id",
            container,
            "--read-mode",
            mode,
            "--home-dev",
            dev,
            "--home-ino",
            ino,
        ] => {
            need(
                valid_uuid(operation)
                    && valid_digest(container)
                    && matches!(*mode, "initial" | "live"),
                "status-arguments",
            )?;
            (
                *capsule,
                *projection,
                *dev,
                *ino,
                Action::Status {
                    operation: (*operation).into(),
                    container: (*container).into(),
                    initial: *mode == "initial",
                },
            )
        }
        _ => return Err(Failure::refused("arguments")),
    };
    need(
        valid_digest(capsule) && valid_digest(projection),
        "argument-digest",
    )?;
    Ok(Arguments {
        capsule: capsule.into(),
        projection: projection.into(),
        home: Home {
            dev: decimal(dev, false)?,
            ino: decimal(ino, true)?,
        },
        action,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    #[test]
    fn exact_mode_and_public_hashes_never_caller_paths() {
        let digest = "a".repeat(64);
        let op = "11111111-1111-4111-8111-111111111111";
        let input = args(&[
            "worker-client",
            "plan-install",
            "--expected-digest",
            &digest,
            "--projection-digest",
            &digest,
            "--payload-digest",
            &digest,
            "--attempt",
            op,
            "--home-dev",
            "1",
            "--home-ino",
            "2",
        ]);
        assert!(arguments(&input).unwrap().is_ok());
        let mut extra = input.clone();
        extra.push("--path=/elsewhere".into());
        assert!(arguments(&extra).unwrap().is_err());
        let mut changed = input;
        changed[9] = "../escape".into();
        assert!(arguments(&changed).unwrap().is_err());
        assert!(arguments(&args(&["worker-client", "credential-install"])).is_none());
        let status = args(&[
            "worker-client",
            "plan-status",
            "--expected-digest",
            &digest,
            "--projection-digest",
            &digest,
            "--operation",
            op,
            "--container-id",
            &digest,
            "--read-mode",
            "live",
            "--home-dev",
            "1",
            "--home-ino",
            "2",
        ]);
        assert!(matches!(
            arguments(&status).unwrap().unwrap().action,
            Action::Status { initial: false, .. }
        ));
    }
}
