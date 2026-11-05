# SPEC_0002: Maintainability and Determinism

## Status

ACCEPTED

## Summary

Enforce Rumoca-derived complexity limits and single ownership of policy.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Deny configured workspace Clippy violations | Root Cargo.toml | Machine-enforced discipline |
| Limit functions to 100 lines, seven arguments, nesting four | clippy.toml | Bounded review units |
| Keep type complexity threshold at 250 | clippy.toml | Adopted Rumoca policy |
| Inherit workspace lints in every crate | Crate manifests | No accidental escape |
| Fail production Rust files above 2,000 lines | Rust policy tests | Split by responsibility |
| Exclude generated and test sources from production-file limits | Policy tests | Different review purpose |
| Do not bypass limits with comment markers | Policy tests | No textual waiver |
| Refactor instead of adding blanket complexity allowances | Implementations | Effective guards |
| Confine justified unsafe code to reviewed native boundaries | Syscall modules | Small trust boundary |
| Serialize public maps and diagnostics deterministically | Owning types | Reproducible artifacts |
| Share each algorithm and policy through its owner | All crates | DRY |
| Use content-based modules and normal module paths | src/ | Stable navigation |

Thresholds and test/generated exclusions follow Rumoca SPEC_0021. Reverie omits
Rumoca’s three-phrase file-size waiver: exceptions need a policy change and
review. Policy tests enforce file size; Clippy enforces function limits.
A successful build alone proves neither gate ran.
