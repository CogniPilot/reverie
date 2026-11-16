use crate::{
    CompanyStore, Error, Result,
    document::{Command, Enroll, Grant, Office, Register, id},
};
use http::{HeaderMap, Method};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub(crate) fn token(headers: &HeaderMap) -> Result<&str> {
    for forbidden in [
        "cookie",
        "x-reverie-worker-identity",
        "x-reverie-service-token",
    ] {
        if headers.contains_key(forbidden) {
            return Err(Error::Unauthorized);
        }
    }
    if headers.get_all("authorization").iter().count() != 1 {
        return Err(Error::Unauthorized);
    }
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(Error::Unauthorized)
}
fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T> {
    serde_json::from_slice(body).map_err(|_| Error::Invalid)
}
pub(crate) fn call(
    store: &CompanyStore,
    method: &Method,
    path: &str,
    token: &str,
    body: &[u8],
) -> Result<Value> {
    let prefix = "/api/company/";
    let route = path.strip_prefix(prefix).ok_or(Error::Missing)?;
    if method == Method::GET {
        if !body.is_empty() {
            return Err(Error::Invalid);
        }
        if route == "employees" {
            return store.employees(token);
        }
        if let Some(request) = route.strip_prefix("operations/") {
            id(request)?;
            return store.operation(token, request);
        }
        return Err(Error::Missing);
    }
    if method != Method::POST {
        return Err(Error::Missing);
    }
    let command = if route == "employees" {
        Command::Register(decode::<Register>(body)?)
    } else {
        let rest = route.strip_prefix("employees/").ok_or(Error::Missing)?;
        let (employee, action) = rest.split_once('/').ok_or(Error::Missing)?;
        id(employee)?;
        match action {
            "manage-office" => Command::Grant(employee.into(), decode::<Grant>(body)?),
            "credential" => Command::Enroll(employee.into(), decode::<Enroll>(body)?),
            "office/operations" => Command::Office(employee.into(), decode::<Office>(body)?),
            _ => return Err(Error::Missing),
        }
    };
    store.apply(token, command)
}
pub(crate) fn envelope(result: Result<Value>) -> (u16, Value) {
    match result {
        Ok(data) => (200, json!({"success":true,"data":data})),
        Err(error) => (error.status(), json!({"success":false,"code":error.code()})),
    }
}
