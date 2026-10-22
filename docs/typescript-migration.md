# Deferred TypeScript migration

The current stage makes installation reproducible with Nix and establishes shared
agent types and explicit permissions in the TypeScript console. All experts use
the same agent model and memory machinery. CTO and COO are organizational roles;
authorization is never inferred from role labels. Employee recovery requires the
explicit console employee permission `permissions.recoverEmployees`.

The user has deferred further migration work. A future stage may port memory
storage to TypeScript with parity tests against the
existing Python behavior. Import must consume an exported backup, preserve durable
identity and memory, and validate counts and behavior before cutover. The Python
orchestration bridge moves after its TypeScript replacement passes parity tests.
Python remains appropriate long term for machine learning and numerical work.

Existing Python memory and orchestration remain in service during this staged
migration. Do not restore personal data until the user finishes hiring tests and
authorizes restoration. Installation and generic-agent acceptance use fresh data.
