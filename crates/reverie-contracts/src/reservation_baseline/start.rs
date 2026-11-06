//! Exact original source/peer/capacity comparisons for qualify_start DATA.
//! None of these comparisons supplies a native release or launch permission.
use super::*;
use crate::legacy_json::Number;
use reverie_core::ids::ContainerId;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartDataError {
    Structure,
    OldBinding,
    OldRunning,
    Peers,
    Capacity,
    Commitments,
    Permit,
    Preparation,
    Fingerprint,
    Storage,
}
impl StartDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Structure => "RESOURCE_NATIVE_START_STRUCTURE",
            Self::OldBinding => "RESOURCE_NATIVE_OLD_BINDING_CHANGED",
            Self::OldRunning => "RESOURCE_NATIVE_OLD_LAPTOP_RUNNING",
            Self::Peers => "RESOURCE_NATIVE_PEER_OR_TARGET_CHANGED",
            Self::Capacity => "RESOURCE_NATIVE_CAPACITY_CHANGED",
            Self::Commitments => "RESOURCE_NATIVE_COMMITMENTS_CHANGED",
            Self::Permit => "RESOURCE_NATIVE_PERMIT_CHANGED",
            Self::Preparation => "RESOURCE_NATIVE_PREPARATION_CHANGED",
            Self::Fingerprint => "RESOURCE_NATIVE_START_FINGERPRINT",
            Self::Storage => "RESOURCE_NATIVE_STORAGE_CHANGED",
        }
    }
}
impl fmt::Display for StartDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for StartDataError {}
type Checked<T> = std::result::Result<T, StartDataError>;
fn fields(value: &Value) -> Checked<&Object> {
    object(value).map_err(|_| StartDataError::Structure)
}
fn required<'a>(value: &'a Object, name: &str) -> Checked<&'a Value> {
    field(value, name).ok_or(StartDataError::Structure)
}
fn require(value: bool, error: StartDataError) -> Checked<()> {
    if value { Ok(()) } else { Err(error) }
}
fn state(running: bool, pid: Value) -> Value {
    Value(Node::Object(
        [
            (key("Running"), Value(Node::Bool(running))),
            (key("Pid"), pid),
        ]
        .into_iter()
        .collect(),
    ))
}
impl OriginalSourceBaseline {
    pub fn assert_original_storage_identity(
        &self,
        destination: &str,
        identity: [u64; 4],
    ) -> Checked<()> {
        let stored = required(
            fields(required(fields(&self.value)?, "storage")?)?,
            destination,
        )?;
        let value = Value(Node::Array(
            identity
                .into_iter()
                .map(|value| Value(Node::Number(Number::Integer(value.to_string()))))
                .collect(),
        ));
        if stored.python_eq(&value) {
            Ok(())
        } else {
            Err(StartDataError::Storage)
        }
    }
    /// Preserve Python dictionary numeric equality here; the subsequent real
    /// running-limits observer retains its own stricter declaration rules.
    pub fn start_source_running(&self, current: &ContainerRow) -> Checked<bool> {
        let root = fields(&self.value)?;
        let mut expected = required(root, "sourceRow")?.deep_clone();
        let actual_state = required(fields(current.data())?, "State")?;
        let Node::Object(expected_fields) = &mut expected.0 else {
            return Err(StartDataError::Structure);
        };
        expected_fields.insert(key("State"), actual_state.deep_clone());
        require(
            current.data().python_eq(&expected),
            StartDataError::OldBinding,
        )?;
        let pid = required(fields(required(root, "native")?)?, "pid")?.deep_clone();
        Ok(actual_state.python_eq(&state(true, pid)))
    }
    pub fn assert_old_stopped_state(&self, current: &ContainerRow) -> Checked<()> {
        require(
            required(fields(current.data())?, "State")?.python_eq(&state(
                false,
                Value(Node::Number(Number::Integer("0".into()))),
            )),
            StartDataError::OldRunning,
        )
    }
    pub fn assert_original_native(
        &self,
        native: &NativeLimitBinding,
        storage: &NativeStorageBinding,
    ) -> Checked<()> {
        let root = fields(&self.value)?;
        require(
            native.data().python_eq(required(root, "native")?)
                && storage.data().python_eq(required(root, "storage")?),
            StartDataError::OldBinding,
        )
    }
    pub fn assert_start_capacity(
        &self,
        site: &NativeLimitBinding,
        budget: &UnsignedInteger,
    ) -> Checked<()> {
        let root = fields(&self.value)?;
        require(
            site.data().python_eq(required(root, "site")?)
                && Value(Node::Number(Number::Integer(budget.as_str().into())))
                    .python_eq(required(root, "budget")?),
            StartDataError::Capacity,
        )
    }
    pub fn assert_start_commitments(
        &self,
        commitments: &[NativeLimitBinding],
        running: bool,
    ) -> Checked<()> {
        let root = fields(&self.value)?;
        let Node::Array(original) = &required(root, "commitments")?.0 else {
            return Err(StartDataError::Structure);
        };
        let mut expected = Vec::new();
        for row in original {
            let id = required(fields(row)?, "containerId")?;
            if running
                || !matches!(&id.0,Node::String(value) if value.equals_ascii(self.source.as_str()))
            {
                expected.push(row);
            }
        }
        expected.sort_by(|a, b| commitment_id(a).cmp(&commitment_id(b)));
        let mut actual: Vec<_> = commitments.iter().map(NativeLimitBinding::data).collect();
        actual.sort_by(|a, b| commitment_id(a).cmp(&commitment_id(b)));
        require(
            actual.len() == expected.len()
                && actual.iter().zip(expected).all(|(a, b)| a.python_eq(b)),
            StartDataError::Commitments,
        )
    }
    pub fn assert_start_peers<'a>(
        &self,
        current: impl Iterator<Item = &'a ContainerRow>,
        original: impl Iterator<Item = &'a ContainerRow>,
    ) -> Checked<()> {
        let collect = |rows: Vec<&'a ContainerRow>| {
            rows.into_iter()
                .filter(|row| row.id() != &self.source)
                .map(|row| (row.id(), row))
                .collect::<BTreeMap<&ContainerId, &ContainerRow>>()
        };
        let current = collect(current.collect());
        let original = collect(original.collect());
        require(
            current.len() == original.len()
                && current.iter().all(|(id, row)| {
                    original
                        .get(id)
                        .is_some_and(|other| row.data().python_eq(other.data()))
                }),
            StartDataError::Peers,
        )
    }
}
fn commitment_id(value: &Value) -> Option<&Text> {
    fields(value)
        .ok()
        .and_then(|fields| field(fields, "containerId"))
        .and_then(|value| match &value.0 {
            Node::String(value) => Some(value),
            _ => None,
        })
}
