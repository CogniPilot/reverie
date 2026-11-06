# SPEC_0006: Valid-by-Construction Runtime Contracts

## Status

DRAFT

## Summary

Make invalid domain values and unauthorized transitions unrepresentable.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Decode wire data into a distinct unchecked representation | API/IPC | Parsing is not approval |
| Construct domain values through checked constructors | Owning type | Validate once |
| Keep invariant-bearing fields private | Domain types | Prevent invalid mutation |
| Distinguish employee, session, operation and reservation identifiers | Core contracts | Prevent identity confusion |
| Use closed enums for states and operations | State machine | Exhaustive handling |
| Keep effect authority process-local and revocable | Authority owner | IDs are not grants |
| Bind previews to exact revision and current authority | Operation owner | Reject stale intent |
| Distinguish pre-effect refusal from post-effect uncertainty | Host result | Safe retry semantics |
| Consume or fence one-attempt execution authority | Operation owner | No replay |
| Persist transitions atomically through one store | Durable state | Single truth |
| Revalidate native facts immediately before effects | Host adapter | External state changes |
| Preserve canonical bytes, digests and schemas across ports | Contract/store owner | Cross-language integrity |
| Publish allowed client actions from server state | API service | Thin clients |

Adapted from Rumoca SPEC_0036 and construction/ownership catalogs. This stays
DRAFT until Rust domain, store and backend interfaces establish these properties.
Raw serde decoding, public fields plus a validator, and repeated boolean guards
do not prove valid-by-construction behavior. External files and processes still
require live identity checks at the effect boundary.
