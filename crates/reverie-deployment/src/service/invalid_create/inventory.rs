//! Complete unfiltered all-container read; every row is validated, none skipped.
use super::*;
use std::collections::BTreeSet;
pub(super) fn assert_absent(operation: &Operation, inventory: &Value) -> Result<usize> {
    let rows = inventory
        .as_array()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED"))?;
    require(
        !rows.is_empty() && rows.len() <= 4096,
        "DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED",
    )?;
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for row in rows {
        let id = model::cid(model::string(row, "Id")?)?;
        require(
            ids.insert(id)
                && row.get("Labels").is_some()
                && matches!(
                    row["State"].as_str(),
                    Some(
                        "created"
                            | "restarting"
                            | "running"
                            | "removing"
                            | "paused"
                            | "exited"
                            | "dead"
                    )
                ),
            "DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED",
        )?;
        let selected = row["Names"].as_array().ok_or_else(|| {
            DeploymentError::new("DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED")
        })?;
        require(
            !selected.is_empty() && selected.len() <= 64,
            "DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED",
        )?;
        if id == model::string(&operation.plan.source, "Id")? {
            require(
                selected.contains(&json!(format!("/{}", operation.plan.container)))
                    && row["State"] == "running",
                "DEPLOYMENT_INVALID_CREATE_SOURCE_ABSENT",
            )?;
        }
        for name in selected {
            let name = name.as_str().ok_or_else(|| {
                DeploymentError::new("DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED")
            })?;
            require(
                name.starts_with('/') && name.len() > 1 && name.len() <= 256 && names.insert(name),
                "DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED",
            )?;
            refuse_reference(operation, name)?;
        }
        assert_no_label_reference(operation, &row["Labels"])?;
    }
    require(
        ids.contains(model::string(&operation.plan.source, "Id")?),
        "DEPLOYMENT_INVALID_CREATE_SOURCE_ABSENT",
    )?;
    require(
        names.contains(format!("/{}", operation.plan.container).as_str()),
        "DEPLOYMENT_INVALID_CREATE_SOURCE_ABSENT",
    )?;
    Ok(rows.len())
}
fn assert_no_label_reference(operation: &Operation, labels: &Value) -> Result<()> {
    if labels.is_null() {
        return Ok(());
    }
    let labels = labels
        .as_object()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED"))?;
    for (key, value) in labels {
        let value = value.as_str().ok_or_else(|| {
            DeploymentError::new("DEPLOYMENT_INVALID_CREATE_INVENTORY_UNCONFIRMED")
        })?;
        refuse_reference(operation, key)?;
        refuse_reference(operation, value)?;
    }
    Ok(())
}
fn refuse_reference(operation: &Operation, value: &str) -> Result<()> {
    require(
        !value.contains(&operation.plan.operation)
            && !value.contains(&operation.plan.operation[..16])
            && value != format!("/{}", operation.invalid_create_name()),
        "DEPLOYMENT_INVALID_CREATE_CANDIDATE_PRESENT",
    )
}
