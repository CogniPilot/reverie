# SPEC_0008: Rust and TypeScript Tooling

## Status

ACCEPTED

## Summary

First-party implementation and maintenance use Rust or TypeScript, with no new Python or shell scripts.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Prefer Rust core/services and TypeScript clients | First-party code | Portability and shared contracts |
| Add no Python or Bash/shell script files | All first-party paths | No platform-specific control plane |
| Cover executable extensions and extensionless interpreter shebangs | CI policy | Names cannot hide scripts |
| Reject conversion of existing non-script code into a forbidden script | CI policy | No disguised additions |
| Apply the same ratchet to staged, committed and untracked source | Local/CI | Consistent checks |
| Report existing tracked script inventory as migration debt | CI summary | Visible remaining work |
| Retire legacy scripts when real consumers have accepted replacements | Owning lane | Preserve capabilities |
| Include embedded/generated execution fragments in the migration inventory | Owning lane | Filename checks are insufficient |
| Add no shell-evaluation strings to replace removed maintenance scripts | New code | No hidden workaround |
| Let cargo xtask invoke programs with explicit arguments | Task runner | Cross-platform orchestration |
| Use Rust/TypeScript test helpers for new executable fixtures | Tests | Same discipline |
| Keep inert malicious-script test data distinguishable from executable helpers | Policy tests | Test the guard |
| Preserve explicitly scoped user-selected interactive shells | Terminal API | Existing office capability |

The current automated ratchet recognizes Python-family extensions/interpreters
and shell files including Bash, POSIX shell and PowerShell/batch variants. Legacy
repairs and deletion remain possible while the port proceeds. This is not a
claim that legacy scripts or embedded packaging fragments are already gone.
Nix build phases and third-party tooling are inventoried separately; no new
first-party maintenance workflow may hide in packaging glue.
