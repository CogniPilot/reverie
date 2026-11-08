//! Explicit real Node/Docker constructor canary, never the normal test gate.
//! No successful Auth, peer, native observation or result is constructed by a
//! fixture shortcut. All domain authorization comes from the production factory.
use super::*;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_contracts::resource_actor::ResourceRequestSelection;
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_reports::AcceptedWorkerServiceConnection, worker_runtime::WorkerRuntime,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
};
mod http;
mod installation;
mod physical;
use http::Http;
type CaseResult<T> = std::result::Result<T, String>;
const EMPLOYEE: &str = "10000000-0000-4000-8000-000000000001";
const SESSION: &str = "10000000-0000-4000-8000-000000000002";
const KEY: &str = "10000000-0000-4000-8000-000000000003";
fn reason(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn require(value: bool, message: &str) -> CaseResult<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

struct Fixture {
    tree: Option<Tree>,
    http: Http,
    listener: UnixListener,
    cid: String,
    port: u16,
    closed: bool,
}
impl Fixture {
    fn tree(&self) -> &Tree {
        self.tree.as_ref().expect("owned fixture root")
    }
    fn run(&self, broker: &InstallingBroker) -> CaseResult<()> {
        for phase in [Phase::Positive, Phase::Logout, Phase::CompanyDrift] {
            self.wait_ended()?;
            let logged = self
                .http
                .website(self.port, "POST", "/login", None, Some(&json!({})))?;
            let cookie = logged
                .cookie
                .ok_or_else(|| "actual owner cookie absent".to_owned())?;
            let selected = self
                .http
                .website(
                    self.port,
                    "POST",
                    "/preview",
                    Some(&cookie),
                    Some(&json!({"idempotencyKey":KEY})),
                )?
                .value;
            let stream = self.accept()?;
            let accepted = broker
                .reports
                .register_worker_connection(stream)
                .map_err(reason)?;
            let AcceptedWorkerServiceConnection::Service(connection) = accepted
                .receive_service_for_worker(
                    &broker.telemetry,
                    broker.configuration().map_err(reason)?.configuration(),
                )
                .map_err(reason)?
            else {
                return Err("actual Q service record required".into());
            };
            require(
                u64::try_from(connection.peer().pid()).ok()
                    == self.container()?["State"]["Pid"].as_u64(),
                "actual direct Node peer must be the selected container init",
            )?;
            let website = match broker.prepare_resource_website(connection) {
                Ok(website) => website,
                Err(failure) => return Err(rejected(failure)),
            };
            let mut auth = match website.receive_operation() {
                Ok(auth) => auth,
                Err(failure) => return Err(rejected(failure)),
            };
            let body = self.check(&mut auth, phase, &cookie, &selected);
            if let Err(cleanup) = auth.close_channel_component(end()) {
                std::mem::forget(auth);
                return Err(format!(
                    "preclaim Q cleanup retained: {cleanup}; body:{body:?}"
                ));
            }
            body?;
        }
        Ok(())
    }
    fn check(
        &self,
        auth: &mut AuthenticatedResourceOperation<'_>,
        phase: Phase,
        cookie: &str,
        selected: &Value,
    ) -> CaseResult<()> {
        require(
            matches!(auth.request().selection(), ResourceRequestSelection::Preview { employee_id, idempotency_key, requested_memory_mib: 512 } if employee_id.as_str()==EMPLOYEE && idempotency_key.as_str()==KEY),
            "original real preview changed",
        )?;
        let original = auth.current_owner().map_err(reason)?.clone();
        require(
            original.owner().is_none()
                && selected["context"]["ownerScopeDigest"].as_str()
                    == Some(original.scope_digest().as_str()),
            "actual cookie context/owner changed",
        )?;
        auth.assert_current().map_err(reason)?;
        require(
            auth.current_owner().map_err(reason)? == &original,
            "fresh nonce changed original owner signature",
        )?;
        match phase {
            Phase::Positive => Ok(()),
            Phase::Logout => {
                self.http
                    .website(self.port, "POST", "/logout", Some(cookie), Some(&json!({})))?;
                let error = auth
                    .assert_current()
                    .err()
                    .ok_or_else(|| "revoked cookie still authorized".to_owned())?;
                require(
                    error.code() == "Worker peer identity is not authorized",
                    "logout did not refuse exact original socket peer",
                )
            }
            Phase::CompanyDrift => {
                self.write_company(Some("another-current-owner"))?;
                let observed = auth.assert_current();
                self.write_company(None)?;
                let error = observed
                    .err()
                    .ok_or_else(|| "current employee owner drift authorized".to_owned())?;
                require(
                    error.code() == "CURRENT_EMPLOYEE_REGISTRY",
                    "company drift did not reach actual current-owner guard",
                )
            }
        }
    }
    fn accept(&self) -> CaseResult<std::os::unix::net::UnixStream> {
        let limit = Instant::now() + Duration::from_secs(10);
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => return Ok(stream),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    require(Instant::now() < limit, "actual Node Q absent")?;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(reason(e)),
            }
        }
    }
    fn wait_ended(&self) -> CaseResult<()> {
        let limit = Instant::now() + Duration::from_secs(10);
        loop {
            if matches!(self.pending(), Ok(false)) {
                return Ok(());
            }
            require(
                Instant::now() < limit,
                "fixture original request still pending",
            )?;
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn pending(&self) -> CaseResult<bool> {
        let response = self.http.website(self.port, "GET", "/state", None, None)?;
        require(
            response.value["state"] != "UNEXPECTED_HOST_RESULT",
            "fixture received fabricated native result",
        )?;
        response.value["pending"]
            .as_bool()
            .ok_or_else(|| "fixture pending state absent".to_owned())
    }
    fn write_company(&self, owner: Option<&str>) -> CaseResult<()> {
        let row = json!({"id":EMPLOYEE,"sessionId":SESSION,"sessionGeneration":1,"startOnBoot":false,"vacation":true,"owner":owner});
        self.tree().write(
            "company.json",
            &serde_json::to_vec(&json!({"employees":[row],"retired":[]})).map_err(reason)?,
        );
        Ok(())
    }
}
#[derive(Clone, Copy)]
enum Phase {
    Positive,
    Logout,
    CompanyDrift,
}
fn rejected(mut failure: Box<ResourceActorFailure<'_>>) -> String {
    let cause = failure.cause().to_string();
    match failure.close_channel_component(end()) {
        Ok(_) => cause,
        Err(cleanup) => {
            std::mem::forget(failure);
            format!("{cause}; cleanup:{cleanup}")
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.closed {
            eprintln!(
                "UNSETTLED owned Q fixture CID={} root={}",
                self.cid,
                self.tree().root.display()
            );
            // No automatic replay/name cleanup after an unknown owning result.
        } else {
            eprintln!(
                "KNOWN_CLOSED owned Q fixture CID={} evidence={}",
                self.cid,
                self.tree().root.display()
            );
        }
        // Preserve the actual private installation/native readbacks on either
        // outcome. No destructor invokes Docker or erases retained evidence.
        std::mem::forget(self.tree.take());
    }
}

#[test]
#[ignore = "requires reviewed exact immutable Q fixture image/provenance/client; actual owned Docker only"]
fn actual_node_cookie_q_preview_and_late_owner_refusals() {
    let mut fixture = Fixture::create().expect("owned native Q setup");
    let broker = fixture.broker().expect("real configured installing broker");
    let result = fixture.run(&broker);
    if result.is_ok() {
        fixture
            .physical("after")
            .expect("actual website kernel limits unchanged");
        broker
            .reports
            .close(end())
            .expect("actual original Q records settled");
        broker
            .storage
            .runtime
            .close(end())
            .expect("actual metadata constructors settled");
        fixture.cleanup_known().expect("exact owned CID cleanup");
    }
    result.expect("native Q constructor must pass every production guard");
}
