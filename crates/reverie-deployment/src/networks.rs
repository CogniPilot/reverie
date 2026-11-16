//! Original website network grants. Serialized topology is correlation DATA;
//! the service reobserves the exact Engine objects before each effect phase.
use crate::{Result, engine::Engine, model, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const INVALID: &str = "DEPLOYMENT_NETWORK_UNSUPPORTED";
#[cfg(test)]
mod tests;

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
    Ok(Value::Object(fields))
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
            require(configuration(value.clone(), endpoint)? == *value, INVALID)?;
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
                    && self.configurations[&endpoint.network_id]
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
