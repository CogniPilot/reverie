//! Closed native roles, bound to the original process's exact raw argv.
//! No caller-selected role spelling, executable, extra flag or fallback.
use super::*;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, os::unix::ffi::OsStrExt, path::Path};

#[derive(Clone, Copy)]
pub(super) enum Role {
    Broker,
    InstallationOfferV1,
}
impl Role {
    pub(super) fn source_digest(self, executable: &Path, source: &Path) -> Result<String> {
        let role = match self {
            Self::Broker => OsStr::new("broker"),
            Self::InstallationOfferV1 => OsStr::new("offer-pool-v1"),
        };
        let mut hash = Sha256::new();
        for argument in [
            executable.as_os_str(),
            role,
            OsStr::new("--config"),
            source.as_os_str(),
        ] {
            need(
                !argument.as_bytes().contains(&0),
                "WORKER_POOL_BROKER_ARGUMENTS",
            )?;
            hash.update(argument.as_bytes());
            hash.update([0]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    fn raw_digest(argv: &[&[u8]]) -> String {
        let mut hash = Sha256::new();
        for arg in argv {
            hash.update(arg);
            hash.update([0]);
        }
        format!("{:x}", hash.finalize())
    }
    #[test]
    fn ordinary_origin_remains_exact_and_cannot_become_an_installation_offer() {
        let executable = Path::new("/nix/store/native/bin/reverie-worker-broker");
        let source = Path::new("/home/example/reverie/broker.json");
        let ordinary = Role::Broker.source_digest(executable, source).unwrap();
        let offer = Role::InstallationOfferV1
            .source_digest(executable, source)
            .unwrap();
        let legacy = raw_digest(&[
            executable.as_os_str().as_bytes(),
            b"broker",
            b"--config",
            source.as_os_str().as_bytes(),
        ]);
        assert_eq!(ordinary, legacy);
        assert_ne!(ordinary, offer);
        for changed in [
            vec![
                b"--config".as_slice(),
                source.as_os_str().as_bytes(),
                b"offer-pool-v1",
            ],
            vec![
                b"offer-pool-v1".as_slice(),
                b"--config",
                source.as_os_str().as_bytes(),
                b"--force",
            ],
        ] {
            let mut argv = vec![executable.as_os_str().as_bytes()];
            argv.extend(changed);
            assert_ne!(offer, raw_digest(&argv));
        }
    }
    #[test]
    fn raw_source_bytes_are_bound_without_lossy_path_conversion_or_nul_aliasing() {
        let executable = Path::new("/nix/store/native/bin/reverie-worker-broker");
        let source = std::path::PathBuf::from(OsString::from_vec(b"/owner/\xff/config".to_vec()));
        let digest = Role::InstallationOfferV1
            .source_digest(executable, &source)
            .unwrap();
        assert_eq!(
            digest,
            raw_digest(&[
                executable.as_os_str().as_bytes(),
                b"offer-pool-v1",
                b"--config",
                b"/owner/\xff/config",
            ])
        );
        let nul = std::path::PathBuf::from(OsString::from_vec(b"/owner/config\0extra".to_vec()));
        for role in [Role::Broker, Role::InstallationOfferV1] {
            assert_eq!(
                role.source_digest(executable, &nul).unwrap_err().code(),
                "WORKER_POOL_BROKER_ARGUMENTS"
            );
        }
    }
}
