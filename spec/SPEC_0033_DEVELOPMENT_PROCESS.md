# SPEC_0033: Portable Development Workflows

## Status

ACCEPTED

## Summary

Use cargo xtask as a portable command runner, preserving production boundaries.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Expose shared development commands through cargo xtask | .cargo/config.toml | One entry point |
| Invoke programs directly with argument vectors | xtask | Cross-platform execution |
| Propagate failures and stop dependent commands | xtask | No false success |
| Keep product policy and privileged effects out of xtask | Task runner | No alternate control plane |
| Keep enforcement in owning tools/tests; xtask invokes them | Policy tests | Thin orchestration |
| Run the same commands locally and in CI | Workflows | Reproducible gates |
| Do not hide Bash/Python command strings inside Rust | Command construction | No hidden scripts |
| Explain platform-specific host requirements | Native components | Explicit portability |
| Keep generated outputs in task-specific temporary storage | Cargo/build configuration | Clean inputs |
| Use isolated worktrees and exact source acceptance | Contributors | Protect running work |
| Preserve instance data during migration | Migration owner | Correctness before deletion |

Adapted from Rumoca’s crates/xtask layout and SPEC_0033. The task runner must
compile without depending on Linux host services. Unsupported native checks must
be reported explicitly rather than masquerading as passed.
Public owner operations belong to the API in SPEC_0001.
