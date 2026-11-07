# Candidate composition only. `console` must be a separately qualified exact
# input; this factory neither selects an image nor manufactures a context/grant.
{ pkgs, src, console }:
let
  producer = import ./memory-capsule-producer.nix { inherit pkgs src; };
  modules = import ./memory-capsule-modules.nix { inherit pkgs src console; };
  native = import ./memory-guest-native.nix { inherit pkgs src; };
  notices = import ./memory-capsule-notices.nix { inherit pkgs native; };
  node = pkgs.nodejs-slim_22;
  closure = pkgs.closureInfo { rootPaths = [ console node ]; };
in pkgs.runCommand "reverie-memory-guest-capsule" {
  nativeBuildInputs = [ producer ];
  preferLocalBuild = true;
} ''
  reverie-memory-capsule \
    --console ${console}/lib/reverie --node ${node}/bin/node \
    --memory ${native}/bin/reverie-memory --mcp ${native}/bin/reverie-mcp \
    --closure ${closure}/store-paths --modules ${modules} --notices ${notices} \
    --patchelf ${pkgs.patchelf}/bin/patchelf --readelf ${pkgs.binutils}/bin/readelf \
    --output "$out"
''
