//! Keep the real lifecycle mutex from active registration through the original
//! cold/storage/runtime-directory/argument phases. Nix releases it later.
use super::*;
use reverie_host::worker_launch::ObservedCreatePlan;

pub(super) struct ObservedWorkerLaunch<'a> {
    pub(super) claimed: ClaimedWorkerLaunch<'a>,
    pub(super) current: Arc<ValidatedWorkerSnapshot>,
    pub(super) plan: ObservedCreatePlan,
}
impl<'a> ClaimedWorkerLaunch<'a> {
    pub(super) fn observe(
        mut self,
    ) -> Result<ObservedWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        let current = match self.preparing.broker().configuration() {
            Ok(current) => current,
            Err(cause) => return Err(self.into_failure(cause.into(), None)),
        };
        let storage = self.storage.as_mut().expect("actual acquired storage");
        let result = (|| {
            storage.prepare_cold_launch_storage()?;
            storage.prepare_runtime_directory()?;
            storage
                .prepare_create_plan(&current)
                .map_err(PreparationError::from)
        })();
        match result {
            Ok(plan) => Ok(ObservedWorkerLaunch {
                claimed: self,
                current,
                plan,
            }),
            Err(cause) => Err(self.into_failure(cause, Some(current))),
        }
    }
    pub(super) fn into_failure(
        self,
        cause: PreparationError,
        current: Option<Arc<ValidatedWorkerSnapshot>>,
    ) -> Box<PreparationFailure<'a>> {
        let Self {
            preparing,
            storage,
            active,
            observed,
            lifecycle,
        } = self;
        drop(lifecycle);
        Box::new(PreparationFailure {
            preparing,
            storage,
            active,
            observed: Some(observed),
            current,
            cause,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{broker, end, finish_claimed, incoming};
    use super::*;
    use crate::reservation_gate::tests::Tree;
    use std::{fs, os::unix::fs::PermissionsExt};
    #[test]
    fn actual_locked_legacy_preparation_creates_runtime_before_argument_observation_and_keeps_same_scope()
     {
        let tree = Tree::new();
        let broker = broker(&tree);
        tree.write("company.json", br#"{"employees":[]}"#);
        let sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let (_client, admitted) = incoming(&broker, sid);
        let claimed = PreparingWorkerLaunch::enter(admitted)
            .unwrap_or_else(|_| panic!("early hold"))
            .claim()
            .unwrap_or_else(|e| panic!("{}", e.cause));
        let observed = claimed.observe().unwrap_or_else(|e| panic!("{}", e.cause));
        assert!(observed.plan.same_runtime(&broker.storage.runtime));
        assert_eq!(
            observed.plan.storage(),
            observed.claimed.storage.as_ref().unwrap().paths()
        );
        assert_eq!(
            reverie_contracts::worker_config::encode_config(observed.current.configuration()),
            reverie_contracts::worker_config::encode_config(observed.plan.source())
        );
        assert_eq!(
            fs::metadata(tree.root.join("state").join(sid))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        finish_claimed(observed.claimed);
        broker.close_command_telemetry(end()).unwrap();
    }
}
