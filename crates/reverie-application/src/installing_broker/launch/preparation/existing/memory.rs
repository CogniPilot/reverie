//! Initial create-policy check, then optional freshly resolved memory policy,
//! then host/native limits. No runtime.json, exit-file or pane reads yet.
use super::*;
use reverie_contracts::{
    reservation_engine::{ObservedMemoryPolicy, ReservationConfiguration},
    worker_config,
};

pub(super) struct VerifiedInspectedWorkerLaunch<'a> {
    pub(super) existing: InspectedWorkerLaunch<'a>,
    pub(super) running: bool,
}
impl<'a> InspectedWorkerLaunch<'a> {
    pub(super) fn verify_running(
        self,
    ) -> Result<VerifiedInspectedWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        match self.verify_running_current() {
            Ok(running) => Ok(VerifiedInspectedWorkerLaunch {
                existing: self,
                running,
            }),
            Err(cause) => Err(self
                .observed
                .claimed
                .into_failure(cause, Some(self.observed.current))),
        }
    }
    fn verify_running_current(&self) -> Result<bool, PreparationError> {
        let Some(previous) = &self.previous else {
            return Ok(false);
        };
        let previous = previous.data();
        if !previous.running()? {
            return Ok(false);
        }
        previous.assert_running_policy(self.observed.plan.arguments().policy_digest())?;
        let source = self.observed.current.configuration();
        if !ReservationConfiguration::capture(source.clone()).memory_policies_enabled() {
            return Ok(true);
        }
        let session = self.observed.plan.session();
        let effective = crate::resource_staging::effective_config(source.clone(), session)?;
        if ObservedMemoryPolicy::from_effective(&effective)?.is_none() {
            return Ok(true);
        }
        // Namespace was checked on this immutable row before Running. Keep
        // the original repeated effective-config read for memory's policy.
        let repeated = crate::resource_staging::effective_config(source.clone(), session)?;
        previous.assert_running_policy(&worker_config::policy_digest(&repeated))?;
        let runtime = &self.observed.claimed.preparing.broker().storage.runtime;
        let context =
            crate::reservation_observer::NativeObserver::capture_worker(runtime, source.clone());
        context.host_root()?;
        context.verify_launch_limits(previous)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::tests::{broker, broker_configuration, end, finish_claimed};
    use super::super::tests::observe;
    use super::*;
    use crate::reservation_gate::tests::Tree;

    fn row(tree: &Tree, policy: &str) {
        // No HostConfig/Id/runtime file: disabled/unselected memory must not
        // silently demand kernel declarations or perform later-phase I/O.
        tree.write("inspect.out", &serde_json::to_vec(&serde_json::json!([{
            "Config":{"Labels":{"reverie.worker":"test","reverie.session":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","reverie.worker-policy":policy}},
            "State":{"Running":true}
        }])).unwrap());
    }
    #[test]
    fn running_initial_policy_refuses_before_missing_native_fields_and_keeps_original_claim() {
        let tree = Tree::new();
        let broker = broker(&tree);
        tree.write("company.json", br#"{"employees":[]}"#);
        let observed = observe(&broker);
        row(&tree, "foreign-policy");
        let inspected = observed
            .inspect(end())
            .unwrap_or_else(|e| panic!("{}", e.cause));
        let failure = inspected.verify_running().err().unwrap();
        assert!(matches!(
            failure.cause,
            PreparationError::Existing(reverie_contracts::broker_laptop::LaptopReadError::Policy)
        ));
        assert!(failure.storage.is_some() && failure.active.is_some());
        let claimed = ClaimedWorkerLaunch {
            preparing: failure.preparing,
            storage: failure.storage,
            active: failure.active,
            observed: failure.observed.unwrap(),
            lifecycle: broker.installed.lifecycle().unwrap(),
        };
        finish_claimed(claimed);
        broker.close_command_telemetry(end()).unwrap();
    }
    #[test]
    fn running_disabled_and_unselected_memory_skip_kernel_without_laundering_created_or_started() {
        for enabled in [false, true] {
            let tree = Tree::new();
            let broker = if enabled {
                let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
                raw.as_object_mut().unwrap().remove("resourceReservations");
                raw["employeeMemoryPolicies"] =
                    serde_json::json!({"11111111-2222-4333-8444-555555555555":{"swapMiB":0}});
                broker_configuration(&tree, &raw)
            } else {
                broker(&tree)
            };
            tree.write("company.json", br#"{"employees":[]}"#);
            let observed = observe(&broker);
            row(&tree, &observed.plan.arguments().policy_digest().to_hex());
            let verified = observed
                .inspect(end())
                .unwrap_or_else(|e| panic!("{}", e.cause))
                .verify_running()
                .unwrap_or_else(|e| panic!("{}", e.cause));
            assert!(verified.running);
            assert!(
                verified
                    .existing
                    .previous
                    .as_ref()
                    .unwrap()
                    .data()
                    .canonical_id()
                    .is_none()
            );
            finish_claimed(verified.existing.observed.claimed);
            broker.close_command_telemetry(end()).unwrap();
        }
    }

    #[test]
    fn enabled_selected_memory_refuses_actual_runtime_stop_before_installed_host_or_limit_lookup() {
        crate::test_process::owning_case!(enabled_selected_memory_refuses_actual_runtime_stop_before_installed_host_or_limit_lookup);
        let tree = Tree::new();
        let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
        raw.as_object_mut().unwrap().remove("resourceReservations");
        raw["employeeMemoryPolicies"] =
            serde_json::json!({"11111111-2222-4333-8444-555555555555":{"swapMiB":0}});
        let broker = broker_configuration(&tree, &raw);
        tree.write("company.json", br#"{"employees":[{"id":"11111111-2222-4333-8444-555555555555","owner":null,"sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","desiredRunning":true}]}"#);
        let observed = observe(&broker);
        let effective = crate::resource_staging::effective_config(
            observed.current.configuration().clone(),
            observed.plan.session(),
        )
        .unwrap();
        assert!(
            ObservedMemoryPolicy::from_effective(&effective)
                .unwrap()
                .is_some(),
            "genuine selected EID policy, not the unselected branch"
        );
        row(&tree, &observed.plan.arguments().policy_digest().to_hex());
        let inspected = observed.inspect(end()).unwrap();
        crate::reservation_observer::tests::take_installed_reads();
        broker.storage.runtime.request_stop();
        let failure = inspected.verify_running().err().unwrap();
        let reads = crate::reservation_observer::tests::take_installed_reads();
        let code = failure.cause.to_string();
        let retained = failure.storage.is_some() && failure.active.is_some();
        let claimed = ClaimedWorkerLaunch {
            preparing: failure.preparing,
            storage: failure.storage,
            active: failure.active,
            observed: failure.observed.unwrap(),
            lifecycle: broker.installed.lifecycle().unwrap(),
        };
        finish_claimed(claimed);
        broker.close_command_telemetry(end()).unwrap();
        eprintln!(
            "actual enabled-memory stopped path: error={code}, installed_observations={reads:?}, original_owners_retained={retained}"
        );
        assert_eq!(code, "RESERVATION_OBSERVATION_CANCELLED");
        assert!(
            reads.is_empty(),
            "no actual Installed host/kernel dispatch after stop"
        );
        assert!(retained);
    }

    #[test]
    fn recovered_selected_memory_refuses_same_runtime_stop_before_installed_host_or_limit_lookup() {
        crate::test_process::owning_case!(recovered_selected_memory_refuses_same_runtime_stop_before_installed_host_or_limit_lookup);
        let tree = Tree::new();
        let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
        raw.as_object_mut().unwrap().remove("resourceReservations");
        raw["employeeMemoryPolicies"] =
            serde_json::json!({"11111111-2222-4333-8444-555555555555":{"swapMiB":0}});
        let broker = broker_configuration(&tree, &raw);
        tree.write("company.json", br#"{"employees":[{"id":"11111111-2222-4333-8444-555555555555","owner":null,"sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","desiredRunning":true}]}"#);
        let observed = observe(&broker);
        row(&tree, &observed.plan.arguments().policy_digest().to_hex());
        let inspected = observed.inspect(end()).unwrap();
        let snapshot = broker.configuration().unwrap();
        let runtime = &broker.storage.runtime;
        tree.write(
            "ps.out",
            b"test-agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n",
        );
        let census = runtime
            .observe_recovery_names(snapshot.envelope().base())
            .unwrap();
        let selected = &census.names().entries()[0].1;
        let recovered = runtime.inspect_recovery_laptop(&census, selected).unwrap();
        let effective = crate::resource_staging::effective_config(
            snapshot.configuration().clone(),
            recovered.session(),
        )
        .unwrap();
        assert!(
            ObservedMemoryPolicy::from_effective(&effective)
                .unwrap()
                .is_some()
        );
        crate::reservation_observer::tests::take_installed_reads();
        runtime.request_stop();
        let result =
            crate::worker_recovery::verify_recovered_memory(runtime, &snapshot, &recovered);
        let reads = crate::reservation_observer::tests::take_installed_reads();
        let code = result.err().unwrap().to_string();
        finish_claimed(inspected.observed.claimed);
        broker.close_command_telemetry(end()).unwrap();
        eprintln!(
            "actual recovered selected-memory stopped path: error={code}, installed_observations={reads:?}"
        );
        assert_eq!(code, "RESERVATION_OBSERVATION_CANCELLED");
        assert!(reads.is_empty());
    }
}
