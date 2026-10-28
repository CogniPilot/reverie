# Own publication credential availability

Run `reverie agent credentials status --json` for a read-only report bound to
your current employee and session. The same command is listed by
`reverie agent capabilities`. It never installs a credential, reads local token
files, retrieves credential material, or probes GitHub.

The report separates three facts:

- `registration: registered` and `grant: current` mean this employee currently
  has a grant for a name present in the supported owner registry.
- `registration: missing` and `grant: unavailable` mean an ID in the current
  grant set has no visible registration. No foreign names are disclosed.
- `repositoryAccess: not-verified` means repository labels are owner-declared.
  Neither registration nor a grant proves that a PAT authenticates or can access
  those repositories. This store does not record PAT/grant expiry, so
  `expiry: unknown, reason: not-recorded` is explicit. Old creation timestamps
  do not establish either expiry or continued validity.

An empty own grant set does not mean the owner registry is empty, and does not
mean credentials are absent from other locations. A forbidden, unsupported or
unavailable endpoint produces typed unavailability instead of an empty success.
No alternate identity or registry/file search is attempted. Owner-only
registration and existing private installation permissions stay unchanged.

The new `GET /api/publication/credentials/status` endpoint accepts no selectors
or query parameters. It uses the same current employee/session/generation and
tenant checks as the existing grant list, rechecking after the metadata read.
Only bounded names, repository labels and fixed status fields are returned;
free-form labels, private paths, material and provider error bodies are omitted.
Capability output also omits local locator paths and free-form credential labels.
The internal locator and existing list/install commands remain available for
their existing purpose; this change adds no registration or material authority.

This is metadata availability, not publication or installed runtime acceptance.
