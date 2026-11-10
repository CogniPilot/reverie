//! Fixed controller Engine readback codecs. Validation is DATA; only a retained
//! actual root-peer call and native process/filesystem observations confer use.
use super::*;
use serde_json::{Value, json};
#[cfg(test)]
mod tests;

pub fn validate_engine_information(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
) -> Result<(), PoolPolicyError> {
    let value = decode(raw)?;
    let security = value["SecurityOptions"].as_array().ok_or(PoolPolicyError)?;
    let valid = value["ID"] == policy.engine_id
        && value["CgroupDriver"] == "systemd"
        && value["CgroupVersion"] == "2"
        && value["OSType"] == "linux"
        && security.iter().all(|value| {
            value
                .as_str()
                .is_some_and(|text| !text.contains("rootless"))
        });
    valid.then_some(()).ok_or(PoolPolicyError)
}

pub fn validate_controller_inspection(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    cid: &str,
    pid: u32,
    birth_digest: &str,
) -> Result<(), PoolPolicyError> {
    controller(raw, policy, cid, pid, birth_digest, false)
}

/// Explicit service-v2 confinement. The original four-bind v1 decoder remains
/// unchanged; neither this readback nor the birth document grants an effect.
pub fn validate_controller_service_v2_inspection(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    cid: &str,
    pid: u32,
    birth_digest: &str,
) -> Result<(), PoolPolicyError> {
    controller(raw, policy, cid, pid, birth_digest, true)
}
fn controller(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    cid: &str,
    pid: u32,
    birth_digest: &str,
    service_v2: bool,
) -> Result<(), PoolPolicyError> {
    let value = decode(raw)?;
    let state = &value["State"];
    if !(pid > 1
        && state["Pid"] == pid
        && state["Running"] == true
        && state["Paused"] == false
        && state["Restarting"] == false)
    {
        return Err(PoolPolicyError);
    }
    controller_spec(
        &value,
        policy,
        cid,
        birth_digest,
        service_v2,
        &policy.controller_name(),
    )
}
/// Failed service-v2 component DATA only. Never activation or cleanup authority.
/// The host owner must independently bind its original attempt and native state.
pub fn validate_failed_controller_service_v2_inspection(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    cid: &str,
    birth_digest: &str,
    name: &str,
) -> Result<(), PoolPolicyError> {
    if stopped_controller(raw, policy, cid, birth_digest, name)? != 1 {
        return Err(PoolPolicyError);
    }
    Ok(())
}

/// Complete stopped service-v2 controller DATA and its exact exit status.
/// A stopped state alone does not prove that an earlier attempt settled.
pub fn validate_stopped_controller_service_v2_inspection(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    cid: &str,
    birth_digest: &str,
) -> Result<u8, PoolPolicyError> {
    stopped_controller(raw, policy, cid, birth_digest, &policy.controller_name())
}

