# PDF preview dependency

Mozilla PDF.js 6.4.299, from the official distribution:
https://github.com/mozilla/pdf.js/releases/tag/v6.4.299

Archive SHA256: `f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d`.
`PINS.json` records the exact original archive members, sizes and hashes.

The core module and matching module worker are unmodified. The selected subset
contains CMaps, standard fonts, image/color codecs and their license notices.
The full web viewer, scripting/sandbox bundle, unreferenced QuickJS payloads,
examples and source maps are omitted. `LICENSE` contains the Apache 2.0 terms;
additional font/codec licenses are retained beside those files.

The application supplies already-authorized complete PDF bytes and renders one
page at a time as canvas and inert text. It does not create scripting managers,
XFA/forms, annotations, action/link handlers or document attachment controls.
