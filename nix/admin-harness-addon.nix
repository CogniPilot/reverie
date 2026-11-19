{ pkgs, hands, handsTools }:
(pkgs.buildEnv {
  name = "reverie-admin-harness-addon";
  paths = [ hands handsTools ];
  pathsToLink = [ "/bin" "/share/doc" ];
  meta.mainProgram = "reverie-hands";
}).overrideAttrs (_: {
  disallowedRequisites = [ pkgs.python3 ];
})
