{ pkgs, src }:
pkgs.writeText "reverie-model-relay.mjs" (builtins.readFile (src + "/apps/host/model-relay.mjs"))
