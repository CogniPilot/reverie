# Facts only: exact immutable Node and complete console package graph, no owner grant.
{ pkgs, src, console, ownerTerminalProgram ? null,
  artifacts ? import ./policy-artifacts.nix { inherit pkgs src; } }:
pkgs.runCommand "reverie-worker-resume-program" {} ''
  ${artifacts}/bin/reverie-policy-artifacts worker-resume-program \
    --console ${console} --node ${pkgs.nodejs_22}/bin/node${pkgs.lib.optionalString (ownerTerminalProgram != null) " --owner-terminal-program ${pkgs.lib.escapeShellArg ownerTerminalProgram}"} \
    --output "$out/share/reverie/worker-resume-program.json"
''
