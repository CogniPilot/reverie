# SPEC_0000: Specification Guidelines

## Status

ACCEPTED

## Summary

Keep specifications small, explicit, traceable and useful to humans and agents.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Use numbered SPEC_NNNN_TOPIC.md files and an index | spec/ | Stable references |
| Allocate the next sequential number in adoption order | New specs | Predictable navigation |
| Keep adopted identifiers stable; retain a reference stub when retiring one | Spec index | Preserve links |
| Include Status, Summary and Specification in that order | Each spec | Fast reading |
| Use ACCEPTED, DRAFT or REFERENCE status | Each spec | Separate policy, plans and catalogs |
| Express multiple rules in short tables | Normative sections | Rules remain visible |
| Keep each rationale below 15 words | Rule tables | Easy scanning |
| Own each rule once; other documents link to its owner | Documentation | DRY |
| Show actual types when claiming an implemented interface | Examples | Prevent imaginary contracts |
| Mark unimplemented design and acceptance gaps | DRAFT specs | Honest status |
| Limit ACCEPTED plus DRAFT specs to 21 | Spec index | Bounded reading load |
| Limit non-REFERENCE specs to 350 lines and 2,500 words | Spec source | Bounded context |
| Put lookup catalogs in REFERENCE annexes | Large tables | Short normative rules |
| Record test or review evidence for enforced rules | Owning spec | Intent is not enforcement |

Adapted from Rumoca SPEC_0000 and its actual budget tests. Renaming a design to
REFERENCE must not hide normative policy. Exceptions require an explicit change
to the owning policy and independent review.