fn stopped_controller(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    cid: &str,
    birth_digest: &str,
    name: &str,
) -> Result<u8, PoolPolicyError> {
    let value = decode(raw)?;
    let state = &value["State"];
    let exit_code = state["ExitCode"]
        .as_u64()
        .and_then(|code| u8::try_from(code).ok())
        .ok_or(PoolPolicyError)?;
    let valid = state["Pid"] == 0
        && state["Running"] == false
        && state["Paused"] == false
        && state["Restarting"] == false
        && state["Dead"] == false
        && state["Status"] == "exited"
        && state["OOMKilled"] == false
        && state["Error"] == ""
        && state["StartedAt"]
            .as_str()
            .is_some_and(|v| !v.starts_with("0001-") && !v.is_empty())
        && state["FinishedAt"]
            .as_str()
            .is_some_and(|v| !v.starts_with("0001-") && !v.is_empty())
        && value["RestartCount"] == 0
        && value["HostConfig"]["AutoRemove"] == false
        && value["HostConfig"]["RestartPolicy"] == json!({"Name":"no","MaximumRetryCount":0});
    if !valid {
        return Err(PoolPolicyError);
    }
    controller_spec(&value, policy, cid, birth_digest, true, name)?;
    Ok(exit_code)
}
fn controller_spec(
    value: &Value,
    policy: &WorkerPoolPolicy,
    cid: &str,
    birth_digest: &str,
    service_v2: bool,
    name: &str,
) -> Result<(), PoolPolicyError> {
    let host = &value["HostConfig"];
    let config = &value["Config"];
    let labels = &config["Labels"];
    let valid = hex_id(cid)
        && hex_id(birth_digest)
        && value["Id"] == cid
        && value["Image"] == policy.controller_image
        && value["Name"] == format!("/{name}")
        && config["User"] == format!("0:{}", policy.broker_gid)
        && config["Entrypoint"] == json!(["/bin/reverie-worker-resource-controller"])
        && config["Cmd"]
            == if service_v2 {
                json!([
                    "serve",
                    "--confinement-version",
                    "2",
                    "--birth-sha256",
                    birth_digest
                ])
            } else {
                json!(["serve", "--policy-sha256", birth_digest])
            }
        && controller_environment(&config["Env"], service_v2)
        && labels["reverie.resource-controller"] == policy.deployment
        && labels["reverie.pool.purpose"]
            == if service_v2 {
                super::controller_v2::SERVICE_PURPOSE
            } else {
                PURPOSE
            }
        && labels["reverie.pool.birth-policy"] == birth_digest
        && labels.get("reverie.worker").is_none()
        && host["Privileged"] == false
        && host["ReadonlyRootfs"] == true
        && host["PidMode"] == "host"
        && host["CgroupnsMode"] == "host"
        && host["UsernsMode"] == "host"
        && host["NetworkMode"] == "none"
        && host["CgroupParent"] == "system.slice"
        && host["Memory"] == CONTROLLER_MEMORY_BYTES
        && host["MemorySwap"] == CONTROLLER_MEMORY_BYTES
        && host["PidsLimit"] == CONTROLLER_TASKS_MAX
        && host["CpuQuota"] == 0
        && host["CpuPeriod"] == 0
        && host["NanoCpus"] == 0
        && host["CpusetCpus"] == policy.cpu_list()
        && host["CapDrop"] == json!(["ALL"])
        && (host["CapAdd"].is_null() || host["CapAdd"] == json!([]))
        && (host["GroupAdd"].is_null() || host["GroupAdd"] == json!([]))
        // Docker may append its SELinux label-disable default for the fixed
        // host-PID service. Keep every other option and the v1 codec exact.
        && (host["SecurityOpt"] == json!(["no-new-privileges:true"])
            || (service_v2
                && host["SecurityOpt"]
                    == json!(["no-new-privileges:true", "label=disable"])));
    if !valid {
        return Err(PoolPolicyError);
    }
    mounts(&value["Mounts"], policy, service_v2)
}
fn controller_environment(value: &Value, service_v2: bool) -> bool {
    // Docker may reorder these two unique fixed variables. No additional,
    // duplicate, overridden or malformed variable is accepted. V1 stays exact.
    value == &json!(["PATH=/bin", "LANG=C.UTF-8"])
        || (service_v2 && value == &json!(["LANG=C.UTF-8", "PATH=/bin"]))
}
pub fn website_process_data(raw: &[u8], expected: &str) -> Result<Option<u32>, PoolPolicyError> {
    let value = decode(raw)?;
    if !hex_id(expected)
        || value["Id"] != expected
        || value["State"]["Paused"] != false
        || value["State"]["Restarting"] != false
    {
        return Err(PoolPolicyError);
    }
    let pid = value["State"]["Pid"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(PoolPolicyError)?;
    match value["State"]["Running"].as_bool() {
        Some(true) if pid > 1 => Ok(Some(pid)),
        Some(false) if pid == 0 => Ok(None),
        _ => Err(PoolPolicyError),
    }
}

fn mounts(
    value: &Value,
    policy: &WorkerPoolPolicy,
    service_v2: bool,
) -> Result<(), PoolPolicyError> {
    let values = value.as_array().ok_or(PoolPolicyError)?;
    let mut expected = vec![
        (
            format!("{}/worker-pool/policies", policy.instance_root),
            "/run/reverie-worker-pool/policies",
            false,
        ),
        ("/proc".into(), "/run/reverie-host-proc", false),
        ("/sys/fs/cgroup".into(), "/sys/fs/cgroup", true),
        (
            "/var/run/docker.sock".into(),
            "/run/reverie-engine.sock",
            false,
        ),
    ];
    if service_v2 {
        expected.push((
            format!("{}/worker-pool/control", policy.instance_root),
            "/run/reverie-worker-pool/control",
            true,
        ));
    }
    if values.len() != expected.len() {
        return Err(PoolPolicyError);
    }
    for (source, target, writable) in expected {
        let matching: Vec<_> = values
            .iter()
            .filter(|value| value["Destination"] == target)
            .collect();
        if matching.len() != 1 {
            return Err(PoolPolicyError);
        }
        let value = matching[0];
        if value["Type"] != "bind"
            || value["Source"] != source
            || value["RW"] != writable
            || value["Propagation"] != "rprivate"
        {
            return Err(PoolPolicyError);
        }
    }
    Ok(())
}
pub fn validate_anchor_inspection(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    cid: &str,
    pid: u32,
    policy_digest: &str,
) -> Result<(), PoolPolicyError> {
    let value = decode(raw)?;
    anchor_spec(&value, policy, cid, pid, policy_digest)
}

pub fn validate_retained_anchor_inspection(
    raw: &[u8],
    policy: &WorkerPoolPolicy,
    anchor: &RetainedPoolAnchor,
) -> Result<(), PoolPolicyError> {
    let value = decode(raw)?;
    anchor_spec(
        &value,
        policy,
        anchor.container_id(),
        anchor.pid(),
        anchor.original_birth_digest(),
    )?;
    let state = &value["State"];
    let host = &value["HostConfig"];
    let stable = state["Status"] == "running"
        && state["Dead"] == false
        && state["OOMKilled"] == false
        && state["Error"] == ""
        && value["RestartCount"] == 0
        && host["AutoRemove"] == false
        && host["RestartPolicy"] == json!({"Name":"no","MaximumRetryCount":0});
    stable.then_some(()).ok_or(PoolPolicyError)
}

fn anchor_spec(
    value: &Value,
    policy: &WorkerPoolPolicy,
    cid: &str,
    pid: u32,
    policy_digest: &str,
) -> Result<(), PoolPolicyError> {
    let host = &value["HostConfig"];
    let config = &value["Config"];
    let valid = hex_id(cid)
        && hex_id(policy_digest)
        && pid > 1
        && value["Id"] == cid
        && value["Image"] == policy.anchor_image
        && value["Name"] == format!("/{}", policy.anchor_name())
        && value["State"]["Pid"] == pid
        && value["State"]["Running"] == true
        && value["State"]["Paused"] == false
        && value["State"]["Restarting"] == false
        && config["User"] == format!("{}:{}", policy.broker_uid, policy.broker_gid)
        && config["Entrypoint"] == json!(["/bin/sleep"])
        && config["Cmd"] == json!(["infinity"])
        && config["Labels"]["reverie.pool.anchor"] == policy.deployment
        && config["Labels"]["reverie.pool.birth-policy"] == policy_digest
        && config["Labels"].get("reverie.worker").is_none()
        && host["CgroupParent"] == policy.parent_slice()
        && host["Privileged"] == false
        && host["ReadonlyRootfs"] == true
        && host["NetworkMode"] == "none"
        && host["CapDrop"] == json!(["ALL"])
        && (host["CapAdd"].is_null() || host["CapAdd"] == json!([]))
        && host["SecurityOpt"] == json!(["no-new-privileges:true"])
        && host["Memory"] == 67_108_864u64
        && host["MemorySwap"] == 67_108_864u64
        && host["PidsLimit"] == 16
        && host["CpuShares"] == 2
        && host["CpuQuota"] == 0
        && host["NanoCpus"] == 0
        && host["CpusetCpus"] == policy.cpu_list()
        && value["Mounts"] == json!([]);
    valid.then_some(()).ok_or(PoolPolicyError)
}
fn decode(raw: &[u8]) -> Result<Value, PoolPolicyError> {
    if raw.is_empty() || raw.len() > 1_048_576 {
        return Err(PoolPolicyError);
    }
    serde_json::from_slice(raw).map_err(|_| PoolPolicyError)
}

/// Image inspection DATA only. The exact immutable ID commits image contents;
/// qualifying the selected repository-factory source remains the App's duty.
/// Container create overrides entrypoint/user, so no image defaults are used
/// as substitutes for the existing runtime container-level confinement checks.
pub fn validate_pool_image_information(
    raw: &[u8],
    image: &crate::worker_image_switch::WorkerImageId,
) -> Result<(), PoolPolicyError> {
    let value = decode(raw)?;
    let valid = value.is_object()
        && value["Id"] == image.as_str()
        && value["Os"] == "linux"
        && value["Config"].is_object();
    valid.then_some(()).ok_or(PoolPolicyError)
}
