use super::{Result, policy::Agent, storage};
use reverie_core::ids::ProfileEmployeeId;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Read, Write},
    path::Path,
};

#[derive(Default)]
pub(super) struct Company(BTreeMap<ProfileEmployeeId, String>);

impl Company {
    pub(super) fn load(path: &Path) -> Result<Self> {
        let snapshot: Value = serde_json::from_reader(storage::read_snapshot(path)?)?;
        let entries = snapshot
            .as_object()
            .ok_or("company snapshot is not an object")?
            .get("employees");
        let Some(entries) = entries else {
            return Ok(Self::default());
        };
        let employees = entries.as_array().ok_or("invalid company employees")?;
        let bindings = employees
            .iter()
            .filter_map(|row| {
                let id = ProfileEmployeeId::parse(row.get("id")?.as_str()?).ok()?;
                let session = row.get("sessionId")?.as_str()?.to_owned();
                (!session.is_empty()).then_some((id, session))
            })
            .collect();
        Ok(Self(bindings))
    }

    pub(super) fn current(&self, agent: &Agent) -> Option<&str> {
        let employee = agent.employee_id.as_ref()?;
        self.0.get(employee).map(String::as_str)
    }

    pub(super) fn sessions(
        &self,
        agent: &Agent,
        state: &Path,
        remember: bool,
    ) -> Result<Option<BTreeSet<String>>> {
        if agent.employee_id.is_none() {
            return Ok(Some(agent.session_ids.clone()));
        }
        let Some(current) = self.current(agent) else {
            return Ok(None);
        };
        let path = state.join(format!("sleep-{}.sessions.json", agent.name));
        let mut seen = read_seen(&path)?;
        if seen.insert(current.to_owned()) && remember {
            storage::replace(&path, 0o600, |file| {
                serde_json::to_writer(&mut *file, &seen)?;
                writeln!(file)?;
                Ok(())
            })?;
        }
        seen.extend(agent.session_ids.iter().cloned());
        Ok(Some(seen))
    }
}

fn read_seen(path: &Path) -> Result<BTreeSet<String>> {
    let mut file = match storage::read_snapshot(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let parsed = serde_json::from_slice::<Vec<Value>>(&bytes).unwrap_or_default();
    Ok(parsed
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect())
}
