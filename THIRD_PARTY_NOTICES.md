# Upstream credit

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

The native CDI compatibility constructor/resolver follows PyYAML 6.0.3 (MIT),
copyright 2017-2021 Ingy döt Net and 2006-2016 Kirill Simonov. The upstream notice
is retained at `crates/reverie-contracts/src/gpu_access/cdi/PYYAML_LICENSE.txt`.
The underlying safe Rust grammar parser is the pinned `libyaml-safer` dependency;
no Python interpreter is used by the native CDI reader.

The native memory output-policy compiler uses the standalone RustPython SRE
matcher and lossless WTF8 utility pinned to
`d02d81e740e67496a70579282c848358e461d0d0` (MIT). Exact source changes, licensing,
dependency scope and the non-default Unicode trim feature are recorded in
[vendor/README.md](vendor/README.md). No RustPython interpreter or Python
parser/compiler is included. The native compiler follows CPython 3.13.15 grammar
and emission rules; its PSF/CNRI licenses and original SRE notices are retained
in `crates/reverie-python-regex/`. Core's additional frozen text facts use the
same CPython/Unicode provenance as its existing text facts. Maintained
`unicode_names2` 1.2.2 supplies Unicode 15.1 names/aliases (MIT/Apache-2.0), with
the exact CPython algorithmic-name lexical check in Core. Its source-data-driven
Rust code generator is build-time tooling, distinct from runtime name lookup.
