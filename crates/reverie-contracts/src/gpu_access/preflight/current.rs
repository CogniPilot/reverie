use super::*;
use crate::{
    reservation_control,
    storage_identity::{CurrentEmployee, Metadata},
};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

/// One selected current company row, before the actual lower-level current
/// resolver performs its independent storage/registry observations.
pub struct PreflightSelection {
    employee: ProfileEmployeeId,
    session: ProfileSessionId,
    row: Value,
}
impl PreflightSelection {
    pub fn capture(company: &Metadata, employee: &ProfileEmployeeId) -> Result<Self> {
        let Some(Value(Node::Array(rows))) =
            object(company.as_value()).and_then(|fields| field(fields, "employees"))
        else {
            return Err(GpuDataError::CurrentRegistry);
        };
        // No queue roster bound, generation ceiling, or retired-row selection.
        let mut matching = rows.iter().filter_map(object).filter(|row| {
            field(row, "id").is_some_and(|id| id.python_eq(&string(employee.as_str())))
        });
        let row = matching.next().ok_or(GpuDataError::CurrentEmployee)?;
        if matching.next().is_some() {
            return Err(GpuDataError::CurrentEmployee);
        }
        let sid = field(row, "sessionId")
            .and_then(text)
            .and_then(|value| ProfileSessionId::parse(&value).ok())
            .ok_or(GpuDataError::CurrentEmployee)?;
        Ok(Self {
            employee: employee.clone(),
            session: sid,
            row: Value(Node::Object(
                row.iter()
                    .map(|(key, value)| (key.clone(), value.deep_clone()))
                    .collect(),
            )),
        })
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn bind(self, current: CurrentEmployee) -> Result<PreflightBinding> {
        if current.identity() != &self.employee || current.session() != &self.session {
            return Err(GpuDataError::CurrentEmployee);
        }
        let row = object(&self.row).expect("selected row object");
        let desired = exact_bool(field(row, "desiredRunning"), true)?;
        let vacation = exact_bool(field(row, "onVacation"), false)?;
        let recipe = field(row, "runtimeRecipe")
            .map(Value::deep_clone)
            .unwrap_or(Value(Node::Null));
        let recipe_digest = crate::digest::hex(&reservation_control::fingerprint(&recipe)?);
        Ok(PreflightBinding {
            current,
            desired,
            vacation,
            recipe_digest,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreflightBinding {
    current: CurrentEmployee,
    desired: bool,
    vacation: bool,
    recipe_digest: String,
}
impl PreflightBinding {
    pub fn equivalent(&self, other: &Self) -> bool {
        self.value().python_eq(&other.value())
    }
    pub fn current(&self) -> &CurrentEmployee {
        &self.current
    }
    pub fn start_allowed(&self) -> bool {
        self.desired && !self.vacation
    }
    pub(crate) fn value(&self) -> Value {
        let owner = self
            .current
            .owner()
            .as_ref()
            .map_or(Value(Node::Null), |value| {
                Value(Node::String(Text(value.codepoints().to_vec())))
            });
        Value(Node::Object(
            [
                (key("id"), string(self.current.identity().as_str())),
                (key("sessionId"), string(self.current.session().as_str())),
                (
                    key("sessionGeneration"),
                    Value(Node::Number(Number::Integer(
                        self.current.generation().decimal().into(),
                    ))),
                ),
                (key("owner"), owner),
                (key("desiredRunning"), Value(Node::Bool(self.desired))),
                (key("onVacation"), Value(Node::Bool(self.vacation))),
                (key("recipeDigest"), string(&self.recipe_digest)),
            ]
            .into(),
        ))
    }
}
fn exact_bool(value: Option<&Value>, default: bool) -> Result<bool> {
    match value {
        None => Ok(default),
        Some(Value(Node::Bool(value))) => Ok(*value),
        _ => Err(GpuDataError::CurrentRegistry),
    }
}
