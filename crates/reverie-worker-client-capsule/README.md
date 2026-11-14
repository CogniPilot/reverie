# Worker client capsule

This Linux build-time producer assembles unselected image data under
/opt/reverie-worker-client. It grants no caller identity, permission, host
installation consent or provider readiness. Its static entry clears the
environment before dynamic Node can load; only explicit worker API context is
preserved. The bundled JavaScript has only Node builtin imports and no native
addons. The maintained ELF assembler closes and relocates Node libraries.

The canonical manifest lists every regular read-only file and excludes its own
hash. The owning image configuration pins the hash of its exact bytes. A status
reply alone never supplies native authority: the actual selected container,
image, code, current employee and original effect owner remain independent.

The factory consumes new source plus explicitly supplied immutable Console
dependency modules. Used packages must match the source lock metadata.
No private Nix store, HOME, provider history or existing configuration is rewritten.
