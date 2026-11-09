use super::*;

#[derive(Clone)]
pub(in crate::worker_service) struct ExpectedCommands {
    start: Vec<Vec<String>>,
    pre: Vec<Vec<String>>,
    environment: PathBuf,
}
impl ExpectedCommands {
    pub(in crate::worker_service) fn capture(raw: &str, home: &Path) -> Result<Self> {
        let start = commands(raw, "ExecStart=");
        let pre = commands(raw, "ExecStartPre=");
        need(
            start.len() == 1
                && pre.len() <= 1
                && start.iter().chain(&pre).all(|words| {
                    words
                        .first()
                        .is_some_and(|word| word.starts_with("/nix/store/"))
                        && words.iter().all(|word| !word.contains(['\'', '"', '\\']))
                }),
            "NATIVE_STOPPED_SERVICE_UNIT_COMMANDS",
        )?;
        let environments = raw
            .lines()
            .filter_map(|line| line.strip_prefix("EnvironmentFile="))
            .collect::<Vec<_>>();
        need(
            environments.len() == 1,
            "NATIVE_STOPPED_SERVICE_UNIT_ENVIRONMENT",
        )?;
        let relative = environments[0]
            .strip_prefix("%h/")
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_STOPPED_SERVICE_UNIT_ENVIRONMENT",
            ))?;
        need(
            matches!(
                relative,
                ".config/reverie/worker-broker.env" | "reverie/worker-pool/service/environment"
            ),
            "NATIVE_STOPPED_SERVICE_UNIT_ENVIRONMENT",
        )?;
        Ok(Self {
            start,
            pre,
            environment: home.join(relative),
        })
    }
    pub(in crate::worker_service) fn assert_start(&self, data: &Value, pre: bool) -> Result<()> {
        let rows = data.as_array().ok_or(WorkerServiceError::Refused(
            "NATIVE_STOPPED_SERVICE_EXEC_REPLY",
        ))?;
        let expected = if pre { &self.pre } else { &self.start };
        need(
            rows.len() == expected.len(),
            "NATIVE_STOPPED_SERVICE_EXEC_CHANGED",
        )?;
        for (row, words) in rows.iter().zip(expected) {
            let tuple = row.as_array().ok_or(WorkerServiceError::Refused(
                "NATIVE_STOPPED_SERVICE_EXEC_REPLY",
            ))?;
            need(tuple.len() == 10, "NATIVE_STOPPED_SERVICE_EXEC_REPLY")?;
            let arguments = words
                .iter()
                .map(|word| Value::String(word.clone()))
                .collect::<Vec<_>>();
            need(
                tuple[0].as_str() == words.first().map(String::as_str)
                    && tuple[1].as_array() == Some(&arguments)
                    && tuple[2].as_bool() == Some(false),
                "NATIVE_STOPPED_SERVICE_EXEC_CHANGED",
            )?;
            need(
                tuple[3..7].iter().all(|value| value.as_u64().is_some())
                    && tuple[7]
                        .as_u64()
                        .is_some_and(|pid| u32::try_from(pid).is_ok())
                    && tuple[8..].iter().all(|value| {
                        value
                            .as_i64()
                            .is_some_and(|code| i32::try_from(code).is_ok())
                    }),
                "NATIVE_STOPPED_SERVICE_EXEC_REPLY",
            )?;
        }
        Ok(())
    }
    pub(in crate::worker_service) fn assert_environment(&self, data: &Value) -> Result<()> {
        let path = self
            .environment
            .to_str()
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_STOPPED_SERVICE_ENVIRONMENT_UTF8",
            ))?;
        need(
            *data == serde_json::json!([[path, false]]),
            "NATIVE_STOPPED_SERVICE_ENVIRONMENT_CHANGED",
        )
    }
    #[cfg(test)]
    pub(in crate::worker_service) fn controlled(home: &Path) -> Self {
        if home.join("manager-native-mode").exists() {
            return Self {
                start: vec![vec![
                    "/nix/store/new-broker/bin/reverie-worker-broker".into(),
                    "broker".into(),
                    "--config".into(),
                    "${REVERIE_WORKER_CONFIG}".into(),
                ]],
                pre: Vec::new(),
                environment: home.join("reverie/worker-pool/service/environment"),
            };
        }
        Self {
            start: vec![vec![
                "/nix/store/old-broker/bin/reverie-worker-broker".into(),
                "--config".into(),
                "${REVERIE_WORKER_CONFIG}".into(),
            ]],
            pre: Vec::new(),
            environment: home.join(".config/reverie/worker-broker.env"),
        }
    }
}
fn commands(raw: &str, key: &str) -> Vec<Vec<String>> {
    raw.lines()
        .filter_map(|line| line.strip_prefix(key))
        .map(|value| value.split_ascii_whitespace().map(str::to_owned).collect())
        .collect()
}
