//! The two child processes own the genuine original service/resource stacks.
use super::*;
mod tests;
struct Worker {
    sid: ProfileSessionId,
    cid: String,
    home: PathBuf,
    client: Option<UnixStream>,
    frames: Frames,
}
impl Worker {
    fn take(attempt: &mut Attempt, frames: Frames) -> Result<Self> {
        Ok(Self {
            sid: attempt.tenant.sid.clone(),
            cid: attempt
                .worker
                .take()
                .ok_or("actual created/recovered CID")?,
            home: attempt.home.take().ok_or("actual original storage home")?,
            client: attempt.client.take(),
            frames,
        })
    }
    fn select(self, attempt: &mut Attempt) -> Frames {
        attempt.tenant.sid = self.sid;
        attempt.worker = Some(self.cid);
        attempt.home = Some(self.home);
        attempt.client = self.client;
        self.frames
    }
    fn receipt(&self) -> serde_json::Value {
        serde_json::json!({"containerId":self.cid,"sessionId":self.sid.as_str()})
    }
}

pub(super) fn original(attempt: &mut Attempt, layout: &Layout) -> Result<()> {
    attempt.bootstrap()?;
    attempt.create_anchor()?;
    attempt.start_service()?;
    let frames = attempt.begin_cold()?;
    attempt.viewer_eof()?;
    let original = Worker::take(attempt, frames)?;
    attempt.tenant.sid = layout.session(&layout.sibling)?;
    let frames = attempt.begin_held()?;
    let sibling = Worker::take(attempt, frames)?;
    write_receipt(
        attempt,
        "original-ready",
        &serde_json::json!({"original":original.receipt(),"sibling":sibling.receipt(),"anchor":{"containerId":attempt.server}}),
    )?;
    poll_until_request(attempt, "generation-close-original")?;
    retire_original(attempt, layout)?;
    let _frames = sibling.select(attempt);
    quarantine_original_shutdown(attempt)
}
fn quarantine_original_shutdown(attempt: &mut Attempt) -> Result<()> {
    attempt.broker().request_stop();
    let service = attempt.service.take().ok_or("same original service")?;
    let mut failure = service
        .run()
        .err()
        .ok_or("live original storage must not claim whole service known closed")?;
    let cause = failure.to_string();
    let typed_cause = format!("{:?}", failure.cause());
    let quarantinable = quarantinable_service_failure(failure.cause());
    let native = failure.settle_original_native_work();
    let native_diagnostic = format!("{native:?}");
    let native_known = native.is_ok();
    let native_quarantinable = native
        .as_ref()
        .err()
        .is_none_or(quarantinable_native_failure);
    attempt.native_settlement_failure = native.err();
    attempt.service_failure = Some(failure);
    write_receipt(
        attempt,
        "original-shutdown-observed",
        &serde_json::json!({
            "causeDisplay":cause,"causeDebug":typed_cause,
            "quarantinableServiceOutcome":quarantinable,
            "nativeSettlementKnown":native_known,
            "nativeSettlementDebug":native_diagnostic,
            "quarantinableNativeOutcome":native_quarantinable,
            "allResourcesClosed":false
        }),
    )?;
    require(
        quarantinable,
        "unexpected actual shutdown failure retained; cannot qualify process handover",
    )?;
    require(
        native_quarantinable,
        "native outcome outside exact quarantine contract; retain original failure",
    )?;
    write_receipt(
        attempt,
        "original-retained",
        &serde_json::json!({"serviceClosed":false,"allResourcesClosed":false,"nativeSettlementKnown":native_known,"retainedCause":cause,"quarantinedOutcome":true,"processExitRequired":true}),
    )?;
    // The same test harness process exits negatively with the whole original
    // failure retained by Attempt::Drop. No release/closure credit is minted.
    Err("ORIGINAL_GENERATION_QUARANTINED_EXPECTED_PROCESS_EXIT".into())
}
fn retire_original(attempt: &Attempt, layout: &Layout) -> Result<()> {
    let path = attempt.tenant.root.join("company.json");
    let mut company: serde_json::Value = read_json(&path)?;
    let row = company["employees"]
        .as_array_mut()
        .and_then(|rows| {
            rows.iter_mut()
                .find(|row| row["id"] == layout.original_employee)
        })
        .ok_or("same original employee record")?;
    row["sessionId"] = layout.replacement.clone().into();
    row["sessionGeneration"] = 2.into();
    replace_json(&path, &company)?;
    verify_sibling_intent(&attempt.tenant, layout)
}

