//! Fixed destructive transaction. Durable pending evidence precedes the first
//! removal; every fallible native finalizer precedes the last fence unlink.
use super::*;
use super::{
    admission::Admission,
    directories::Directory,
    leases::{Bases, ClearKeys},
    tree::Tree,
};
use crate::{worker_launch::ObservedCreatePlan, worker_runtime::WorkerRuntime};
use reverie_contracts::worker_cold_tmp::{
    ColdConfiguration, ColdStrategy, clear_complete_record, clear_pending_record,
};
use reverie_core::ids::NativeOperationId;
use std::{ffi::OsStr, time::Duration};
type OwnerResult<T> = std::result::Result<T, StorageOwnerError>;
const PENDING: &str = "cold-tmp-cleanup.pending.json";
#[cfg(test)]
thread_local! {pub(in crate::worker_storage) static FAIL_FINALIZER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };}
pub(in crate::worker_storage) struct Cleared {
    pub(in crate::worker_storage) digest: String,
    pub(in crate::worker_storage) key: Key,
    pub(in crate::worker_storage) entries: usize,
}
#[derive(Default)]
struct Held {
    root: Option<Directory>,
    control: Option<Directory>,
    bases: Option<Bases>,
}
impl Held {
    fn root(&self) -> &Directory {
        self.root.as_ref().expect("actual TMP directory")
    }
    fn control(&self) -> &Directory {
        self.control.as_ref().expect("actual control directory")
    }
    fn bases(&self) -> &Bases {
        self.bases.as_ref().expect("actual lease bases")
    }
    fn check(&self, end: Instant) -> Result<()> {
        check(end)?;
        self.root().check()?;
        self.control().check()?;
        self.bases().check(end)
    }
    fn close(mut self) -> Result<()> {
        let mut result = Ok(());
        if let Some(bases) = self.bases.take() {
            result = finalized(result, bases.close());
        }
        if let Some(control) = self.control.take() {
            result = finalized(result, control.close());
        }
        if let Some(root) = self.root.take() {
            result = finalized(result, root.close());
        }
        result
    }
}
pub(in crate::worker_storage) fn run(
    runtime: &WorkerRuntime,
    storage: &mut LaunchStorage,
    plan: &ObservedCreatePlan,
    admission: &mut Admission,
    ceiling: Instant,
) -> OwnerResult<Cleared> {
    let source = plan.source();
    let policy = ColdConfiguration::capture(source)
        .map_err(StorageOwnerError::ColdData)?
        .ok_or(StorageOwnerError::Refused("WORKER_COLD_POLICY_REQUIRED"))?;
    require(
        policy.strategy() == ColdStrategy::Clear,
        "WORKER_COLD_CLEAR_STRATEGY_REQUIRED",
    )?;
    storage.require_no_cold_pending()?;
    crate::worker_validation::observe_cold_policy(source).map_err(StorageOwnerError::Cold)?;
    let config = Configuration::capture(source).map_err(StorageOwnerError::Storage)?;
    let original = super::super::temporary::path_text(&config, storage.paths())
        .map_err(StorageOwnerError::Storage)?;
    let target = storage.prepare_temporary()?;
    let mut held = Held::default();
    let mut effects = false;
    let result = (|| {
        let text = original.scratch().join(&PosixPath::from_scalar_text("tmp"));
        require(
            native::python_path(&text.codepoints()).map_err(StorageOwnerError::Path)? == target,
            "WORKER_COLD_TMP_BINDING",
        )?;
        held.root = Some(Directory::open(text, config.uid()).map_err(StorageOwnerError::Storage)?);
        held.control = Some(
            Directory::open(original.home().parent(), config.uid())
                .map_err(StorageOwnerError::Storage)?,
        );
        require(
            held.root()
                .file
                .metadata()
                .map_err(StorageOwnerError::Path)?
                .mode()
                & 0o7777
                == 0o700,
            "WORKER_COLD_PRIVATE_WRITABLE_TMP_REQUIRED",
        )?;
        let end = (Instant::now() + Duration::from_secs(10)).min(ceiling);
        let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
        held.bases = Some(
            Bases::capture(&policy, original.home(), &held.root().text, config.uid())
                .map_err(StorageOwnerError::Storage)?,
        );
        let mut invocation = Invocation {
            runtime,
            storage,
            plan,
            admission,
            end,
        };
        invocation.execute(&mut held, &config, policy.digest(), &mut effects)
    })();
    #[cfg(test)]
    if result.is_ok() && FAIL_FINALIZER.with(|flag| flag.replace(false)) {
        native::test_faults::set(None, true);
    }
    let result = finish(result, held.close())
        .and_then(|result| result.release().map_err(StorageOwnerError::Storage));
    result.map_err(|error| {
        if effects {
            StorageOwnerError::ColdUnconfirmed(Box::new(error))
        } else {
            error
        }
    })
}
struct Invocation<'a> {
    runtime: &'a WorkerRuntime,
    storage: &'a LaunchStorage,
    plan: &'a ObservedCreatePlan,
    admission: &'a mut Admission,
    end: Instant,
}
impl Invocation<'_> {
    fn guard(&mut self, held: &Held, keys: &BTreeSet<Key>) -> OwnerResult<()> {
        held.check(self.end).map_err(StorageOwnerError::Storage)?;
        self.admission
            .observe(self.runtime, self.storage, self.plan, keys, self.end)?;
        held.check(self.end).map_err(StorageOwnerError::Storage)
    }
    fn execute(
        &mut self,
        held: &mut Held,
        config: &Configuration,
        digest: String,
        effects: &mut bool,
    ) -> OwnerResult<Release> {
        let rootkey = Stamp::capture(
            &held
                .root()
                .file
                .metadata()
                .map_err(StorageOwnerError::Path)?,
        )
        .key;
        self.guard(held, &BTreeSet::from([rootkey]))?;
        held.bases
            .as_mut()
            .expect("captured bases")
            .barriers(self.end)
            .map_err(StorageOwnerError::Storage)?;
        let scratch = PosixPath::try_new(config.settings.scratch_root().codepoints())
            .expect("checked configuration codepoints");
        let keys = ClearKeys::observe(&held.root().file, &held.root().text, &scratch, self.end)
            .map_err(StorageOwnerError::Storage)?;
        held.bases
            .as_mut()
            .expect("barriers held")
            .clear_locks(&keys.all, self.end)
            .map_err(StorageOwnerError::Storage)?;
        let tree = Tree::scan(&held.root().file, config.uid(), self.end)
            .map_err(StorageOwnerError::Storage)?;
        require(
            tree.directory_keys() == keys.directories,
            "WORKER_COLD_LEASE_TREE_CHANGED",
        )?;
        self.guard(held, tree.keys())?;
        references::strict(tree.keys(), held.root().file.as_raw_fd(), self.end)
            .map_err(StorageOwnerError::Storage)?;
        held.check(self.end).map_err(StorageOwnerError::Storage)?;
        let mut entropy = [0; 16];
        getrandom::getrandom(&mut entropy)
            .map_err(|error| StorageOwnerError::Path(std::io::Error::other(error.to_string())))?;
        let attempt = NativeOperationId::from_random_bytes(entropy);
        *effects = true;
        let pending = held
            .control()
            .publish(
                OsStr::new(PENDING),
                &clear_pending_record(
                    &attempt,
                    self.storage.paths().identity(),
                    self.storage.paths().session(),
                    rootkey,
                ),
            )
            .map_err(StorageOwnerError::Storage)?;
        self.guard(held, tree.keys())?;
        // No alternate path or retry can remove entries without this actual
        // inventory, held canonical barriers and already durable pending record.
        for index in 0..tree.count() {
            held.check(self.end).map_err(StorageOwnerError::Storage)?;
            tree.remove_entry(index, &held.root().file, self.end)
                .map_err(StorageOwnerError::Storage)?;
        }
        self.guard(held, tree.keys())?;
        references::strict(tree.keys(), held.root().file.as_raw_fd(), self.end)
            .map_err(StorageOwnerError::Storage)?;
        tree.finish_removal(&held.root().file, self.end)
            .map_err(StorageOwnerError::Storage)?;
        let complete = format!("cold-tmp-complete-{}.json", attempt.as_str());
        held.control()
            .publish(
                OsStr::new(&complete),
                &clear_complete_record(
                    &attempt,
                    self.storage.paths().identity(),
                    self.storage.paths().session(),
                    rootkey,
                    tree.count(),
                ),
            )
            .map_err(StorageOwnerError::Storage)?;
        held.check(self.end).map_err(StorageOwnerError::Storage)?;
        held.control()
            .named(OsStr::new(PENDING), &pending)
            .map_err(StorageOwnerError::Storage)?;
        Ok(Release {
            control: held.control().text.clone(),
            control_stamp: Stamp::capture(
                &held
                    .control()
                    .file
                    .metadata()
                    .map_err(StorageOwnerError::Path)?,
            ),
            pending,
            end: self.end,
            report: Cleared {
                digest,
                key: rootkey,
                entries: tree.count(),
            },
        })
    }
}

