use super::{Result, TelemetryDataError};
use crate::legacy_json::{self, Node, Number, Text, Value};
use reverie_core::{
    command_telemetry::{
        EmployeeFailureReport, FAILURE_ENTRIES, FAILURE_PROVENANCE, FailureCount, FailureExit,
        FailureReport, FailureReportRequest, FailureTool, TelemetryConfiguration,
    },
    ids::ProfileEmployeeId,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
};
pub fn decode_report_request(raw: &[u8]) -> Result<FailureReportRequest> {
    if raw.len() > 4096 {
        return Err(TelemetryDataError::Report);
    }
    let value = legacy_json::decode_strict_bytes(raw).map_err(|_| TelemetryDataError::Report)?;
    let Node::Object(fields) = &value.0 else {
        return Err(TelemetryDataError::Report);
    };
    if fields.len() != 3 {
        return Err(TelemetryDataError::Report);
    }
    let get = |name: &str| fields.get(&Text(name.chars().map(u32::from).collect()));
    if !matches!(get("v"),Some(Value(Node::Number(Number::Integer(v))))if v=="1")
        || !matches!(get("action"),Some(Value(Node::String(v)))if v.equals_ascii("command-failures"))
    {
        return Err(TelemetryDataError::Report);
    }
    let Some(Value(Node::Array(employees))) = get("employee_ids") else {
        return Err(TelemetryDataError::Report);
    };
    if employees.len() > 64 {
        return Err(TelemetryDataError::Report);
    }
    let employees = employees
        .iter()
        .map(|employee| {
            let Node::String(value) = &employee.0 else {
                return Err(TelemetryDataError::Report);
            };
            let value = value
                .0
                .iter()
                .map(|&cp| char::from_u32(cp))
                .collect::<Option<String>>()
                .ok_or(TelemetryDataError::Report)?;
            ProfileEmployeeId::parse(&value).map_err(|_| TelemetryDataError::Report)
        })
        .collect::<Result<Vec<_>>>()?;
    FailureReportRequest::try_new(employees).ok_or(TelemetryDataError::Report)
}
fn valid_report(
    report: &FailureReport,
    employee: &ProfileEmployeeId,
    policy: &TelemetryConfiguration,
) -> bool {
    let mut seen = BTreeSet::new();
    report.employee() == employee
        && report.counts().len() <= FAILURE_ENTRIES as usize
        && report
            .counts()
            .iter()
            .all(|row| row.tool().selected(policy.keys()) && seen.insert((row.tool(), row.exit())))
        && report
            .counts()
            .iter()
            .map(|row| u64::from(row.count()))
            .sum::<u64>()
            <= u64::from(FAILURE_ENTRIES)
}
fn compare(a: &FailureCount, b: &FailureCount) -> std::cmp::Ordering {
    b.count()
        .cmp(&a.count())
        .then_with(|| a.tool().as_str().cmp(b.tool().as_str()))
        .then_with(|| a.exit().category().cmp(b.exit().category()))
        .then_with(|| a.exit().cmp(&b.exit()))
}
pub(super) fn count_json(row: &FailureCount) -> String {
    format!(
        "{{\"tool\":\"{}\",\"category\":\"{}\",\"exit\":{},\"count\":{}}}",
        row.tool().as_str(),
        row.exit().category(),
        row.exit().get(),
        row.count()
    )
}
/// Source build_report ordering/closed fields. All interpolated strings are
/// checked UUIDs or closed ASCII vocabulary, never raw diagnostic/input text.
pub fn build_report(
    policy: &TelemetryConfiguration,
    request: &FailureReportRequest,
    reports: &[EmployeeFailureReport],
) -> Result<Vec<u8>> {
    if reports.len() != request.employees().len() {
        return Err(TelemetryDataError::Report);
    }
    let mut rows = Vec::new();
    let mut totals: BTreeMap<(FailureTool, FailureExit), (u32, u32)> = BTreeMap::new();
    for (employee, report) in request.employees().iter().zip(reports) {
        let (status, mut counts, evicted, expired, dropped) = match report {
            _ if !policy.enabled() => ("disabled", Vec::new(), 0, 0, 0),
            EmployeeFailureReport::NoData => ("no_data", Vec::new(), 0, 0, 0),
            EmployeeFailureReport::Ready(report) if valid_report(report, employee, policy) => (
                "ready",
                report.counts().to_vec(),
                report.evicted(),
                report.expired(),
                report.dropped(),
            ),
            _ => ("unavailable", Vec::new(), 0, 0, 0),
        };
        for row in &counts {
            let total = totals.entry((row.tool(), row.exit())).or_default();
            total.0 += row.count();
            total.1 += 1;
        }
        counts.sort_by(compare);
        let visible = counts
            .iter()
            .take(20)
            .map(count_json)
            .collect::<Vec<_>>()
            .join(",");
        rows.push(format!("{{\"employee_id\":\"{}\",\"harness\":\"hands\",\"status\":\"{status}\",\"counts\":[{visible}],\"truncated\":{},\"evicted\":{evicted},\"expired\":{expired},\"dropped\":{dropped}}}",employee.as_str(),counts.len()>20));
    }
    let mut top = totals.into_iter().collect::<Vec<_>>();
    top.sort_by(|((at, ae), (ac, _)), ((bt, be), (bc, _))| {
        bc.cmp(ac)
            .then_with(|| at.as_str().cmp(bt.as_str()))
            .then_with(|| ae.category().cmp(be.category()))
            .then_with(|| ae.cmp(be))
    });
    let mut visible = Vec::new();
    for ((tool, exit), (count, owners)) in top.iter().take(20) {
        visible.push(format!("{{\"tool\":\"{}\",\"category\":\"{}\",\"exit\":{},\"count\":{count},\"employee_count\":{owners}}}",tool.as_str(),exit.category(),exit.get()));
    }
    let mut output = String::new();
    write!(output,"{{\"v\":1,\"enabled\":{},\"provenance\":\"{FAILURE_PROVENANCE}\",\"harness_support\":{{\"hands\":\"self_reported\",\"claude\":\"unavailable\",\"codex\":\"unavailable\"}},\"employees\":[{}],\"top_repeats\":[{}],\"truncated\":{}}}",policy.enabled(),rows.join(","),visible.join(","),top.len()>20).expect("String write");
    if output.len() > 262144 {
        return Err(TelemetryDataError::Report);
    }
    Ok(output.into_bytes())
}
