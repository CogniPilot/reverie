# Local embassy QR assets

These files run entirely in the browser; there is no CDN, QR-generation endpoint,
image upload or analytics. The console lazy-loads these same-origin static files.

- embassy-qr-code.min.js: qrcode 1.5.4, MIT, from the existing installed pinned
  package (https://github.com/soldair/node-qrcode). Browser entry bundled with
  esbuild --bundle --platform=browser --minify --format=iife
  --global-name=ReverieQRCode. See qrcode.LICENSE.txt and dijkstrajs.LICENSE.txt.
- embassy-qr-scan.min.js: jsqr 1.4.0, Apache-2.0,
  https://registry.npmjs.org/jsqr/-/jsqr-1.4.0.tgz. Npm integrity was verified
  before extracting package/dist/jsQR.js, then minified with esbuild. See
  jsqr.LICENSE.txt. Upstream: https://github.com/cozmo/jsQR.

The sharing URL stores the complete host/key envelope after #. An in-app scan
decodes text only; it never navigates to the QR target or joins automatically.
Opening a sharing URL scrubs its current history entry and stages an invite
only for a signed-in console owner. The existing explicit host-confirmation
flow still sends the key to the owner's own guest-client API for joining.
Do not confuse this browser-local handling with never transmitting a key during
an explicitly confirmed guest join.