struct Release {
    control: PosixPath,
    control_stamp: Stamp,
    pending: Stamp,
    end: Instant,
    report: Cleared,
}
impl Release {
    fn release(self) -> Result<Cleared> {
        check(self.end)?;
        let path = native::python_path(&self.control.codepoints())?;
        need(
            native::resolve_strict_text(&self.control.codepoints())? == self.control
                && self
                    .control_stamp
                    .same_directory(&Stamp::capture(&std::fs::symlink_metadata(&path)?)),
            StorageFault::ColdTree,
        )?;
        let pending = path.join(PENDING);
        need(
            Stamp::capture(&std::fs::symlink_metadata(&pending)?) == self.pending,
            StorageFault::ColdTree,
        )?;
        // LAST syscall; all descriptor/lock finalizers have already succeeded.
        // No fsync, owner readback or retry follows fence release here.
        std::fs::remove_file(pending)?;
        Ok(self.report)
    }
}
fn require(ok: bool, code: &'static str) -> OwnerResult<()> {
    if ok {
        Ok(())
    } else {
        Err(StorageOwnerError::Refused(code))
    }
}
fn finish<T>(primary: OwnerResult<T>, closed: Result<()>) -> OwnerResult<T> {
    match (primary, closed.map_err(StorageOwnerError::Storage)) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(StorageOwnerError::Finalized {
            primary: Box::new(primary),
            secondary: vec![secondary],
        }),
    }
}
