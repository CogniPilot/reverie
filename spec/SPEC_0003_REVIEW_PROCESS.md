# SPEC_0003: Evidence and Adversarial Review

## Status

ACCEPTED

## Summary

Accept exact artifacts using relevant tests and independent adversarial evidence.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Identify failing behavior and earliest responsible owner | Change description | Fix causes |
| Run focused checks before broad checks | Contributor | Relevant evidence |
| Review authority, persistence and host effects independently | Reviewer | Challenge shared assumptions |
| Test lost replies, partial effects, crashes and revocation | Owning component | Failure paths matter |
| Record findings, reproducers and closing evidence | Review record | Auditable acceptance |
| Compare baseline and candidate in the same environment | Triage | Classify inherited failures |
| Preserve failing tests and production guards | All changes | Honest gates |
| Name checks not run and their consequences | Handoff | Visible limits |
| Bind acceptance to revision and artifact identity | Integrator | Exact evidence |
| Rebuild and recheck affected evidence after later fixes | Integrator | No stale approval |
| Require supported installation and isolated native canary | Release owner | Source is not deployment |
| Keep private receipts outside shareable source | Contributor | Protect instance data |

Adapted from Rumoca SPEC_0025 and SPEC_0033. A deadline is not a waiver.
A reviewer must not approve their own change to the challenged boundary.
Retained uncertain effects stay uncertain until their owning operation contract
establishes an outcome.
