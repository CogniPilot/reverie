//! A ready console can gain dedicated worker bridges as employees enter the
//! office. Verify both Docker endpoints before carrying a new bridge forward.
use super::*;
use crate::installation::digest;
use reverie_core::ids::{NativeOperationId, ProfileEmployeeId};

const CHANGED: &str = "DEPLOYMENT_NETWORK_CHANGED";
const EMPLOYEE_LABEL: &str = "reverie.boxed.employee";

impl Topology {
    pub(crate) fn require_claim_successor(
        &self,
        current: &Self,
        source: &Value,
        engine: &Engine,
    ) -> Result<()> {
        for endpoint in self.claim_additions(current)? {
            let path = format!("/networks/{}", endpoint.network_id);
            let expected = configuration(
                current.configurations[&endpoint.network_id].clone(),
                endpoint,
            )?;
            let observed = engine.json("GET", &path, None)?;
            require(
                configuration(observed.clone(), endpoint)? == expected,
                CHANGED,
            )?;
            let bridge = WorkerBridge::observe(endpoint, &observed, source)?;
            let worker = engine.container(bridge.worker_id)?;
            bridge.require_worker(&worker)?;
            // A worker can move while its container metadata is being read.
            let after = engine.json("GET", &path, None)?;
            require(
                WorkerBridge::observe(endpoint, &after, source)? == bridge
                    && configuration(after, endpoint)? == expected,
                CHANGED,
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Eq, PartialEq)]
struct WorkerBridge<'a> {
    endpoint: &'a Endpoint,
    deployment: &'a str,
    employee: &'a str,
    worker_id: &'a str,
    worker_name: &'a str,
}

impl<'a> WorkerBridge<'a> {
    fn observe(endpoint: &'a Endpoint, network: &'a Value, source: &'a Value) -> Result<Self> {
        let deployment = model::string(source, "Name")?
            .strip_prefix('/')
            .ok_or_else(|| crate::DeploymentError::new(CHANGED))?;
        let employee = model::string(&network["Labels"], EMPLOYEE_LABEL)?;
        let id = model::string(source, "Id")?;
        model::cid(id)?;
        require(
            ProfileEmployeeId::parse(employee).is_ok()
                && network["Id"] == endpoint.network_id
                && network["Name"] == endpoint.name
                && endpoint.aliases == [deployment]
                && worker_bridge_name(&endpoint.name, employee),
            CHANGED,
        )?;
        let members = network["Containers"]
            .as_object()
            .ok_or_else(|| crate::DeploymentError::new(CHANGED))?;
        require(
            members.len() == 2 && members[id]["Name"] == deployment,
            CHANGED,
        )?;
        let (worker_id, worker) = members
            .iter()
            .find(|(member, _)| *member != id)
            .ok_or_else(|| crate::DeploymentError::new(CHANGED))?;
        model::cid(worker_id)?;
        Ok(Self {
            endpoint,
            deployment,
            employee,
            worker_id,
            worker_name: model::string(worker, "Name")?,
        })
    }

    fn require_worker(&self, worker: &Value) -> Result<()> {
        let labels = &worker["Config"]["Labels"];
        let box_id = model::cid(model::string(labels, "reverie.boxed.box")?)?;
        let operation = model::string(labels, "reverie.boxed.operation")?;
        require(NativeOperationId::parse(operation).is_ok(), CHANGED)?;
        // This is the boxed runtime's canonical destination name. The three
        // components are lowercase ASCII, with identical JSON encoding.
        let identity = serde_json::to_vec(&[box_id, "destination", operation])?;
        let expected_name = format!("reverie-boxed-{}", digest(&identity));
        let networks = worker["NetworkSettings"]["Networks"]
            .as_object()
            .ok_or_else(|| crate::DeploymentError::new(CHANGED))?;
        require(
            worker["Id"] == self.worker_id
                && worker["Name"].as_str().and_then(|n| n.strip_prefix('/'))
                    == Some(expected_name.as_str())
                && self.worker_name == expected_name
                && labels[EMPLOYEE_LABEL] == self.employee
                && labels["reverie.boxed.instance"] == self.deployment
                && worker["Config"]["Entrypoint"]
                    == json!(["/opt/reverie/perf/bin/reverie-worker-init"])
                && networks.len() == 1
                && networks
                    .get(&self.endpoint.name)
                    .is_some_and(|row| row["NetworkID"] == self.endpoint.network_id),
            CHANGED,
        )
    }
}

fn worker_bridge_name(name: &str, employee: &str) -> bool {
    let Some(suffix) = name.strip_prefix("reverie-boxed-api-") else {
        return false;
    };
    let prefix = &employee[..8];
    suffix == employee.replace('-', "")
        || suffix.strip_prefix(prefix).is_some_and(|value| {
            value == "-bootstrap"
                || value.strip_prefix("-move").is_some_and(|operation| {
                    operation.len() == 8
                        && operation
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                })
        })
}
