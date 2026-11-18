use super::{Call, Outcome, Tool, ToolReply, prefix};
use serde::Serialize;
use serde_json::{Map, Number, Value};

#[derive(Default, Serialize)]
pub(in crate::coding_task) struct Report {
    status: &'static str,
    reason: &'static str,
    text: String,
    pub(super) steps: usize,
    pub(super) output_bytes: usize,
    pub(super) largest_prompt: usize,
    pub(super) omitted_rounds: usize,
    edited_paths: Vec<String>,
    tests_run: usize,
    test_exit_code: Option<Number>,
    tests_current: bool,
    peak_prompt_tokens: u64,
    context_tokens: u64,
    model_prompt_tokens: u64,
    model_output_tokens: u64,
    pub(super) context_overflows: usize,
    model_responses: usize,
    usage_measured_responses: usize,
    pub(super) call_retries: usize,
}

impl Report {
    pub(super) fn complete(mut self, text: String) -> Self {
        self.status = "completed";
        self.reason = "model_finished";
        self.text = text;
        self
    }

    pub(super) fn stop(mut self, reason: &'static str) -> Self {
        self.status = "stopped";
        self.reason = reason;
        self
    }

    pub(super) fn measure(&mut self, response: &Map<String, Value>) -> Outcome<()> {
        if let Some(stats) = response.get("_context_stats").and_then(Value::as_object) {
            let prompt = stats
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .ok_or("invalid_context_measurement")?;
            let context = stats
                .get("context_tokens")
                .and_then(Value::as_u64)
                .ok_or("invalid_context_measurement")?;
            self.peak_prompt_tokens = self.peak_prompt_tokens.max(prompt);
            self.context_tokens = context;
        }
        Ok(())
    }

    pub(super) fn usage(&mut self, response: &Map<String, Value>) {
        self.model_responses += 1;
        if let Some(usage) = response.get("_usage").and_then(Value::as_object) {
            self.usage_measured_responses += 1;
            for (name, total) in [
                ("prompt_tokens", &mut self.model_prompt_tokens),
                ("completion_tokens", &mut self.model_output_tokens),
            ] {
                *total = total
                    .saturating_add(usage.get(name).and_then(Value::as_u64).unwrap_or_default());
            }
        }
    }

    pub(super) fn tool(&mut self, call: &Call, reply: &ToolReply) {
        if call.tool == Tool::RunTests {
            self.tests_run += 1;
            self.test_exit_code = reply.exit_code.clone();
            self.tests_current = reply.ok && reply.exit_code.is_some();
        }
        if matches!(
            call.tool,
            Tool::EditFile | Tool::WriteFile | Tool::RunCommand
        ) {
            self.tests_current = false;
        }
        if matches!(call.tool, Tool::EditFile | Tool::WriteFile)
            && reply.ok
            && let Some(path) = call.args.get("path").and_then(Value::as_str)
            && !self.edited_paths.iter().any(|known| known == path)
        {
            self.edited_paths.push(prefix(path, 200));
        }
    }
}
