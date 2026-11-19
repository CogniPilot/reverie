use crate::offline_store::{bytes, observation_reply, path, seat_data};
use base64::{Engine, engine::general_purpose::STANDARD};
use reverie_application::offline_worker_store::{self, Snapshot};
use reverie_core::ids::{OfflineStoreOperationId, ProfileEmployeeId};
use reverie_host::worker_nix::offline_store_engine::{self, Query};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use std::{io, path::PathBuf, time::SystemTime};

const BOUND: usize = 48 * 1024 * 1024;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Snapshot(Inputs),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    #[serde(deserialize_with = "path")]
    config: PathBuf,
    #[serde(deserialize_with = "path")]
    target: PathBuf,
    employee: String,
    operation: Option<String>,
    fixture: Option<Fixture>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    now: f64,
    identity: String,
    image: Box<RawValue>,
    validation: Box<RawValue>,
    validation_id: String,
    base: String,
    inventory: Vec<Row>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    id: String,
    data: Box<RawValue>,
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, BOUND)?;
    let Request::Snapshot(request) = serde_json::from_slice(&input)?;
    if request.fixture.is_none() && input.len() > crate::REQUEST_BOUND {
        return Err(crate::refused());
    }
    observation_reply(request.capture(), BOUND)
}

impl Inputs {
    fn capture(self) -> Result<Value> {
        let bad_ids = "exact operation/employee UUID required";
        let employee = ProfileEmployeeId::parse(&self.employee).map_err(|_| bad_ids)?;
        let operation = self
            .operation
            .as_deref()
            .map(OfflineStoreOperationId::parse)
            .transpose()
            .map_err(|_| bad_ids)?;
        let clock = || {
            self.fixture
                .as_ref()
                .map_or_else(epoch, |fixture| fixture.now)
        };
        let engine = |socket: &std::path::Path, query| match &self.fixture {
            Some(fixture) => fixture.query(query),
            None => offline_store_engine::read(socket, query),
        };
        let observed = offline_worker_store::snapshot(
            &self.config,
            &self.target,
            &employee,
            operation.as_ref(),
            clock,
            &engine,
        )?;
        Ok(bytes(reply(observed)?))
    }
}

impl Fixture {
    // Compatibility tests still inject their existing engine at this read
    // boundary. The installed command uses the actual Docker observer.
    fn query(&self, query: Query) -> Result<Vec<u8>> {
        match query {
            Query::Identity => Ok(serde_json::to_vec(&self.identity)?),
            Query::Image(_) => Ok(self.image.get().as_bytes().to_vec()),
            Query::Base(_) => Ok(serde_json::to_vec(&self.base)?),
            Query::Inventory if self.inventory.len() <= 256 => Ok(serde_json::to_vec(
                &self.inventory.iter().map(|row| &row.id).collect::<Vec<_>>(),
            )?),
            Query::Inventory => Err("container inventory unavailable".into()),
            Query::Inspect(ids) if matches!(ids.as_slice(), [id] if id.as_str() == self.validation_id) => {
                Ok(serde_json::to_vec(&[&self.validation])?)
            }
            Query::Inspect(ids) => {
                let rows = ids
                    .iter()
                    .map(|id| {
                        self.inventory
                            .iter()
                            .find(|row| row.id == id.as_str())
                            .map(|row| &row.data)
                            .ok_or("container inventory changed")
                    })
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(serde_json::to_vec(&rows)?)
            }
        }
    }
}

fn epoch() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(f64::NAN, |duration| duration.as_secs_f64())
}

#[derive(Serialize)]
struct Capture {
    config: String,
    target: String,
    seat: Value,
    facts: Box<RawValue>,
}

fn reply(snapshot: Snapshot) -> Result<Vec<u8>> {
    if let Some(plan) = snapshot.plan {
        return Ok(plan);
    }
    Ok(serde_json::to_vec(&Capture {
        config: STANDARD.encode(snapshot.configuration),
        target: STANDARD.encode(snapshot.target.bytes),
        seat: seat_data(&snapshot.seat),
        facts: snapshot.facts,
    })?)
}
