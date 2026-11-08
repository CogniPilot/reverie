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
    let value = decode(raw)?;
    let host = &value["HostConfig"];
    let config = &value["Config"];
    let labels = &config["Labels"];
    let valid = hex_id(cid)
        && hex_id(birth_digest)
        && pid > 1
        && value["Id"] == cid
        && value["Image"] == policy.controller_image
        && value["Name"] == format!("/{}", policy.controller_name())
        && value["State"]["Pid"] == pid
        && value["State"]["Running"] == true
        && value["State"]["Paused"] == false
        && value["State"]["Restarting"] == false
        && config["User"] == format!("0:{}", policy.broker_gid)
        && config["Entrypoint"] == json!(["/bin/reverie-worker-resource-controller"])
        && config["Cmd"] == json!(["serve", "--policy-sha256", birth_digest])
        && config["Env"] == json!(["PATH=/bin", "LANG=C.UTF-8"])
        && labels["reverie.resource-controller"] == policy.deployment
        && labels["reverie.pool.purpose"] == PURPOSE
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
        && host["SecurityOpt"] == json!(["no-new-privileges:true"]);
    if !valid {
        return Err(PoolPolicyError);
    }
    mounts(&value["Mounts"], policy)
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

fn mounts(value: &Value, policy: &WorkerPoolPolicy) -> Result<(), PoolPolicyError> {
    let values = value.as_array().ok_or(PoolPolicyError)?;
    let expected = [
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
