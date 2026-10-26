# Hands public reads and managed context

Managed Hands runtimes keep `search` and `web_fetch` **off by default**. The
owner may set these fields in the employee's private `runtime-settings.json`;
the normal next runtime launch validates and retains them. Changing that file
does not silently change a running process, its model, phone or permissions.

`search: true` requires an explicit `search_url` for the existing SearXNG JSON
API. No provider, API key or service is selected or installed automatically.
The endpoint must have an HTTP(S) URL without embedded credentials, query or
fragment. A configured internal endpoint is an owner choice; this setting is
separate from the public-only fetch policy.

`web_fetch: true` offers the read-only `web_fetch({url})` chat tool. It does not
require a workspace coding task or enable command execution. It accepts public
HTTPS on port 443, rejects every private/reserved/transition address in the DNS
answer, pins the selected address, and verifies TLS against the original
hostname. Redirects, cookies, automatic credentials and environment proxies are
not used. A fixed isolated DNS child and the overall eight-second deadline
bound resolution and transport. Responses are limited to 256 KiB of uncompressed
text/HTML/XML prefix and 4,000 extracted text characters. Larger pages explicitly
report partial content and unknown omitted material. Scripts and styles are dropped;
results are marked untrusted data. There is no browser JavaScript execution.

Search and fetch share `search_max_calls` (default two, maximum four) and the
existing prompt/result budgets. Managed launches place the private web-query
log beside the harness state; the owner can select another private absolute
`web_log`. Failed reads do not invent current facts or trigger a provider change.

Managed launches also obtain `reverie agent context --json` for every assembled
chat model request and every coding worker start, including starts after chat
preemption. The server owns the employee/session binding, current company/core
and profile sections. The runtime adds no default belief or persona. A failed
read inserts an explicit unknown-context notice; optional context cannot
displace the current request or exceed the existing prompt limit. Coding
authorization is checked again after context and receipt I/O, before starting
the model worker.

Only an exact, complete included snapshot can be reported using the server's
issued digest and `context receipt`. A truncated or unavailable snapshot cannot
be reported as complete. If the first request lacks context, a later successful
read is not labeled the original startup input. Server captures are explicitly
**harness-reported input**, not proof that a model read or believed the text.
The initial receipt store lasts for the website process lifetime; a website
restart does not preserve an earlier capture.

The private `managed-context.json` beside `state.json` contains only section
identifiers, status, sizes and hashes plus the current binding. It contains no
context text, prompt history, token or environment values. It records prepared
input; tokenizer refusal, cancellation or transport failure can still prevent a
model request from completing. No arbitrary laptop-file read endpoint is added.
