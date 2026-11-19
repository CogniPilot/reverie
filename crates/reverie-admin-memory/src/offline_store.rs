use base64::{Engine, engine::general_purpose::STANDARD};
use reverie_contracts::worker_nix::offline_qualification::CapacityBudget;
use reverie_core::ids::{ContainerId, ProfileEmployeeId, ProfileSessionId};
use reverie_host::worker_nix::offline_qualification::{self, ControlPin, Seat};
use reverie_host::worker_nix::offline_store_engine::{self, Query};
use serde::{Deserialize, Deserializer, de};
use serde_json::{Value, json, value::RawValue};
use std::{
    ffi::OsString,
    io,
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};

const QUALIFICATION_REPLY_BOUND: usize = 16 * 1024 * 1024;
const ENGINE_REPLY_BOUND: usize = 24 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Engine {
        #[serde(deserialize_with = "path")]
        socket: PathBuf,
        query: EngineQuery,
    },
    Seat {
        config: Pin,
        session: String,
        employee: String,
        recheck_session_fence: bool,
    },
    Target {
        #[serde(deserialize_with = "path")]
        target: PathBuf,
        now: f64,
    },
    Profiles {
        home: Vec<u32>,
        nix: Vec<u32>,
        entries: usize,
    },
    Cohort {
        #[serde(deserialize_with = "path")]
        company: PathBuf,
        config: Pin,
        target: Pin,
        employee: Option<String>,
    },
    Capacity {
        budget: Box<RawValue>,
        cohort_size: u8,
        #[serde(deserialize_with = "path")]
        state: PathBuf,
        #[serde(deserialize_with = "path")]
        scratch: PathBuf,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum EngineQuery {
    Inventory {},
    Inspect { ids: Vec<String> },
}

impl EngineQuery {
    fn query(self) -> Result<Query, Box<dyn std::error::Error>> {
        Ok(match self {
            Self::Inventory {} => Query::Inventory,
            Self::Inspect { ids } => Query::Inspect(
                ids.iter()
                    .map(|id| ContainerId::parse(id))
                    .collect::<Result<_, _>>()?,
            ),
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    #[serde(deserialize_with = "path")]
    path: PathBuf,
    digest: String,
}

pub(super) fn path<'de, D: Deserializer<'de>>(input: D) -> Result<PathBuf, D::Error> {
    let encoded = String::deserialize(input)?;
    let bytes = STANDARD.decode(encoded).map_err(de::Error::custom)?;
    Ok(OsString::from_vec(bytes).into())
}

impl Pin {
    fn as_pin(&self) -> ControlPin<'_> {
        ControlPin {
            path: &self.path,
            digest: &self.digest,
        }
    }
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, crate::REQUEST_BOUND)?;
    let request: Request = serde_json::from_slice(&input)?;
    let bound = match request {
        Request::Engine { .. } => ENGINE_REPLY_BOUND,
        _ => QUALIFICATION_REPLY_BOUND,
    };
    observation_reply(request.execute(), bound)
}

pub(super) fn observation_reply(
    result: Result<Value, Box<dyn std::error::Error>>,
    bound: usize,
) -> io::Result<()> {
    let reply = result.unwrap_or_else(|error| {
        let errno = io_errno(error.as_ref());
        json!({"error": error.to_string(), "errno": errno})
    });
    crate::write_reply(&reply, bound)
}

fn io_errno(error: &(dyn std::error::Error + 'static)) -> Option<i32> {
    std::iter::successors(Some(error), |cause| cause.source())
        .find_map(|cause| cause.downcast_ref::<io::Error>()?.raw_os_error())
}

pub(super) fn bytes(raw: Vec<u8>) -> Value {
    json!({ "bytes": STANDARD.encode(raw) })
}

impl Request {
    fn execute(self) -> Result<Value, Box<dyn std::error::Error>> {
        match self {
            Self::Engine { socket, query } => {
                Ok(bytes(offline_store_engine::read(&socket, query.query()?)?))
            }
            Self::Seat {
                config,
                session,
                employee,
                recheck_session_fence,
            } => Ok(bytes(seat(
                config.as_pin(),
                &ProfileSessionId::parse(&session)?,
                &ProfileEmployeeId::parse(&employee)?,
                recheck_session_fence,
            )?)),
            Self::Target { target, now } => {
                let qualified = offline_qualification::inspect(&target, now)?;
                Ok(json!({
                    "bytes": STANDARD.encode(qualified.bytes),
                    "targetDigest": qualified.digest,
                    "evidencePaths": qualified.evidence_paths,
                }))
            }
            Self::Profiles { home, nix, entries } => Ok(bytes(offline_qualification::inventory(
                &home, &nix, entries,
            )?)),
            Self::Cohort {
                company,
                config,
                target,
                employee,
            } => Ok(bytes(offline_qualification::cohort(
                &company,
                config.as_pin(),
                target.as_pin(),
                employee.as_deref(),
            )?)),
            Self::Capacity {
                budget,
                cohort_size,
                state,
                scratch,
            } => {
                let budget = CapacityBudget::decode(&budget)?;
                let admitted =
                    offline_qualification::capacity(budget, cohort_size, &state, &scratch)?;
                Ok(bytes(serde_json::to_vec(&admitted)?))
            }
        }
    }
}

fn seat(
    pin: ControlPin<'_>,
    session: &ProfileSessionId,
    employee: &ProfileEmployeeId,
    recheck_session_fence: bool,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let seat = offline_qualification::inspect_seat(pin, session, employee, recheck_session_fence)?;
    Ok(serde_json::to_vec(&seat_data(&seat))?)
}

pub(super) fn seat_data(seat: &Seat) -> Value {
    let encode = |path: &Path| STANDARD.encode(path.as_os_str().as_bytes());
    json!({
        "session": seat.paths.session().as_str(),
        "home": encode(seat.paths.home()),
        "nix": encode(seat.paths.nix()),
        "lock": encode(seat.locks.lock()),
        "fence": encode(seat.locks.migration_fence()),
        "session_lock": encode(&seat.session_lock),
        "helper_name": seat.helper.name().codepoints(),
        "helper_args": seat.helper.arguments().iter().map(|arg| arg.codepoints()).collect::<Vec<_>>(),
    })
}
