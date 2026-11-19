{ pkgs, containerRuntime }:
# Preserve the single executable output used by the normal launcher and the
# versioned website startup manifest.
pkgs.runCommand "reverie-start" {
  disallowedRequisites = [ pkgs.python3 ];
} ''
  cp ${containerRuntime}/bin/reverie-container-start "$out"
''