pub(super) fn replacement(attempt: &mut Attempt, layout: &Layout) -> Result<()> {
    let ready: serde_json::Value =
        read_json(&attempt.tenant.root.join("generation-original-ready.json"))?;
    attempt.server = Some(original_anchor(attempt)?);
    attempt.bootstrap()?;
    attempt.start_service()?;
    select_recovered(attempt, &ready["sibling"], &layout.sibling)?;
    let frames = attempt.attach_original()?;
    let sibling = Worker::take(attempt, frames)?;
    wait_retired_closed(attempt, layout, &ready["original"])?;
    attempt.tenant.sid = layout.session(&layout.replacement)?;
    let frames = attempt.begin_held()?;
    let current = Worker::take(attempt, frames)?;
    write_receipt(
        attempt,
        "replacement-ready",
        &serde_json::json!({"oldLeaseReleased":true,"sibling":sibling.receipt(),"current":current.receipt()}),
    )?;
    poll_until_request(attempt, "generation-complete-cohort")?;
    let current_cid = current.cid.clone();
    let frames = current.select(attempt);
    attempt.complete_workload(frames)?;
    let frames = sibling.select(attempt);
    attempt.finish_workload(frames)?;
    attempt.stop_via_service()?;
    require_lease_closed(attempt, &layout.replacement)?;
    attempt.cleanup()?;
    remove_stopped(attempt, &ready["original"], &layout.original)?;
    remove_stopped(
        attempt,
        &serde_json::json!({"containerId":current_cid}),
        &layout.replacement,
    )?;
    write_receipt(
        attempt,
        "closed",
        &serde_json::json!({"replacementOwnersClosed":true,"originalClosureConfirmed":false,"oldLeaseReleased":true,"currentLeaseClosed":true,"siblingLeaseClosed":true,"RReleased":true}),
    )
}
fn original_anchor(attempt: &mut Attempt) -> Result<String> {
    let row = attempt.inspect(&attempt.tenant.server.clone())?;
    let id = row["Id"]
        .as_str()
        .ok_or("actual original anchor CID")?
        .to_owned();
    attempt.server = Some(id.clone());
    attempt.anchor_current(true)?;
    Ok(id)
}
fn select_recovered(attempt: &mut Attempt, receipt: &serde_json::Value, sid: &str) -> Result<()> {
    let selected = ProfileSessionId::parse(sid).map_err(|e| e.to_string())?;
    let life = attempt
        .broker()
        .installed
        .lifecycle()
        .map_err(|e| e.to_string())?;
    let entry = life
        .guard
        .iter()
        .find(|entry| entry.session == selected)
        .ok_or("fresh actual recovered registry member")?;
    require(
        matches!(
            entry.owner,
            crate::installing_broker::LaptopOwner::Recovered(_)
        ),
        "fresh generation must reconstruct actual Recovered owner",
    )?;
    drop(life);
    let storage = attempt
        .broker()
        .storage
        .runtime
        .resolve_storage(&attempt.tenant.config, &selected)
        .map_err(|e| e.to_string())?;
    attempt.tenant.sid = selected;
    attempt.worker = Some(
        receipt["containerId"]
            .as_str()
            .ok_or("actual original CID receipt")?
            .into(),
    );
    attempt.home = Some(storage.paths().home().into());
    Ok(())
}
fn wait_retired_closed(
    attempt: &mut Attempt,
    layout: &Layout,
    receipt: &serde_json::Value,
) -> Result<()> {
    let old = layout.session(&layout.original)?;
    loop {
        attempt
            .service
            .as_ref()
            .expect("same replacement service")
            .poll_handler()
            .map_err(|e| e.to_string())?;
        let present = attempt
            .broker()
            .installed
            .lifecycle()
            .map_err(|e| e.to_string())?
            .guard
            .iter()
            .any(|entry| entry.session == old);
        if !present {
            break;
        }
        require(
            Instant::now() < attempt.end,
            "original retired-session cleanup deadline; no replay",
        )?;
        std::thread::sleep(Duration::from_millis(10));
    }
    require_stopped(attempt, receipt, &layout.original)?;
    require_lease_closed(attempt, &layout.original)
}
fn require_lease_closed(attempt: &Attempt, sid: &str) -> Result<()> {
    let sid = ProfileSessionId::parse(sid).map_err(|e| e.to_string())?;
    reverie_host::worker_storage::StorageLease::acquire_launch(&attempt.tenant.config, &sid)
        .map_err(|e| e.to_string())?
        .close()
        .map_err(|e| e.to_string())
}
fn require_stopped(
    attempt: &mut Attempt,
    receipt: &serde_json::Value,
    sid: &str,
) -> Result<String> {
    let cid = receipt["containerId"]
        .as_str()
        .ok_or("same original actual CID")?;
    let row = attempt.inspect(cid)?;
    require(
        row["Id"] == cid
            && row["Name"] == format!("/{}-agent-{sid}", attempt.tenant.deployment)
            && row["Image"] == attempt.inputs.image.as_str()
            && row["Config"]["Labels"]["reverie.worker"] == attempt.tenant.deployment
            && row["Config"]["Labels"]["reverie.session"] == sid
            && row["State"]["Running"] == false
            && row["State"]["Paused"] == false
            && row["State"]["Restarting"] == false
            && row["State"]["Dead"] == false
            && row["State"]["Pid"].as_u64() == Some(0),
        "same original owned worker physically stopped before nonforce removal",
    )?;
    Ok(cid.into())
}
fn remove_stopped(attempt: &mut Attempt, receipt: &serde_json::Value, sid: &str) -> Result<()> {
    let id = require_stopped(attempt, receipt, sid)?;
    attempt.cli.success(&["rm", &id])?;
    require(
        attempt
            .cli
            .success(&["ps", "-aq", "--no-trunc", "--filter", &format!("id={id}")])?
            .trim()
            .is_empty(),
        "fresh exact original removed CID absence",
    )
}
fn poll_until_request(attempt: &Attempt, leaf: &str) -> Result<()> {
    while missing(&attempt.tenant.root.join(leaf))? {
        require(
            Instant::now() < attempt.end,
            "same original actor request deadline",
        )?;
        attempt
            .service
            .as_ref()
            .expect("same service")
            .poll_handler()
            .map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
fn write_receipt(attempt: &Attempt, phase: &str, value: &serde_json::Value) -> Result<()> {
    publish(
        &attempt.tenant.root.join(format!("generation-{phase}.json")),
        &serde_json::to_vec(value).map_err(|e| e.to_string())?,
    )
}
fn quarantinable_service_failure(error: &BrokerServiceError) -> bool {
    match error {
        BrokerServiceError::Recovery(crate::installing_broker::RecoveryError::Refused(
            "WORKER_SERVICE_STORAGE_RETAINED" | "WORKER_SERVICE_LAPTOPS_RETAINED",
        )) => true,
        BrokerServiceError::Runtime(error) => quarantinable_native_failure(error),
        BrokerServiceError::Shutdown(errors) => {
            !errors.is_empty() && errors.iter().all(quarantinable_service_failure)
        }
        _ => false,
    }
}
fn quarantinable_native_failure(error: &reverie_host::worker_runtime::RuntimeError) -> bool {
    match error {
        reverie_host::worker_runtime::RuntimeError::Laptop(error) => {
            quarantinable_laptop_custody(error)
        }
        _ => false,
    }
}
fn quarantinable_laptop_custody(error: &reverie_host::worker_laptop::LaptopError) -> bool {
    use reverie_host::worker_laptop::LaptopError;
    match error {
        LaptopError::Refused("WORKER_LAPTOP_RETAINED") => true,
        LaptopError::Finalization { primary, secondary } => {
            quarantinable_laptop_custody(primary) && quarantinable_laptop_custody(secondary)
        }
        _ => false,
    }
}
