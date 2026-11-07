//! Fixed first/attach pane read on the original sealed observation and name.
use super::*;
use reverie_core::worker_launch::ContainerReference;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExistingPaneState {
    Live,
    Dead,
    Unavailable,
}
impl ExistingLaptopInspection {
    pub fn observe_pane(
        &self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> std::result::Result<ExistingPaneState, ExistingObservationError> {
        self.assert_plan(runtime, plan)?;
        let words = ["display-message", "-p", "-t", "office", "#{pane_dead}"]
            .map(MetadataText::from_scalar_text);
        let args = worker_launch::tmux_exec_args(
            &ContainerReference::Worker(plan.arguments.worker_name()),
            &words,
            false,
        );
        let args = args
            .iter()
            .map(|word| native::python_path(word.codepoints()).map(|path| path.into_os_string()))
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|_| ExistingObservationError::Origin)?;
        let output = runtime
            .installed_engine()
            .engine
            .client
            .run(
                args,
                end,
                &runtime.cancellation(),
                Policy {
                    maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                    maximum_output: MAX_OUTPUT_BYTES,
                    successful_exit: false,
                },
            )
            .map_err(|error| ExistingObservationError::Engine(error.into()))?;
        if output.succeeded {
            let text = std::str::from_utf8(&output.stdout).expect("captured UTF8 policy");
            match reverie_contracts::kernel_accounting::strip(text) {
                "0" => return Ok(ExistingPaneState::Live),
                "1" => return Ok(ExistingPaneState::Dead),
                _ => {}
            }
        }
        Ok(ExistingPaneState::Unavailable)
    }
}
