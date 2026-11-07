use super::*;
use reverie_contracts::goal_custody::{GoalConfigurationRecord, GoalPathPair};
use reverie_core::posix_path::PosixPath;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
impl GoalCustodyAttempt {
    pub(super) fn configuration(
        &mut self,
        source: &Path,
        settings: &GoalWorkerSettings,
    ) -> Result<(GoalPrivateConfig, String)> {
        let (_, current) = self.files.read_json_file(source)?;
        self.files.check()?;
        need(
            settings.matches_private_worker_bytes(&current)?,
            "Worker policy changed; Goal bootstrap unavailable",
        )?;
        let selected = native::python_path(settings.private_configuration().codepoints())?;
        let (fingerprint, bytes) = self.files.read_json_file(&selected)?;
        self.files.check()?;
        let record = GoalConfigurationRecord::decode(&bytes)?;
        self.state.observe_identity(&fingerprint)?;
        let config = record.validate(settings.private_configuration(), settings.company_file())?;
        Ok((config, format!("{:x}", Sha256::digest(&bytes))))
    }
    pub(super) fn check_projection_scope(
        &self,
        source: &Path,
        settings: &GoalWorkerSettings,
        config: &GoalPrivateConfig,
        observed: &inventory::ObservedInventory,
    ) -> Result<()> {
        for (_, pair) in config.paths() {
            mapping(pair, &observed.data)?;
        }
        mapped(
            &settings.socket().codepoints(),
            config.broker_socket(),
            &observed.data,
        )?;
        need(
            observed.started.elapsed() <= std::time::Duration::from_millis(1500),
            "Current Goal inventory deadline exceeded",
        )?;
        let mut exposed = settings.mounts().to_vec();
        exposed.extend_from_slice(observed.data.exposed_roots());
        let mut protected: Vec<_> = config
            .paths()
            .filter(|(kind, _)| *kind != GoalPrivatePath::Authority)
            .map(|(_, pair)| pair.host().parent())
            .collect();
        protected.push(config.path(GoalPrivatePath::Authority).host().clone());
        protected.push(config.path(GoalPrivatePath::Nonce).host().parent().parent());
        protected.push(
            PosixPath::try_new(&native::python_text(source))
                .map_err(|_| GoalCustodyError::Refused("Private Goal configuration unavailable"))?,
        );
        protected.push(settings.socket().parent());
        unexposed(&protected, &exposed)
    }
    pub(super) fn private_identities(
        &mut self,
        config: &GoalPrivateConfig,
    ) -> Result<BTreeMap<String, Option<[String; 5]>>> {
        let mut identities = BTreeMap::new();
        for (kind, pair) in config.paths() {
            let path = native::python_path(&pair.host().codepoints())?;
            let value = self
                .files
                .inspect(&path, kind == GoalPrivatePath::Authority, false)?;
            identities.insert(kind.as_str().to_owned(), value);
            let root = native::python_path(&pair.host().parent().codepoints())?;
            identities.insert(
                format!("{}Root", kind.as_str()),
                self.files.inspect(&root, true, false)?,
            );
        }
        for (name, kind, suffix, absent) in [
            ("canonicalLock", GoalPrivatePath::Canonical, ".lock", true),
            ("nonceLock", GoalPrivatePath::Nonce, ".lock", false),
            ("noncePending", GoalPrivatePath::Nonce, ".pending", true),
        ] {
            let mut path =
                native::python_path(&config.path(kind).host().codepoints())?.into_os_string();
            path.push(suffix);
            identities.insert(
                name.to_owned(),
                self.files.inspect(&PathBuf::from(path), false, absent)?,
            );
        }
        let parent = config.path(GoalPrivatePath::Nonce).host().parent().parent();
        identities.insert(
            "nonceParent".to_owned(),
            self.files
                .inspect(&native::python_path(&parent.codepoints())?, true, false)?,
        );
        Ok(identities)
    }
}
fn mapping(
    pair: &GoalPathPair,
    inventory: &reverie_contracts::goal_custody::GoalInventory,
) -> Result<()> {
    mapped(&pair.host().codepoints(), pair.server(), inventory)
}
fn mapped(
    host: &[u32],
    target: &PosixPath,
    inventory: &reverie_contracts::goal_custody::GoalInventory,
) -> Result<()> {
    let mut matches = Vec::new();
    for mount in inventory.server_mounts() {
        if mount.is_bind() {
            let destination = mount.destination()?;
            if target.is_relative_to(&destination) {
                matches.push((mount, destination));
            }
        }
    }
    let selected = matches
        .iter()
        .max_by_key(|(_, destination)| destination.components().len())
        .ok_or(GoalCustodyError::Refused(
            "Goal host/server scope mapping unavailable",
        ))?;
    need(
        matches
            .iter()
            .filter(|(_, dest)| dest == &selected.1)
            .count()
            == 1,
        "Goal host/server scope mapping ambiguous",
    )?;
    let path = selected.0.source()?.join(
        &target
            .relative_to(&selected.1)
            .expect("same checked ancestor"),
    );
    need(
        path.codepoints() == host && native::resolve_optional_text(&path.codepoints())? == path,
        "Goal host/server scope mapping unavailable",
    )
}
fn unexposed(protected: &[PosixPath], exposed: &[PosixPath]) -> Result<()> {
    need(
        !exposed.is_empty(),
        "Current Goal mount inventory unavailable",
    )?;
    let mut roots = Vec::new();
    for root in exposed {
        if !roots.iter().any(|(original, _)| original == root) {
            roots.push((
                root.clone(),
                native::resolve_strict_text(&root.codepoints())?,
            ));
        }
    }
    let mut checked = Vec::new();
    for target in protected {
        if checked.contains(target) {
            continue;
        }
        checked.push(target.clone());
        let resolved = native::resolve_optional_text(&target.codepoints())?;
        for (root, real_root) in &roots {
            need(
                ![target, &resolved]
                    .iter()
                    .any(|target| [root, real_root].iter().any(|root| target.overlaps(root))),
                "Private Goal scope exposed to a worker",
            )?;
        }
    }
    Ok(())
}
