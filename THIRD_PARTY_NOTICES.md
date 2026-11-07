# Upstream credit

The optional Rust front uses Tokio 1.54.1 (MIT) and command-fds 0.3.3
(Apache-2.0, copyright 2021 The Android Open Source Project). Their upstream
sources are https://github.com/tokio-rs/tokio and
https://github.com/google/command-fds/. Cargo.lock pins the source checksums.
The front uses command-fds' single owned fd mapping to fd 3; its reviewed
pre-exec syscall boundary stays in that dependency. The front's packaging gate
must retain the upstream licenses and any notices alongside the executable.

The release tooling's name gate (`crates/reverie-namegate`, run through `cargo xtask`)
uses unicode-normalization 0.1.26 and unicode-properties 0.1.5 (MIT OR Apache-2.0;
their Unicode data tables are under Unicode-3.0) and tinyvec 1.13.3 (Zlib OR
Apache-2.0 OR MIT). It is a development tool and is not part of the runtime package.
Cargo.lock pins the source checksums.

Chat code highlighting includes highlight.js 11.12.0 (BSD-3-Clause), copyright
2006 Ivan Sagalaev. Its license is retained at
`apps/web/src/web/public/vendor/highlight-LICENSE.txt`; pinned inputs and hashes
are in `vendor/chat-highlighting.json`. The Modelica grammar is project source.

The optional chat math plugin includes KaTeX 0.19.0 (MIT), with its license at
`apps/web/src/web/public/vendor/katex-0.19.0/LICENSE`. Its local JavaScript,
WOFF2 fonts and CSS come from the reviewed Reverie chat rendering packet;
`vendor/chat-math.json` records the upstream package integrity and asset hashes.
KaTeX renders math in the browser. It does not run a TeX compiler.

Reverie is a fork of Codeman by Ark0N and the Codeman contributors:
https://github.com/Ark0N/Codeman

The locally modified session manager is maintained in `apps/web` and built
from this repository. The container does not install the upstream npm package.
Its original license is retained in `apps/web/LICENSE`; source provenance is
recorded in `apps/web/UPSTREAM.md`. The following MIT notice is reproduced
for credit.

MIT License

Copyright (c) 2024-2026 Codeman Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The optional `codexObserver` Nix candidate fetches OpenAI Codex 0.163.0 at
commit `83086188ae0614bd882818ff1aa23f3194962012` from
https://github.com/openai/codex under Apache-2.0. The exact observer patch,
source checksum and locked dependency provenance are retained under
`nix/codex-observer/`; its package retains the upstream LICENSE and any NOTICE.
This optional candidate is separate from the default provider CLI installer.

## Rust front TLS dependencies

The Rust TLS adapter uses rustls (Apache-2.0 OR ISC OR MIT), tokio-rustls
(MIT OR Apache-2.0), rustls-pki-types (MIT OR Apache-2.0), rustls-webpki
(ISC), and ring (ISC with its upstream third-party notices). Their sources and
license texts are retained through Cargo/Nix source dependencies. ring's
code sourced from BoringSSL uses Apache-2.0 or ISC as stated in each file;
its once_cell-derived code uses Apache-2.0/MIT notices. See ring's LICENSE,
LICENSE-BoringSSL, LICENSE-other-bits and src/polyfill/once_cell license files;
these upstream notices remain applicable. The front
selects ring explicitly and does not include a second TLS implementation.
