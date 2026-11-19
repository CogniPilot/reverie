//! Original website network grants. Serialized topology is correlation DATA;
//! the service reobserves the exact Engine objects before each effect phase.
use crate::{Result, engine::Engine, model, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const INVALID: &str = "DEPLOYMENT_NETWORK_UNSUPPORTED";
#[cfg(test)]
mod tests;
mod worker;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    name: String,
    network_id: String,
    aliases: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Topology {
    version: u32,
    endpoints: Vec<Endpoint>,
    configurations: BTreeMap<String, Value>,
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 254
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn empty(value: &Value) -> bool {
    value.is_null() || value.as_object().is_some_and(serde_json::Map::is_empty)
}

fn aliases(value: &Value) -> Result<Vec<String>> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let rows = value
        .as_array()
        .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
    require(rows.len() <= 16, INVALID)?;
    let mut names = BTreeSet::new();
    for row in rows {
        let text = row
            .as_str()
            .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
        require(name(text) && names.insert(text.to_owned()), INVALID)?;
    }
    Ok(names.into_iter().collect())
}

fn endpoints(source: &Value) -> Result<Vec<Endpoint>> {
    let rows = source["NetworkSettings"]["Networks"]
        .as_object()
        .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
    require(
        !rows.is_empty() && rows.len() <= 16 && rows.contains_key("bridge"),
        INVALID,
    )?;
    let mut output = Vec::new();
    let mut identities = BTreeSet::new();
    for (key, row) in rows {
        require(
            name(key) && !["host", "none"].contains(&key.as_str()),
            INVALID,
        )?;
        let id = model::string(row, "NetworkID")?;
        require(
            model::cid(id).is_ok() && identities.insert(id.to_owned()),
            INVALID,
        )?;
        require(
            empty(&row["IPAMConfig"])
                && empty(&row["DriverOpts"])
                && (row["GwPriority"].is_null() || row["GwPriority"] == 0)
                && (row["Links"].is_null() || row["Links"].as_array().is_some_and(Vec::is_empty)),
            INVALID,
        )?;
        let aliases = aliases(&row["Aliases"])?;
        require(key != "bridge" || aliases.is_empty(), INVALID)?;
        output.push(Endpoint {
            name: key.clone(),
            network_id: id.to_owned(),
            aliases,
        });
    }
    output.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(output)
}

fn configuration(value: Value, endpoint: &Endpoint) -> Result<Value> {
    require(
        value["Id"] == endpoint.network_id
            && value["Name"] == endpoint.name
            && value["Driver"] == "bridge"
            && value["Scope"] == "local"
            && value["Ingress"] == false
            && value["ConfigOnly"] == false,
        INVALID,
    )?;
    let mut fields = value
        .as_object()
        .cloned()
        .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
    // Membership changes normally when the candidate starts. It is not a
    // network configuration change and is never used to select another object.
    fields.remove("Containers");
    normalize_allocation_status(&mut fields)?;
    Ok(Value::Object(fields))
}

fn normalize_allocation_status(fields: &mut serde_json::Map<String, Value>) -> Result<()> {
    let Some(status) = fields.get_mut("Status") else {
        return Ok(());
    };
    let status = status
        .as_object_mut()
        .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
    require(status.len() == 1 && status.contains_key("IPAM"), INVALID)?;
    let ipam = status
        .get_mut("IPAM")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
    require(ipam.len() == 1 && ipam.contains_key("Subnets"), INVALID)?;
    let subnets = ipam
        .get_mut("Subnets")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
    require(subnets.len() <= 128, INVALID)?;
    for (subnet, counters) in subnets {
        require(
            !subnet.is_empty() && subnet.len() <= 128 && !subnet.chars().any(char::is_control),
            INVALID,
        )?;
        let counters = counters
            .as_object_mut()
            .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
        require(
            counters.is_empty()
                || (counters.len() == 2
                    && counters.get("IPsInUse").is_some_and(Value::is_u64)
                    && counters
                        .get("DynamicIPsAvailable")
                        .is_some_and(Value::is_u64)),
            INVALID,
        )?;
        // These two allocation counters change on STOP/START. Keep the subnet
        // keys and every static field; normalized empty leaves revalidate.
        counters.remove("IPsInUse");
        counters.remove("DynamicIPsAvailable");
    }
    Ok(())
}

fn default_bridge_settings(mut config: Value) -> Result<Value> {
    require(
        config["Options"]["com.docker.network.bridge.default_bridge"] == "true",
        "DEPLOYMENT_NETWORK_CHANGED",
    )?;
    let fields = config
        .as_object_mut()
        .expect("validated network configuration");
    fields.remove("Id");
    fields.remove("Created");
    Ok(config)
}

impl Topology {
    pub(super) fn preview(&self) -> BTreeMap<String, String> {
        self.endpoints
            .iter()
            .map(|endpoint| (endpoint.name.clone(), endpoint.network_id.clone()))
            .collect()
    }
    pub(super) fn capture(source: &Value, engine: &Engine) -> Result<Self> {
        let endpoints = endpoints(source)?;
        let mut observations = Vec::new();
        for endpoint in &endpoints {
            observations.push(engine.json(
                "GET",
                &format!("/networks/{}", endpoint.network_id),
                None,
            )?);
        }
        Self::observed(source, observations)
    }

    fn observed(source: &Value, observations: Vec<Value>) -> Result<Self> {
        let endpoints = endpoints(source)?;
        require(observations.len() == endpoints.len(), INVALID)?;
        let mut configurations = BTreeMap::new();
        for endpoint in &endpoints {
            let matching: Vec<_> = observations
                .iter()
                .filter(|value| value["Id"] == endpoint.network_id)
                .collect();
            require(matching.len() == 1, INVALID)?;
            configurations.insert(
                endpoint.network_id.clone(),
                configuration(matching[0].clone(), endpoint)?,
            );
        }
        Ok(Self {
            version: 1,
            endpoints,
            configurations,
        })
    }

    pub(super) fn validate(&self) -> Result<()> {
        require(
            self.version == 1
                && !self.endpoints.is_empty()
                && self.endpoints.len() <= 16
                && self.configurations.len() == self.endpoints.len(),
            INVALID,
        )?;
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        for endpoint in &self.endpoints {
            require(
                name(&endpoint.name)
                    && !["host", "none"].contains(&endpoint.name.as_str())
                    && (endpoint.name != "bridge" || endpoint.aliases.is_empty())
                    && model::cid(&endpoint.network_id).is_ok()
                    && ids.insert(&endpoint.network_id)
                    && names.insert(&endpoint.name),
                INVALID,
            )?;
            require(
                aliases(&json!(endpoint.aliases))? == endpoint.aliases,
                INVALID,
            )?;
            let value = self
                .configurations
                .get(&endpoint.network_id)
                .ok_or_else(|| crate::DeploymentError::new(INVALID))?;
            // Old on-disk plans retain raw counters and must remain byte-exact.
            // Validate their projection without changing serialized selection.
            configuration(value.clone(), endpoint)?;
            require(value.get("Containers").is_none(), INVALID)?;
        }
        require(
            names.contains(&"bridge".to_owned())
                && self
                    .endpoints
                    .windows(2)
                    .all(|pair| pair[0].name < pair[1].name),
            INVALID,
        )
    }

    pub(super) fn require_current(&self, engine: &Engine) -> Result<()> {
        self.validate()?;
        let mut observations = Vec::new();
        for endpoint in &self.endpoints {
            observations.push(engine.json(
                "GET",
                &format!("/networks/{}", endpoint.network_id),
                None,
            )?);
        }
        self.require_observations(observations)
    }

    fn require_observations(&self, observations: Vec<Value>) -> Result<()> {
        self.validate()?;
        require(
            observations.len() == self.endpoints.len(),
            "DEPLOYMENT_NETWORK_CHANGED",
        )?;
        for endpoint in &self.endpoints {
            let matching: Vec<_> = observations
                .iter()
                .filter(|value| value["Id"] == endpoint.network_id)
                .collect();
            require(
                matching.len() == 1
                    && configuration(self.configurations[&endpoint.network_id].clone(), endpoint)?
                        == configuration(matching[0].clone(), endpoint)?,
                "DEPLOYMENT_NETWORK_CHANGED",
            )?;
        }
        Ok(())
    }

    pub(super) fn require_container(&self, source: &Value) -> Result<()> {
        self.validate()?;
        let observed = endpoints(source)?;
        require(
            observed.len() == self.endpoints.len(),
            "DEPLOYMENT_NETWORK_CHANGED",
        )?;
        for (actual, expected) in observed.iter().zip(&self.endpoints) {
            require(
                actual.name == expected.name
                    && actual.aliases == expected.aliases
                    && actual.network_id == expected.network_id,
                "DEPLOYMENT_NETWORK_CHANGED",
            )?;
        }
        Ok(())
    }

    fn claim_additions<'a>(&self, current: &'a Self) -> Result<Vec<&'a Endpoint>> {
        self.validate()?;
        current.validate()?;
        let changed = "DEPLOYMENT_NETWORK_CHANGED";
        for previous in &self.endpoints {
            let current_endpoint = current
                .endpoints
                .iter()
                .find(|endpoint| endpoint.name == previous.name)
                .ok_or_else(|| crate::DeploymentError::new(changed))?;
            require(previous.aliases == current_endpoint.aliases, changed)?;
            let mut before =
                configuration(self.configurations[&previous.network_id].clone(), previous)?;
            let mut after = configuration(
                current.configurations[&current_endpoint.network_id].clone(),
                current_endpoint,
            )?;
            if previous.name == "bridge" && previous.network_id != current_endpoint.network_id {
                // Docker recreates the built-in bridge at daemon startup. The
                // successor pins the new ID, while the predecessor stays intact.
                before = default_bridge_settings(before)?;
                after = default_bridge_settings(after)?;
            }
            require(before == after, changed)?;
        }
        Ok(current
            .endpoints
            .iter()
            .filter(|endpoint| !self.endpoints.iter().any(|old| old.name == endpoint.name))
            .collect())
    }

    pub(super) fn request(&self) -> Result<Value> {
        self.validate()?;
        let entries: serde_json::Map<_, _> = self
            .endpoints
            .iter()
            .map(|endpoint| {
                // Moby getNetworkID prefers this exact NetworkID for user-defined
                // networks. Names remain map keys; allocated addresses/EndpointID/
                // DNSNames are deliberately not replayed as configuration.
                (
                    endpoint.name.clone(),
                    json!({"NetworkID": endpoint.network_id, "Aliases": endpoint.aliases}),
                )
            })
            .collect();
        Ok(json!({"EndpointsConfig": entries}))
    }
}
