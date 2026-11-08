//! `verify_service`: sampling runs only as the actual unit's main process,
//! inside its fixed kernel budget, before any sampler starts.
use super::units::UNIT;
use super::{Refused, Systemd};
use std::path::{Component, Path};

/// `seconds(text)`: a systemd duration such as `1min 30s` or `5s`.
fn seconds(text: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut rest = text.trim();
    if rest.is_empty() {
        return None;
    }
    while !rest.is_empty() {
        let digits = rest
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(rest.len());
        let number = &rest[..digits];
        let valid = !number.is_empty()
            && number.split('.').count() <= 2
            && number.split('.').all(|part| !part.is_empty());
        if !valid {
            return None;
        }
        let tail = &rest[digits..];
        let (scale, width) = [
            ("us", 1e-6),
            ("ms", 1e-3),
            ("min", 60.0),
            ("s", 1.0),
            ("h", 3600.0),
        ]
        .iter()
        .find(|(unit, _)| tail.starts_with(unit))
        .map(|(unit, scale)| (*scale, unit.len()))?;
        total += number.parse::<f64>().ok()? * scale;
        rest = tail[width..].trim_start();
    }
    Some(total)
}

fn read(path: &Path) -> Result<String, Refused> {
    std::fs::read_to_string(path).map_err(|_| Refused("Collector kernel budget unavailable"))
}

/// The cgroup this process belongs to, as `/proc/self/cgroup` shows it.
fn bound_group(proc_cgroup: &Path, group: &str) -> Result<(), Refused> {
    if read(proc_cgroup)?.trim() != format!("0::{group}") {
        return Err(Refused("Collector cgroup binding changed"));
    }
    Ok(())
}

/// `verify_service()`, with the `/proc` and cgroup roots explicit.
pub(crate) fn verify_service(
    systemd: &mut dyn Systemd,
    proc_cgroup: &Path,
    cgroup_root: &Path,
) -> Result<(), Refused> {
    let show = systemd.show(&[
        &format!("{UNIT}.service"),
        "--property=MainPID,ControlGroup,TimeoutStartUSec,TimeoutStopUSec",
    ])?;
    if show.status != 0 {
        return Err(Refused("Unit observation unavailable"));
    }
    if show.stdout.len() > 8192 {
        return Err(Refused("Unit observation bound exceeded"));
    }
    let rows = show
        .stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect::<std::collections::BTreeMap<_, _>>();
    let group = rows.get("ControlGroup").copied().unwrap_or_default();
    let parent = Path::new(group)
        .components()
        .any(|part| part == Component::ParentDir);
    if rows.get("MainPID").copied() != Some(std::process::id().to_string().as_str())
        || !group.starts_with('/')
        || parent
    {
        return Err(Refused("Not the actual collector service process"));
    }
    let start = rows.get("TimeoutStartUSec").copied().and_then(seconds);
    let stop = rows.get("TimeoutStopUSec").copied().and_then(seconds);
    let deadlines = start.is_some_and(|value| value > 0.0 && value <= 90.0)
        && stop.is_some_and(|value| value > 0.0 && value <= 5.0);
    if !deadlines {
        return Err(Refused("Unit deadline unavailable"));
    }
    bound_group(proc_cgroup, group)?;
    let root = cgroup_root.join(group.trim_start_matches('/'));
    for (name, value) in [
        ("memory.max", 256u64 << 20),
        ("memory.swap.max", 0),
        ("pids.max", 32),
    ] {
        if read(&root.join(name))?.trim() != value.to_string() {
            return Err(Refused("Collector kernel budget unavailable"));
        }
    }
    let cpu = read(&root.join("cpu.max"))?;
    let parts = cpu.split_whitespace().collect::<Vec<_>>();
    let budget = match parts[..] {
        [quota, period]
            if quota.bytes().all(|byte| byte.is_ascii_digit())
                && period.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            match (quota.parse::<u128>(), period.parse::<u128>()) {
                (Ok(quota), Ok(period)) => quota > 0 && quota * 2 <= period,
                _ => false,
            }
        }
        _ => false,
    };
    if !budget {
        return Err(Refused("Collector CPU budget unavailable"));
    }
    bound_group(proc_cgroup, group)
}

#[cfg(test)]
mod tests {
    use super::seconds;

    #[test]
    fn unit_durations_parse_like_the_python_reader() {
        assert_eq!(seconds("1min 30s"), Some(90.0));
        assert_eq!(seconds("5s"), Some(5.0));
        assert_eq!(seconds("500ms"), Some(0.5));
        assert_eq!(seconds("infinity"), None);
        assert_eq!(seconds(""), None);
        assert_eq!(seconds("5 s"), None);
    }
}
