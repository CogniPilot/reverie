# Reverie specification index

This adopts Rumoca’s numbered-spec layout, short rule tables and explicit status.
Applicable policies were adapted from CogniPilot/rumoca at
`0bab7e08c42dced38488abd298a4b9bb77d2b0cc`; compiler-specific rules are omitted.
Reverie spec numbers are local to this repository.

| Spec | Topic | Status |
| --- | --- | --- |
| [SPEC_0000](SPEC_0000_SPEC_GUIDELINES.md) | Specification guidelines | ACCEPTED |
| [SPEC_0001](SPEC_0001_OWNER_OPERATIONS.md) | Owner API and runtime architecture | DRAFT |
| [SPEC_0021](SPEC_0021_CODE_COMPLEXITY.md) | Maintainability and determinism | ACCEPTED |
| [SPEC_0025](SPEC_0025_REVIEW_PROCESS.md) | Evidence and adversarial review | ACCEPTED |
| [SPEC_0029](SPEC_0029_CRATE_BOUNDARIES.md) | Crate boundaries and single ownership | ACCEPTED |
| [SPEC_0033](SPEC_0033_DEVELOPMENT_PROCESS.md) | Portable development workflows | ACCEPTED |
| [SPEC_0036](SPEC_0036_VALID_BY_CONSTRUCTION.md) | Valid-by-construction contracts | DRAFT |

ACCEPTED means a contributor requirement. DRAFT identifies an intended design
with implementation gaps. Neither status is evidence of an installed release.
The [Rust migration inventory](../docs/rust-overhaul.md) tracks replacement work.
Specifications own rules; other documents link to them.
