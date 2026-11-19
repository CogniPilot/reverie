use crate::{
    configuration::{hex, session_id},
    invalid,
};
use serde::{Deserialize, de::DeserializeOwned};
use std::{
    collections::HashMap, future::Future, io, net::Ipv4Addr, pin::Pin, process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore, time::timeout};

/// The observed endpoint is bound to both container and network identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Target {
    pub container: String,
    pub network: String,
    pub address: Ipv4Addr,
}

pub trait Lookup: Send + Sync + 'static {
    fn resolve<'a>(
        &'a self,
        session: &'a str,
    ) -> Pin<Box<dyn Future<Output = io::Result<Target>> + Send + 'a>>;
}

pub struct DockerLookup {
    deployment: String,
    commands: Semaphore,
}

impl DockerLookup {
    pub fn new(config: &crate::Config) -> Self {
        Self {
            deployment: config.deployment.clone(),
            commands: Semaphore::new(2),
        }
    }

    async fn lookup(&self, session: &str) -> io::Result<Target> {
        if !session_id(session) {
            return Err(invalid("invalid laptop session"));
        }
        let _slot = self.commands.acquire().await.map_err(io::Error::other)?;
        let name = format!("{}-agent-{session}", self.deployment);
        let container: String = inspect(&["inspect", "--format", "{{json .Id}}", &name]).await?;
        if !hex(&container, 64) {
            return Err(invalid("invalid observed container id"));
        }
        let metadata: Container =
            inspect(&["inspect", "--format", CONTAINER_FORMAT, &container]).await?;
        let network = metadata.network(&name, &self.deployment, session)?;
        let bridge: Bridge = inspect(&[
            "network",
            "inspect",
            "--format",
            NETWORK_FORMAT,
            &network.id,
        ])
        .await?;
        if bridge.driver != "bridge" || !bridge.labels.owned(&self.deployment, session) {
            return Err(invalid("unregistered laptop network"));
        }
        Ok(Target {
            container,
            network: network.id.clone(),
            address: network.address,
        })
    }
}

impl Lookup for DockerLookup {
    fn resolve<'a>(
        &'a self,
        session: &'a str,
    ) -> Pin<Box<dyn Future<Output = io::Result<Target>> + Send + 'a>> {
        Box::pin(self.lookup(session))
    }
}

const CONTAINER_FORMAT: &str = r#"{"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}}}"#;
const NETWORK_FORMAT: &str = r#"{"labels":{{json .Labels}},"driver":{{json .Driver}}}"#;

#[derive(Deserialize)]
struct Container {
    running: bool,
    labels: Labels,
    networks: HashMap<String, Network>,
}

impl Container {
    fn network(&self, name: &str, deployment: &str, session: &str) -> io::Result<&Network> {
        let network = self
            .networks
            .get(&format!("{name}-lan"))
            .filter(|network| network.address.is_private() && hex(&network.id, 64));
        if !self.running || !self.labels.owned(deployment, session) || self.networks.len() != 1 {
            return Err(invalid("laptop ownership or network mismatch"));
        }
        network.ok_or_else(|| invalid("laptop network unavailable"))
    }
}

#[derive(Deserialize)]
struct Network {
    #[serde(rename = "IPAddress")]
    address: Ipv4Addr,
    #[serde(rename = "NetworkID")]
    id: String,
}

#[derive(Deserialize)]
struct Bridge {
    labels: Labels,
    driver: String,
}

#[derive(Deserialize)]
struct Labels {
    #[serde(rename = "reverie.worker")]
    worker: String,
    #[serde(rename = "reverie.session")]
    session: String,
}

impl Labels {
    fn owned(&self, deployment: &str, session: &str) -> bool {
        self.worker == deployment && self.session == session
    }
}

async fn inspect<T: DeserializeOwned>(args: &[&str]) -> io::Result<T> {
    timeout(Duration::from_secs(3), read_docker(args)).await?
}

async fn read_docker<T: DeserializeOwned>(args: &[&str]) -> io::Result<T> {
    let mut child = Command::new("docker")
        .args(args)
        .env("GOMAXPROCS", "2")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut out = Vec::new();
    child
        .stdout
        .take()
        .expect("piped Docker output")
        .take(32769)
        .read_to_end(&mut out)
        .await?;
    if out.len() > 32768 || !child.wait().await?.success() {
        return Err(invalid("laptop unavailable"));
    }
    Ok(serde_json::from_slice(&out)?)
}

#[cfg(test)]
mod tests {
    use super::Container;
    use serde_json::json;

    #[test]
    fn only_owned_dedicated_private_networks_are_selected() {
        for (ipv4, allowed) in [
            ("172.30.0.2", true),
            ("127.0.0.1", false),
            ("169.254.169.254", false),
            ("8.8.8.8", false),
            ("0.0.0.0", false),
        ] {
            let metadata: Container = serde_json::from_value(json!({
                "running": true,
                "labels": {"reverie.worker": "fixture", "reverie.session": "session"},
                "networks": {"laptop-lan": {"IPAddress": ipv4, "NetworkID": "a".repeat(64)}},
            }))
            .unwrap();
            assert_eq!(
                metadata.network("laptop", "fixture", "session").is_ok(),
                allowed
            );
            assert!(metadata.network("laptop", "another", "session").is_err());
            assert!(metadata.network("other", "fixture", "session").is_err());
        }
    }
}
