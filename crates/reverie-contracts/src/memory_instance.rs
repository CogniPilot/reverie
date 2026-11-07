//! The existing closed instance configuration, preserving owner text and
//! initial-self extensions. Path expansion/resolution is a separate host step.
use crate::legacy_json::{self, Node, Text, Value, ordered::OrderedValue};
use crate::{
    memory_documents::{DocumentBody, DocumentCodecError},
    storage_identity::MetadataText,
};
use reverie_core::{
    ids::ProfileEmployeeId,
    memory_instance::{InstanceId, InstanceKind, SharedRoomTone},
};
use std::{collections::BTreeMap, fmt};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstanceCodecError {
    Json,
    Shape,
    Field,
    Identity,
    Kind,
    Tone,
    InitialSelf,
}
impl fmt::Display for InstanceCodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for InstanceCodecError {}
type Result<T> = std::result::Result<T, InstanceCodecError>;
#[derive(Clone)]
pub struct MemoryInstance {
    id: InstanceId,
    agent_name: MetadataText,
    owner_name: MetadataText,
    data_dir: MetadataText,
    persona: MetadataText,
    initial_self: Option<DocumentBody>,
    role: MetadataText,
    kind: InstanceKind,
    tone: SharedRoomTone,
    employee_id: Option<ProfileEmployeeId>,
}
/// The exact checks preceding native data-directory resolution. The host must
/// resolve/separate that directory before finish(), as the original loader does.
pub struct InstanceHeader {
    body: OrderedValue,
    id: InstanceId,
    agent_name: MetadataText,
    owner_name: MetadataText,
    data_dir: MetadataText,
    persona: MetadataText,
}
impl InstanceHeader {
    pub fn decode_json(raw: &str) -> Result<Self> {
        let body =
            legacy_json::decode_memory_str(raw.as_bytes()).map_err(|_| InstanceCodecError::Json)?;
        let Node::Object(fields) = &body.value.0 else {
            return Err(InstanceCodecError::Shape);
        };
        let allowed = [
            "id",
            "agent_name",
            "owner_name",
            "data_dir",
            "persona",
            "initial_self",
            "role",
            "kind",
            "shared_room_tone",
            "employee_id",
        ];
        if fields
            .keys()
            .any(|key| !allowed.iter().any(|allowed| key.equals_ascii(allowed)))
        {
            return Err(InstanceCodecError::Shape);
        }
        let id = required(fields, "id")?;
        let agent_name = required(fields, "agent_name")?;
        let owner_name = required(fields, "owner_name")?;
        let data_dir = required(fields, "data_dir")?;
        let persona = required(fields, "persona")?;
        let id = InstanceId::parse(&id.scalar_text().ok_or(InstanceCodecError::Identity)?)
            .map_err(|_| InstanceCodecError::Identity)?;
        Ok(Self {
            body,
            id,
            agent_name,
            owner_name,
            data_dir,
            persona,
        })
    }
    pub fn data_dir(&self) -> &MetadataText {
        &self.data_dir
    }
    pub fn finish(self) -> Result<MemoryInstance> {
        let Node::Object(fields) = &self.body.value.0 else {
            unreachable!("private checked root");
        };
        let initial_self = initial(&self.body)?;
        let kind = optional(fields, "kind", "agent")?;
        let kind = InstanceKind::parse(&kind.scalar_text().ok_or(InstanceCodecError::Kind)?)
            .map_err(|_| InstanceCodecError::Kind)?;
        let role = optional(fields, "role", "Expert")?;
        if role.as_python_text_ref().trimmed().is_empty() {
            return Err(InstanceCodecError::Field);
        }
        let tone = optional(fields, "shared_room_tone", "professional")?;
        let tone = SharedRoomTone::parse(&tone.scalar_text().ok_or(InstanceCodecError::Tone)?)
            .map_err(|_| InstanceCodecError::Tone)?;
        let employee_id = if fields.contains_key(&key("employee_id")) {
            let value = required_type(fields, "employee_id")?;
            Some(
                ProfileEmployeeId::parse(&value.scalar_text().ok_or(InstanceCodecError::Identity)?)
                    .map_err(|_| InstanceCodecError::Identity)?,
            )
        } else {
            None
        };
        Ok(MemoryInstance {
            id: self.id,
            agent_name: self.agent_name,
            owner_name: self.owner_name,
            data_dir: self.data_dir,
            persona: self.persona,
            initial_self,
            role,
            kind,
            tone,
            employee_id,
        })
    }
}
impl MemoryInstance {
    /// Pure schema convenience. Native loading uses the phased header API so
    /// filesystem failure ordering remains separate from final field checks.
    pub fn decode_json(raw: &str) -> Result<Self> {
        InstanceHeader::decode_json(raw)?.finish()
    }
    pub fn id(&self) -> &InstanceId {
        &self.id
    }
    pub fn agent_name(&self) -> &MetadataText {
        &self.agent_name
    }
    pub fn owner_name(&self) -> &MetadataText {
        &self.owner_name
    }
    pub fn data_dir(&self) -> &MetadataText {
        &self.data_dir
    }
    pub fn persona(&self) -> &MetadataText {
        &self.persona
    }
    pub fn initial_self(&self) -> Option<&DocumentBody> {
        self.initial_self.as_ref()
    }
    pub fn initial_model(&self) -> std::result::Result<DocumentBody, DocumentCodecError> {
        DocumentBody::initial_for_instance(self.initial_self.as_ref(), &self.persona)
    }
    pub fn role(&self) -> &MetadataText {
        &self.role
    }
    pub fn kind(&self) -> InstanceKind {
        self.kind
    }
    pub fn shared_room_tone(&self) -> SharedRoomTone {
        self.tone
    }
    pub fn employee_id(&self) -> Option<&ProfileEmployeeId> {
        self.employee_id.as_ref()
    }
}
pub fn identity_context(instance: Option<&MemoryInstance>) -> MetadataText {
    let Some(instance) = instance else {
        return MetadataText::from_scalar_text("");
    };
    let mut points = format!("Instance: {}. Your name is ", instance.id().as_str())
        .chars()
        .map(u32::from)
        .collect::<Vec<_>>();
    for (value, suffix) in [
        (instance.agent_name(), ". Your owner is "),
        (instance.owner_name(), ". Your role is "),
        (instance.role(), "."),
    ] {
        points.extend_from_slice(value.codepoints());
        points.extend(suffix.chars().map(u32::from));
    }
    MetadataText::from_python_text(
        reverie_core::PythonText::try_new(points).expect("composed owner text"),
    )
}
/// Organizational roles never choose a more privileged harness profile.
pub fn primary_agent(_instance: Option<&MemoryInstance>) -> &'static str {
    "chat"
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn required_type(fields: &BTreeMap<Text, Value>, name: &str) -> Result<MetadataText> {
    let Some(Value(Node::String(value))) = fields.get(&key(name)) else {
        return Err(InstanceCodecError::Field);
    };
    Ok(MetadataText::from_text(value.clone()))
}
fn required(fields: &BTreeMap<Text, Value>, name: &str) -> Result<MetadataText> {
    let value = required_type(fields, name)?;
    if value.as_python_text_ref().trimmed().is_empty() {
        return Err(InstanceCodecError::Field);
    }
    Ok(value)
}
fn optional(fields: &BTreeMap<Text, Value>, name: &str, default: &str) -> Result<MetadataText> {
    if fields.contains_key(&key(name)) {
        required_type(fields, name)
    } else {
        Ok(MetadataText::from_scalar_text(default))
    }
}
fn initial(body: &OrderedValue) -> Result<Option<DocumentBody>> {
    let Node::Object(root) = &body.value.0 else {
        unreachable!("private instance object");
    };
    let Some(value) = root
        .get(&key("initial_self"))
        .filter(|v| !matches!(v.0, Node::Null))
    else {
        return Ok(None);
    };
    let Node::Object(fields) = &value.0 else {
        return Err(InstanceCodecError::InitialSelf);
    };
    required_type(fields, "consciousness").map_err(|_| InstanceCodecError::InitialSelf)?;
    let Some(Value(Node::Array(directives))) = fields.get(&key("directives")) else {
        return Err(InstanceCodecError::InitialSelf);
    };
    for value in directives {
        let Node::String(value) = &value.0 else {
            return Err(InstanceCodecError::InitialSelf);
        };
        if MetadataText::from_text(value.clone())
            .as_python_text_ref()
            .trimmed()
            .is_empty()
        {
            return Err(InstanceCodecError::InitialSelf);
        }
    }
    Ok(Some(DocumentBody::from_ordered(OrderedValue {
        value: value.deep_clone(),
        graph: body.graph.with_root(
            body.root_child_index(&key("initial_self"))
                .expect("private field order"),
        ),
    })))
}
