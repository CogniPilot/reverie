# Project one complete workspace-crate closure and its locked dependencies.
# Callers list required crate directories; Cargo still validates that closure.
{ pkgs, src, members, vendors ? [] }:
let
  lib = pkgs.lib;
  original = src.origSrc or src;
  keep = import ./source-filter-policy.nix { inherit lib; };
  manifest = builtins.fromTOML (builtins.readFile (original + "/Cargo.toml"));
  lock = builtins.fromTOML (builtins.readFile (original + "/Cargo.lock"));
  crates = map (name: let crateRoot = original + "/crates/${name}"; in {
    inherit name;
    path = builtins.path {
      path = crateRoot;
      inherit name;
      filter = path: type: keep
        ("crates/${name}" + lib.removePrefix (toString crateRoot) (toString path)) type;
    };
    manifest = builtins.fromTOML (builtins.readFile (original + "/crates/${name}/Cargo.toml"));
  }) members;
  vendorPaths = map (name: let crateRoot = original + "/vendor/${name}"; in {
    inherit name;
    path = builtins.path {
      path = crateRoot;
      inherit name;
      # Vendored Rust crates use the same Rust target/cache filter.
      filter = path: type: keep
        ("crates/${name}" + lib.removePrefix (toString crateRoot) (toString path)) type;
    };
  }) vendors;
  sections = value: [
    (value.dependencies or {})
    (value.dev-dependencies or {})
    (value.build-dependencies or {})
  ];
  tables = lib.concatMap (crate:
    sections crate.manifest
    ++ lib.concatMap sections (builtins.attrValues (crate.manifest.target or {}))
  ) crates;
  inheritedNames = lib.unique (lib.concatMap (table:
    builtins.attrNames (lib.filterAttrs (_: value:
      builtins.isAttrs value && (value.workspace or false)
    ) table)
  ) tables);
  dependency = text:
    let
      parts = lib.splitString " " text;
      matching = builtins.filter (package:
        package.name == builtins.head parts
        && (builtins.length parts == 1 || package.version == builtins.elemAt parts 1)
        && (builtins.length parts < 3
          || "(${package.source or ""})" == builtins.elemAt parts 2)
      ) lock.package;
    in assert builtins.length matching == 1; builtins.head matching;
  entry = package: {
    key = "${package.name} ${package.version} ${package.source or ""}";
    inherit package;
  };
  closure = builtins.genericClosure {
    startSet = map (name: entry (dependency name)) members;
    operator = item: map (name: entry (dependency name)) (item.package.dependencies or []);
  };
  lockFile = (pkgs.formats.toml {}).generate "rust-workspace-Cargo.lock" {
    inherit (lock) version;
    package = map (item: item.package) (lib.sort (a: b: a.key < b.key) closure);
  };
  cargoManifest = (pkgs.formats.toml {}).generate "rust-workspace-Cargo.toml" {
    workspace = {
      members = map (name: "crates/${name}") members;
      inherit (manifest.workspace) resolver package lints;
      dependencies = lib.filterAttrs (name: _: builtins.elem name inheritedNames)
        manifest.workspace.dependencies;
    } // lib.optionalAttrs (vendors != []) { exclude = map (name: "vendor/${name}") vendors; };
    inherit (manifest) profile;
  };
in
assert members != [] && builtins.length (lib.unique members) == builtins.length members;
assert builtins.length (lib.unique vendors) == builtins.length vendors;
assert lib.all (name: builtins.match "[a-zA-Z0-9_-]+" name != null) vendors;
assert lib.all (crate: crate.manifest.package.name == crate.name) crates;
assert lib.all (name: builtins.hasAttr name manifest.workspace.dependencies) inheritedNames;
{
  inherit lockFile;
  source = pkgs.runCommand "reverie-rust-workspace-source" {} (''
    mkdir -p "$out/crates"
    cp ${cargoManifest} "$out/Cargo.toml"
    cp ${lockFile} "$out/Cargo.lock"
    ${lib.concatMapStringsSep "\n" (crate: ''cp -r ${crate.path} "$out/crates/${crate.name}"'') crates}
  '' + lib.optionalString (vendors != []) ''
      mkdir -p "$out/vendor"
      ${lib.concatMapStringsSep "\n" (vendor: ''cp -r ${vendor.path} "$out/vendor/${vendor.name}"'') vendorPaths}
  '');
}
