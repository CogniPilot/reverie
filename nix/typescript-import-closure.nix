# The files one TypeScript entry can reach through relative imports, as paths
# relative to `root`. Read at evaluation time, so a derivation can take exactly
# these files as its source and an edit elsewhere leaves it unchanged.
#
# This is a superset of what a bundler reads, never a subset by design:
# statements that import or export only types are skipped, every other relative
# `from`, `import` or `import()` specifier is followed. A specifier this scan
# misses is absent from the source, and the bundler then refuses the build.
{ lib, root, entry }:
let
  # Ends at its own specifier and crosses neither a quote nor a semicolon on the
  # way, so it cannot swallow a later statement's specifier.
  typeOnly = "(import|export)[[:space:]]+type[[:space:]][^'\";]*from[[:space:]]*['\"][^'\"]*['\"]";
  relative = "(from|import)[[:space:]]*[(]?[[:space:]]*['\"]([.][.]?/[^'\"]+)['\"]";
  matches = pattern: text: builtins.filter builtins.isList (builtins.split pattern text);
  specifiers = text:
    let runtime = lib.concatStrings (builtins.filter builtins.isString (builtins.split typeOnly text));
    in map (found: builtins.elemAt found 1) (matches relative runtime);
  normalize = path: lib.concatStringsSep "/" (lib.foldl' (kept: part:
    if part == "." || part == "" then kept
    else if part == ".." then assert kept != []; lib.init kept
    else kept ++ [ part ]) [] (lib.splitString "/" path));
  isFile = path: builtins.pathExists (root + "/${path}") && builtins.readFileType (root + "/${path}") == "regular";
  resolve = from: specifier:
    let
      target = normalize "${builtins.dirOf from}/${specifier}";
      stem = lib.removeSuffix ".js" target;
      found = builtins.filter isFile [ "${stem}.ts" "${stem}.tsx" "${target}/index.ts" target ];
    in if found == [] then null else builtins.head found;
  imports = file: builtins.filter (path: path != null)
    (map (resolve file) (specifiers (builtins.readFile (root + "/${file}"))));
in map (item: item.key) (builtins.genericClosure {
  startSet = [ { key = normalize entry; } ];
  operator = item: map (key: { inherit key; }) (imports item.key);
})
