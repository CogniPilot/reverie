{ lib, src }:
let
  root = toString src;
  keep = import ./source-filter-policy.nix { inherit lib; };
in lib.cleanSourceWith {
  inherit src;
  # Stable name avoids a new output path when only the input checkout name changes.
  name = "reverie-source";
  filter = path: type: keep
    (if toString path == root then "" else lib.removePrefix "${root}/" (toString path)) type;
}
