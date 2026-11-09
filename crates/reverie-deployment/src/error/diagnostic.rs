use super::*;
use serde_json::{Value, json};
pub(super) const MAX_NODES: usize = 64;
pub(super) const MAX_DEPTH: usize = 16;

struct Budget {
    remaining: usize,
    truncated: bool,
}
impl Budget {
    fn enter(&mut self, depth: usize) -> bool {
        if self.remaining == 0 || depth >= MAX_DEPTH {
            self.truncated = true;
            false
        } else {
            self.remaining -= 1;
            true
        }
    }
}
pub(super) fn project(error: &DeploymentError) -> Value {
    let mut budget = Budget {
        remaining: MAX_NODES,
        truncated: false,
    };
    let error = deployment(error, 0, &mut budget);
    json!({"version":1,"error":error,"truncated":budget.truncated})
}
fn deployment(error: &DeploymentError, depth: usize, budget: &mut Budget) -> Option<Value> {
    if !budget.enter(depth) {
        return None;
    }
    let snapshot = error
        .snapshot_error()
        .and_then(|cause| snapshot(cause, depth + 1, budget));
    let mut finalization = Vec::new();
    for error in error.finalization_errors() {
        let Some(node) = deployment(error, depth + 1, budget) else {
            break;
        };
        finalization.push(node);
    }
    Some(json!({"code":error.code(),"snapshot":snapshot,"finalization":finalization}))
}
fn snapshot(error: &SnapshotError, depth: usize, budget: &mut Budget) -> Option<Value> {
    if !budget.enter(depth) {
        return None;
    }
    let mut secondary = Vec::new();
    for error in error.secondary() {
        let Some(node) = snapshot(error, depth + 1, budget) else {
            break;
        };
        secondary.push(node);
    }
    // These closed getters contain static codes only. Never traverse arbitrary
    // Error::source, Display or Debug into private paths, contents or messages.
    Some(json!({"code":error.code(),"secondary":secondary}))
}
