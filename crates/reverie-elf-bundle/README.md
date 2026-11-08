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
