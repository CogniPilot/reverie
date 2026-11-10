# Reverie ELF bundle library

This build-only library closes Linux ELF dependencies from declared immutable
Nix inputs. Memory tools use its library selection, origin traversal, ELF
inspection, hashing and executable copying. The pending employee perf checker
will reuse these implementations.

Every original dependency origin is traversed, even when another origin has
equal bytes: `$ORIGIN` can select different children. Conflicting libraries
refuse the build. The ignored two-origin fixture is explicitly run by the Nix
producer with maintained `patchelf` and `readelf` inputs.

These APIs accept build input paths. They are not shipped runtime endpoints
and do not establish image identity, installation consent or a resource grant.

`build_idmap` assembles the fixed `newuidmap`/`newgidmap` image prefix using
the same dependency traversal. It reads ELF metadata without executing either
helper, checks one loader and consistent ELF machine/class, and verifies every
relocated dependency against the selected library set. The Idmap layout uses
only `/opt/reverie-idmap/lib` as RPATH, preserves the old system-preload path
behavior, and redirects original Nix fallback strings to `/opt/idmap/`.
Outputs contain regular read-only files, with no symlinks, setid bits or
capability grant from this builder. The image factory owns its existing
capability metadata separately. Memory and Perf retain their existing layout
and `$ORIGIN` behavior.

`require_static_elf64` is a metadata-only worker toolkit check. It validates
little-endian ELF64 identity and target, all program segment bounds and every
dynamic table, rejects PT_INTERP/DT_NEEDED, and requires a load segment. It does
not execute the input, grant access or qualify a running process.
