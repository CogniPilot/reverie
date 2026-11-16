use crate::{Error, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reverie_core::ids::NativeOperationId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use subtle::ConstantTimeEq;

const PURPOSE: &str = "reverie-fresh-rust-company-v1";
const MAX_EMPLOYEES: usize = 64;
const MAX_OPERATIONS: usize = 512;

pub(crate) fn new_id() -> Result<String> {
    let mut entropy = [0; 16];
    getrandom::getrandom(&mut entropy).map_err(|_| Error::Storage)?;
    Ok(NativeOperationId::from_random_bytes(entropy)
        .as_str()
        .to_owned())
}
pub(crate) fn id(value: &str) -> Result<()> {
    NativeOperationId::parse(value)
        .map(|_| ())
        .map_err(|_| Error::Invalid)
}
pub(crate) fn secret() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| Error::Storage)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn secret_hash(value: &str) -> Result<[u8; 32]> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::Unauthorized)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(Error::Unauthorized);
    }
    Ok(Sha256::digest(bytes).into())
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Employee {
    id: String,
    session_id: String,
    session_generation: u32,
    name: String,
    manage_office: bool,
    on_vacation: bool,
    desired_running: bool,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Credential {
    secret_hash: [u8; 32],
    employee: Option<String>,
    session_id: Option<String>,
    generation: Option<u32>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Operation {
    request_digest: [u8; 32],
    actor: Option<String>,
    result: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeldRequest {
    action: OfficeAction,
    session_id: String,
    session_generation: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum NativeState {
    Unobserved,
}
#[derive(Deserialize)]
enum Blocker {
    #[serde(rename = "NATIVE_LIFECYCLE_UNIMPLEMENTED")]
    NativeUnimplemented,
}
#[derive(Deserialize)]
enum NoAction {}
#[derive(Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RecordedResult {
    Registered {
        request_id: String,
        employee_id: String,
        session_id: String,
        session_generation: u32,
        native_state: NativeState,
        blocker: Blocker,
        allowed_actions: Vec<NoAction>,
    },
    PermissionSaved {
        request_id: String,
        employee_id: String,
        manage_office: bool,
    },
    CredentialRegistered {
        request_id: String,
        employee_id: String,
    },
    Held {
        request_id: String,
        employee_id: String,
        request: HeldRequest,
        blocker: Blocker,
        native_state: NativeState,
        allowed_actions: Vec<NoAction>,
        effect_issued: bool,
    },
}
impl RecordedResult {
    fn check(&self, key: &str, employees: &BTreeMap<String, Employee>) -> Result<()> {
        let (request, employee) = match self {
            Self::Registered {
                request_id,
                employee_id,
                session_id,
                session_generation,
                native_state,
                blocker,
                allowed_actions,
            } => {
                id(session_id)?;
                check_recorded_scope(employees, employee_id, session_id, *session_generation)?;
                if *session_generation == 0 || !allowed_actions.is_empty() {
                    return Err(Error::Storage);
                }
                let _ = (native_state, blocker);
                (request_id, employee_id)
            }
            Self::PermissionSaved {
                request_id,
                employee_id,
                manage_office,
            } => {
                let _ = manage_office;
                (request_id, employee_id)
            }
            Self::CredentialRegistered {
                request_id,
                employee_id,
            } => (request_id, employee_id),
            Self::Held {
                request_id,
                employee_id,
                request,
                blocker,
                native_state,
                allowed_actions,
                effect_issued,
            } => {
                id(&request.session_id)?;
                check_recorded_scope(
                    employees,
                    employee_id,
                    &request.session_id,
                    request.session_generation,
                )?;
                if request.session_generation == 0 || *effect_issued || !allowed_actions.is_empty()
                {
                    return Err(Error::Storage);
                }
                let _ = (&request.action, blocker, native_state);
                (request_id, employee_id)
            }
        };
        id(employee)?;
        employees.get(employee).ok_or(Error::Storage)?;
        if request != key {
            return Err(Error::Storage);
        }
        Ok(())
    }
}
fn check_recorded_scope(
    employees: &BTreeMap<String, Employee>,
    employee: &str,
    session: &str,
    generation: u32,
) -> Result<()> {
    let row = employees.get(employee).ok_or(Error::Storage)?;
    if row.session_id != session || row.session_generation != generation {
        return Err(Error::Storage);
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Stored {
    version: u8,
    purpose: String,
    instance_id: String,
    revision: u64,
    owner: Credential,
    employees: BTreeMap<String, Employee>,
    credentials: BTreeMap<String, Credential>,
    operations: BTreeMap<String, Operation>,
}
pub(crate) struct Document(Stored);
enum Principal {
    Owner,
    Employee(String),
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Scope {
    pub(crate) session_id: String,
    pub(crate) session_generation: u32,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Register {
    pub(crate) request_id: String,
    name: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Grant {
    pub(crate) request_id: String,
    scope: Scope,
    enabled: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Enroll {
    pub(crate) request_id: String,
    scope: Scope,
    secret: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum OfficeAction {
    Leave,
    Enter,
    Restart,
    Retire,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Office {
    pub(crate) request_id: String,
    scope: Scope,
    action: OfficeAction,
}
pub(crate) enum Command {
    Register(Register),
    Grant(String, Grant),
    Enroll(String, Enroll),
    Office(String, Office),
}
impl Command {
    pub(crate) fn request_id(&self) -> &str {
        match self {
            Self::Register(v) => &v.request_id,
            Self::Grant(_, v) => &v.request_id,
            Self::Enroll(_, v) => &v.request_id,
            Self::Office(_, v) => &v.request_id,
        }
    }
    fn digest(&self) -> Result<[u8; 32]> {
        let value = match self {
            Self::Register(v) => json!(["register", v]),
            Self::Grant(target, v) => json!(["grant", target, v]),
            Self::Enroll(target, v) => json!(["enroll", target, v]),
            Self::Office(target, v) => json!(["office", target, v]),
        };
        Ok(Sha256::digest(serde_json::to_vec(&value).map_err(|_| Error::Invalid)?).into())
    }
}
impl Document {
    pub(crate) fn fresh(owner_secret: &str) -> Result<Self> {
        Ok(Self(Stored {
            version: 3,
            purpose: PURPOSE.into(),
            instance_id: new_id()?,
            revision: 1,
            owner: Credential {
                secret_hash: secret_hash(owner_secret)?,
                employee: None,
                session_id: None,
                generation: None,
            },
            employees: BTreeMap::new(),
            credentials: BTreeMap::new(),
            operations: BTreeMap::new(),
        }))
    }
    pub(crate) fn decode(raw: &[u8]) -> Result<Self> {
        let value: Value = serde_json::from_slice(raw).map_err(|_| Error::Storage)?;
        if value.get("version") != Some(&json!(3)) || value.get("purpose") != Some(&json!(PURPOSE))
        {
            return Err(Error::ExistingCompany);
        }
        let stored: Stored = serde_json::from_slice(raw).map_err(|_| Error::Storage)?;
        let document = Self(stored);
        document.validate()?;
        Ok(document)
    }
    fn validate(&self) -> Result<()> {
        id(&self.0.instance_id)?;
        if self.0.revision == 0
            || self.0.employees.len() > MAX_EMPLOYEES
            || self.0.operations.len() > MAX_OPERATIONS
        {
            return Err(Error::Storage);
        }
        if self.0.owner.employee.is_some()
            || self.0.owner.session_id.is_some()
            || self.0.owner.generation.is_some()
        {
            return Err(Error::Storage);
        }
        for (key, employee) in &self.0.employees {
            id(key)?;
            id(&employee.session_id)?;
            if key != &employee.id
                || employee.session_generation == 0
                || !employee.on_vacation
                || employee.desired_running
                || employee.name.trim().is_empty()
                || employee.name.len() > 100
                || employee.name.chars().any(char::is_control)
            {
                return Err(Error::Storage);
            }
        }
        for (key, credential) in &self.0.credentials {
            let employee = self.0.employees.get(key).ok_or(Error::Storage)?;
            if credential.employee.as_ref() != Some(key)
                || credential.session_id.as_ref() != Some(&employee.session_id)
                || credential.generation != Some(employee.session_generation)
                || bool::from(credential.secret_hash.ct_eq(&self.0.owner.secret_hash))
            {
                return Err(Error::Storage);
            }
        }
        let hashes = self
            .0
            .credentials
            .values()
            .map(|c| c.secret_hash)
            .collect::<std::collections::BTreeSet<_>>();
        if hashes.len() != self.0.credentials.len() {
            return Err(Error::Storage);
        }
        for (key, operation) in &self.0.operations {
            id(key)?;
            if let Some(actor) = &operation.actor {
                id(actor)?;
                self.0.employees.get(actor).ok_or(Error::Storage)?;
            }
            serde_json::from_value::<RecordedResult>(operation.result.clone())
                .map_err(|_| Error::Storage)?
                .check(key, &self.0.employees)?;
        }
        Ok(())
    }
    pub(crate) fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec(&self.0).map_err(|_| Error::Storage)
    }
    fn authenticate(&self, supplied: &str) -> Result<Principal> {
        let hash = secret_hash(supplied)?;
        if bool::from(hash.ct_eq(&self.0.owner.secret_hash)) {
            return Ok(Principal::Owner);
        }
        for (employee, credential) in &self.0.credentials {
            if !bool::from(hash.ct_eq(&credential.secret_hash)) {
                continue;
            }
            let current = self.0.employees.get(employee).ok_or(Error::Unauthorized)?;
            if credential.session_id.as_ref() != Some(&current.session_id)
                || credential.generation != Some(current.session_generation)
            {
                return Err(Error::Unauthorized);
            }
            return Ok(Principal::Employee(employee.clone()));
        }
        Err(Error::Unauthorized)
    }
    fn owner(principal: &Principal) -> Result<()> {
        if matches!(principal, Principal::Owner) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
    fn office(&self, principal: &Principal) -> Result<()> {
        match principal {
            Principal::Owner => Ok(()),
            Principal::Employee(id)
                if self.0.employees.get(id).is_some_and(|e| e.manage_office) =>
            {
                Ok(())
            }
            Principal::Employee(_) => Err(Error::Forbidden),
        }
    }
    pub(crate) fn employees(&self, token: &str) -> Result<Value> {
        self.office(&self.authenticate(token)?)?;
        Ok(
            json!({"employees":self.0.employees.values().map(|e| json!({"id":e.id,"name":e.name,"sessionId":e.session_id,"sessionGeneration":e.session_generation,"manageOffice":e.manage_office,"onVacation":e.on_vacation,"desiredRunning":e.desired_running,"nativeState":"unobserved","blocker":"NATIVE_LIFECYCLE_UNIMPLEMENTED"})).collect::<Vec<_>>() }),
        )
    }
    pub(crate) fn initialization_status(&self, token: &str) -> Result<Value> {
        Self::owner(&self.authenticate(token)?)?;
        Ok(
            json!({"initialized":true,"instanceId":self.0.instance_id,"version":3,"freshServiceOnly":true,"nativeLifecycle":"unimplemented"}),
        )
    }
    pub(crate) fn operation(&self, token: &str, request: &str) -> Result<Value> {
        id(request)?;
        let principal = self.authenticate(token)?;
        if let Principal::Employee(actor) = &principal {
            let own = self
                .0
                .operations
                .get(request)
                .is_some_and(|operation| operation.actor.as_ref() == Some(actor));
            if !own {
                self.office(&principal)?;
            }
        }
        self.0
            .operations
            .get(request)
            .map(|v| v.result.clone())
            .ok_or(Error::Missing)
    }
    fn scoped(&self, employee: &str, scope: &Scope) -> Result<()> {
        id(employee)?;
        id(&scope.session_id)?;
        let actual = self.0.employees.get(employee).ok_or(Error::Missing)?;
        if scope.session_id != actual.session_id
            || scope.session_generation != actual.session_generation
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub(crate) fn apply(&mut self, token: &str, command: Command) -> Result<(Value, bool)> {
        let principal = self.authenticate(token)?;
        match &command {
            Command::Office(_, _) => self.office(&principal)?,
            _ => Self::owner(&principal)?,
        }
        id(command.request_id())?;
        let digest = command.digest()?;
        let actor = match &principal {
            Principal::Owner => None,
            Principal::Employee(id) => Some(id.clone()),
        };
        if let Some(original) = self.0.operations.get(command.request_id()) {
            return if original.actor == actor && bool::from(original.request_digest.ct_eq(&digest))
            {
                Ok((original.result.clone(), false))
            } else {
                Err(Error::Conflict)
            };
        }
        if self.0.operations.len() >= MAX_OPERATIONS {
            return Err(Error::Capacity);
        }
        let request_id = command.request_id().to_owned();
        let result = self.execute(command, &request_id)?;
        self.0.revision = self.0.revision.checked_add(1).ok_or(Error::Capacity)?;
        self.0.operations.insert(
            request_id,
            Operation {
                request_digest: digest,
                actor,
                result: result.clone(),
            },
        );
        Ok((result, true))
    }
    fn execute(&mut self, command: Command, request_id: &str) -> Result<Value> {
        match command {
            Command::Register(input) => self.register(input, request_id),
            Command::Grant(target, input) => {
                self.scoped(&target, &input.scope)?;
                self.0
                    .employees
                    .get_mut(&target)
                    .ok_or(Error::Missing)?
                    .manage_office = input.enabled;
                Ok(
                    json!({"requestId":request_id,"phase":"permission-saved","employeeId":target,"manageOffice":input.enabled}),
                )
            }
            Command::Enroll(target, input) => {
                self.scoped(&target, &input.scope)?;
                let secret_hash = secret_hash(&input.secret)?;
                if bool::from(secret_hash.ct_eq(&self.0.owner.secret_hash))
                    || self
                        .0
                        .credentials
                        .values()
                        .any(|v| bool::from(secret_hash.ct_eq(&v.secret_hash)))
                {
                    return Err(Error::Conflict);
                }
                self.0.credentials.insert(
                    target.clone(),
                    Credential {
                        secret_hash,
                        employee: Some(target.clone()),
                        session_id: Some(input.scope.session_id),
                        generation: Some(input.scope.session_generation),
                    },
                );
                Ok(
                    json!({"requestId":request_id,"phase":"credential-registered","employeeId":target}),
                )
            }
            Command::Office(target, input) => {
                self.scoped(&target, &input.scope)?;
                Ok(
                    json!({"requestId":request_id,"employeeId":target,"request":{"action":input.action,"sessionId":input.scope.session_id,"sessionGeneration":input.scope.session_generation},"phase":"held","blocker":"NATIVE_LIFECYCLE_UNIMPLEMENTED","nativeState":"unobserved","allowedActions":[],"effectIssued":false}),
                )
            }
        }
    }
    fn register(&mut self, input: Register, request_id: &str) -> Result<Value> {
        if self.0.employees.len() >= MAX_EMPLOYEES {
            return Err(Error::Capacity);
        }
        if input.name.trim().is_empty()
            || input.name.len() > 100
            || input.name.chars().any(char::is_control)
        {
            return Err(Error::Invalid);
        }
        let employee = Employee {
            id: new_id()?,
            session_id: new_id()?,
            session_generation: 1,
            name: input.name,
            manage_office: false,
            on_vacation: true,
            desired_running: false,
        };
        if self.0.employees.contains_key(&employee.id)
            || self
                .0
                .employees
                .values()
                .any(|e| e.session_id == employee.session_id)
        {
            return Err(Error::Conflict);
        }
        let result = json!({"requestId":request_id,"employeeId":employee.id,"sessionId":employee.session_id,"sessionGeneration":employee.session_generation,"phase":"registered","nativeState":"unobserved","blocker":"NATIVE_LIFECYCLE_UNIMPLEMENTED","allowedActions":[]});
        self.0.employees.insert(employee.id.clone(), employee);
        Ok(result)
    }
}
